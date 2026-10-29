"""Real ACP + shared Pi SDK + controlled HTTP, without provider credentials."""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar

from acp import RequestError
from connector.runtime_protocol.models import (
    RuntimeAttachment,
    RuntimeAttachmentContent,
)
from connector.runtimes.acp.application.agent_capabilities import AgentCapabilities
from connector.runtimes.acp.application.sessions import SessionService
from connector.runtimes.acp.domain.definitions import (
    AcpError,
    AgentProfile,
    LaunchDefinition,
)
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.infrastructure.persistence import Store
from connector.runtimes.acp.infrastructure.processes import AgentProcess
from connector.runtimes.acp.infrastructure.projection import Projection
from connector.runtimes.acp.profiles.pi.preparation import PiPreparation
from connector.runtimes.acp.profiles.pi.profile import PI_PROFILE
from connector.runtimes.acp.runtime import AcpRuntime


async def until(predicate):
    async with asyncio.timeout(40):
        while not predicate():
            await asyncio.sleep(0.02)


async def verify_connector(root, workspace, launch):
    store = Store(root / "connector.sqlite")
    app = SessionService(
        store,
        AgentProfile("pi", "Pi"),
        launch,
        AgentClient,
        Projection,
        root,
        preparation_driver=PiPreparation(),
    )
    try:
        Model.calls = 0
        Model.proof.unlink()
        app.prepare({"preparationId": "connector-prepare", "cwd": str(workspace)})
        await until(lambda: app.interactions.views("connector-prepare"))
        request = app.interactions.views("connector-prepare")[0]
        app.interactions.respond(
            "connector-prepare",
            {
                **{
                    key: request[key]
                    for key in ("interactionId", "ownerGeneration", "requestRevision")
                },
                "responseOperationId": "basic-answer",
                "actionId": "basic",
            },
        )
        await until(
            lambda: app.preparation_view("connector-prepare")["phase"] == "ready"
        )
        assert not list((root / "connector-agent").rglob("*.jsonl"))
        prepared = app.preparation_view("connector-prepare")
        selection = prepared["catalog"]["models"][0]["selectionId"]
        assert app.reserve(
            {
                "preparationId": "connector-prepare",
                "createOperationId": "connector-create",
                "platformSessionId": "platform-app",
                "selections": {"model": selection},
                "expectedRevision": prepared["revision"],
                "catalogRevision": prepared["catalogRevision"],
            }
        )["reserved"]
        app.begin(
            {
                "preparationId": "connector-prepare",
                "createOperationId": "connector-create",
                "sessionId": "platform-app",
                "selections": {"model": selection},
                "clientMessageId": "connector-first",
                "content": "write controlled proof",
            }
        )
        await until(
            lambda: app.creation_view("connector-create")["messageAccepted"] is True
        )
        assert not Model.proof.exists(), (
            "early acceptance incorrectly implied tool execution"
        )
        await until(
            lambda: any(
                i["status"] == "open"
                for i in app.interactions.views("connector-create")
            )
        )
        request = next(
            i
            for i in app.interactions.views("connector-create")
            if i["status"] == "open"
        )
        app.interactions.respond(
            "connector-create",
            {
                **{
                    key: request[key]
                    for key in ("interactionId", "ownerGeneration", "requestRevision")
                },
                "responseOperationId": "tool-answer",
                "actionId": "approve",
            },
        )
        await until(lambda: app.state("platform-app")["status"] == "idle")
        assert Model.proof.read_text() == "approved-own-acp"
        assert any(
            i["content"].get("text") == "AA_OWN_ACP_OK" and i["status"] == "done"
            for i in store.values("projection")
        )
        runtime = object.__new__(AcpRuntime)
        runtime.app = app
        runtime.profile = PI_PROFILE
        runtime.config = SimpleNamespace(runtime_id="controlled-acp")
        runtime.agent_capabilities = AgentCapabilities(app)
        attachment_body = b"AA_ACP_NATIVE_FILE_PROOF_7291"

        async def download(session_id, file_id):
            return RuntimeAttachmentContent(
                file_id=file_id,
                name="proof.txt",
                media_type="text/plain",
                content=attachment_body,
            )

        runtime.host = SimpleNamespace(attachment_download=download)
        capabilities = await runtime.get_session_capabilities("platform-app")
        assert {
            "session.commands",
            "runtime.attachment",
            "catalog.model",
            "catalog.permission",
        } <= {
            capability.capability_id
            for capability in capabilities.capabilities
            if capability.supported and capability.available
        }
        commands = await runtime.list_commands("platform-app")
        assert [command.id for command in commands] == ["compact"]
        Model.read_attachment = True
        result = await runtime.start_turn(
            "platform-app",
            app.sessions["platform-app"]["agentSessionId"],
            "Read the attached file",
            selections=app.state("platform-app")["selections"],
            attachments=(
                RuntimeAttachment(
                    file_id="file_probe",
                    name="proof.txt",
                    media_type="text/plain",
                    size=len(attachment_body),
                ),
            ),
            client_message_id="connector-file",
        )
        assert result.result["phase"] == "dispatching"
        await until(lambda: app.state("platform-app")["status"] == "idle")
        assert any(
            message.get("role") == "tool"
            and "AA_ACP_NATIVE_FILE_PROOF_7291" in str(message.get("content"))
            for message in Model.requests[-1]["messages"]
        ), "native read never delivered attachment bytes"
        before_bad = Model.calls
        try:
            await runtime.start_turn(
                "platform-app",
                app.sessions["platform-app"]["agentSessionId"],
                "bad attachment",
                attachments=(
                    RuntimeAttachment(
                        file_id="file_probe", media_type="text/plain", size=1
                    ),
                ),
                client_message_id="bad-file",
            )
            raise AssertionError("mismatched attachment was dispatched")
        except AcpError as error:
            assert getattr(error, "code", None) == "attachment_mismatch", error
        assert Model.calls == before_bad
        await app.close_session(
            "platform-app", store.require("binding", "platform-app")["owner_generation"]
        )
        print(
            "Connector → capability port → ACP → SDK: preparation, permission category, commands, verified file delivery with native tool read, mismatch rejection, early receipt, stable final projection and close passed"
        )
    finally:
        await app.stop()
        store.close()


class ControlledProcess(AgentProcess):
    async def _drain_stderr(self):
        while self.process and self.process.stderr:
            chunk = await self.process.stderr.read(8192)
            if not chunk:
                return
            # This probe runs only disposable fixtures, with no provider secrets.
            sys.stderr.write(chunk.decode(errors="replace"))


class Model(BaseHTTPRequestHandler):
    calls = 0
    requests: ClassVar[list] = []
    read_attachment = False
    proof: Path

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["content-length"])))
        assert request["model"] == "controlled"
        type(self).requests.append(request)
        type(self).calls += 1
        delta = {"content": "AA_OWN_ACP_OK"}
        reason = "stop"
        if type(self).calls == 1:
            delta = {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "controlled-write",
                        "type": "function",
                        "function": {
                            "name": "write",
                            "arguments": json.dumps(
                                {"path": str(self.proof), "content": "approved-own-acp"}
                            ),
                        },
                    }
                ]
            }
            reason = "tool_calls"
        if type(self).read_attachment:
            latest = next(
                message
                for message in reversed(request["messages"])
                if message["role"] == "user"
            )
            text = (
                latest["content"]
                if isinstance(latest["content"], str)
                else "".join(part.get("text", "") for part in latest["content"])
            )
            match = re.search(r' path=("[^"\n]+")\]', text)
            assert match, text
            delta = {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "read-native-attachment",
                        "type": "function",
                        "function": {
                            "name": "read",
                            "arguments": json.dumps(
                                {"path": json.loads(match.group(1))}
                            ),
                        },
                    }
                ]
            }
            reason = "tool_calls"
            type(self).read_attachment = False
        chunk = {
            "id": "controlled",
            "object": "chat.completion.chunk",
            "model": "controlled",
            "choices": [{"index": 0, "delta": delta, "finish_reason": reason}],
        }
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(
            ("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode()
        )

    def log_message(self, *args):
        pass


async def main():
    repository = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="aa-own-pi-acp-") as directory:
        root = Path(directory)
        workspace, agent, state = root / "workspace", root / "agent", root / "state"
        for path in (workspace / ".pi/extensions", agent, state):
            path.mkdir(parents=True)
        (workspace / ".pi/extensions/startup.ts").write_text(
            "export default function(pi) { pi.on('session_start', async (_,ctx) => { if (!await ctx.ui.confirm('ACP 初始化确认','继续？')) throw new Error('declined'); }); }\n"
        )
        (agent / "settings.json").write_text(
            json.dumps(
                {
                    "compaction": {
                        "enabled": False,
                        "keepRecentTokens": 16,
                        "reserveTokens": 128,
                    }
                }
            )
        )
        Model.calls = 0
        Model.proof = workspace / "proof.txt"
        server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        (agent / "models.json").write_text(
            json.dumps(
                {
                    "providers": {
                        "controlled": {
                            "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                            "api": "openai-completions",
                            "apiKey": "controlled",
                            "models": [
                                {
                                    "id": "controlled",
                                    "name": "controlled",
                                    "reasoning": False,
                                    "input": ["text", "image"],
                                    "contextWindow": 4096,
                                    "maxTokens": 128,
                                }
                            ],
                        }
                    }
                }
            )
        )
        updates, interactions = [], []

        async def update(session_id, value):
            updates.append(value)

        async def interaction(session_id, kind, request):
            interactions.append((kind, request))
            if kind == "form":
                return {"action": "accept", "content": {"value": True}}
            options = {o["optionId"] for o in request["options"]}
            if "once" in options:
                assert not list(state.rglob("*.jsonl"))
                assert Model.calls == 0
                return {"action": "accept", "optionId": "once"}
            assert not Model.proof.exists(), "tool ran before approval"
            return {"action": "accept", "optionId": "approve"}

        client = AgentClient(update, interaction)
        client.process = ControlledProcess()
        native_node = (
            await asyncio.to_thread(
                subprocess.check_output,
                [shutil.which("node"), "-p", "process.execPath"],
                text=True,
            )
        ).strip()
        launch = LaunchDefinition(
            native_node,
            (
                str(repository / "pi-acp-agent/lib/src/interfaces/stdio.js"),
                "--agent-dir",
                str(agent),
                "--state-dir",
                str(state),
                "--runtime-id",
                "controlled-acp",
                "--python",
                sys.executable,
            ),
            "controlled-shared-kernel",
        )
        try:
            initialized = await client.start(launch, str(root))
            assert (
                initialized["agentCapabilities"]["_meta"]["aa"]["protocolVersion"]
                == "1.1"
            )
            prepared = await client.extension(
                "aa/prepare_workspace",
                {"preparationId": "stable-preparation", "cwd": str(workspace)},
            )
            assert prepared["deferred"] is True and not list(state.rglob("*.jsonl"))
            options = prepared["configOptions"][0]
            selected = options["options"][0]["value"]
            session = await client.open_session(
                str(workspace),
                aa={
                    "preparationId": prepared["ticket"],
                    "platformSessionId": "platform-controlled",
                    "selectionId": selected,
                },
            )
            assert session["sessionId"] == prepared["sessionId"]
            result = await asyncio.wait_for(
                client.prompt(
                    session["sessionId"], "write controlled proof", "stable-message"
                ),
                40,
            )
            assert result["stopReason"] == "end_turn"
            assert Model.proof.read_text() == "approved-own-acp"
            assert any(
                u.get("content", {}).get("text") == "AA_OWN_ACP_OK" for u in updates
            )
            receipt = await client.extension(
                "aa/get_operation",
                {
                    "sessionId": session["sessionId"],
                    "clientMessageId": "stable-message",
                },
            )
            assert receipt["receipt"]["messageAccepted"] is True
            before = Model.calls
            await client.prompt(
                session["sessionId"], "write controlled proof", "stable-message"
            )
            assert Model.calls == before
            try:
                await client.prompt(
                    session["sessionId"], "different content", "stable-message"
                )
                raise AssertionError("accepted conflicting message")
            except RequestError as error:
                assert "conflict" in str(error).lower() or "身份" in str(error), type(
                    error
                )
            commands = await client.extension(
                "aa/list_commands", {"sessionId": session["sessionId"]}
            )
            assert [item["name"] for item in commands["commands"]] == ["compact"]
            try:
                await client.extension(
                    "aa/execute_command",
                    {
                        "sessionId": session["sessionId"],
                        "command": "compact",
                        "raw": "/bash whoami",
                    },
                )
                raise AssertionError("command name/raw mismatch accepted")
            except RequestError:
                pass
            # Actual ACP image → OpenMA converter → SDK → captured model request.
            image_data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
            await client.prompt(
                session["sessionId"],
                "inspect attached image",
                "image-message",
                blocks=[{"type": "image", "mimeType": "image/png", "data": image_data}],
            )
            assert any(
                part.get("type") == "image_url"
                and part["image_url"]["url"].endswith(image_data)
                for message in Model.requests[-1]["messages"]
                if isinstance(message.get("content"), list)
                for part in message["content"]
            )
            calls_with_image = Model.calls
            await client.prompt(
                session["sessionId"],
                "inspect attached image",
                "image-message",
                blocks=[{"type": "image", "mimeType": "image/png", "data": image_data}],
            )
            assert Model.calls == calls_with_image
            try:
                await client.prompt(
                    session["sessionId"],
                    "inspect attached image",
                    "image-message",
                    blocks=[
                        {"type": "image", "mimeType": "image/png", "data": "different"}
                    ],
                )
                raise AssertionError("attachment conflict accepted")
            except RequestError:
                pass
            before_invalid_image = Model.calls
            try:
                await client.prompt(
                    session["sessionId"],
                    "invalid image",
                    "invalid-image",
                    blocks=[
                        {
                            "type": "image",
                            "mimeType": "image/png",
                            "data": "invalid-image-content",
                        }
                    ],
                )
                raise AssertionError("SDK image omission was accepted")
            except RequestError as error:
                assert "图片" in str(error), error
            assert Model.calls == before_invalid_image, (
                "incomplete image reached model endpoint"
            )
            compacted = await client.extension(
                "aa/execute_command",
                {"sessionId": session["sessionId"], "command": "compact", "args": []},
            )
            assert compacted["ok"] is True, compacted
            assert Model.calls > calls_with_image, (
                "compact did not invoke the SDK/model"
            )
            before = Model.calls
            await client.close_session(session["sessionId"])
            receipt = await client.extension(
                "aa/get_operation",
                {
                    "sessionId": session["sessionId"],
                    "clientMessageId": "stable-message",
                },
            )
            assert receipt["receipt"]["messageAccepted"] is True
            await client.resume(session["sessionId"], str(workspace))
            await client.prompt(
                session["sessionId"], "after clean resume", "resume-message"
            )
            assert Model.calls == before + 1
            await client.close_session(session["sessionId"])
            await client.close()
            client = AgentClient(update, interaction)
            client.process = ControlledProcess()
            await client.start(launch, str(root))
            receipt = await client.extension(
                "aa/get_operation",
                {
                    "sessionId": session["sessionId"],
                    "clientMessageId": "stable-message",
                },
            )
            assert (
                receipt["receipt"]["messageAccepted"] is True
                and Model.calls == before + 1
            )
            assert any(kind == "form" for kind, _ in interactions)
            print(
                "ACP composition: trust before resources, initialization, approved write, actual image payload, malformed-image rejection before HTTP, attachment idempotency, native compact, durable receipts, clean resume and conflict rejection passed"
            )
            hosted_launch = LaunchDefinition(
                launch.executable,
                tuple(
                    str(root / "connector-agent") if arg == str(state) else arg
                    for arg in launch.arguments
                ),
                launch.release_id,
            )
            await verify_connector(root, workspace, hosted_launch)
        finally:
            await client.close()
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    asyncio.run(main())

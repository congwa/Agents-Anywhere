"""HTTP workflow → PostgreSQL → Python/MeshCall → packaged SDK worker integration."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
from fastapi import FastAPI
from loguru import logger

from agent_server.api.runtime_workflows import router
from agent_server.api.sessions import respond_interaction
from agent_server.core.models import (
    InteractionRespondRequest,
    MessageCreateRequest,
    NoticeIn,
    TimelineItemIn,
)
from agent_server.core.protocol import ProtocolCapabilitySet
from agent_server.deps import current_user_id, get_runtime_workflow_service
from agent_server.infra.connector_rpc import ConnectorRpcError
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_notifications import ConnectorNotificationService
from agent_server.services.connector_realtime import ConnectorRealtimeService
from agent_server.services.effective_capabilities import (
    derive_session_effective_capabilities,
)
from agent_server.services.runtime_workflows import RuntimeWorkflowService
from agent_server.services.session_run import SessionRunService
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache
from connector.core.json_kv import JsonKeyValueStore
from connector.mesh.hub import local_hub
from connector.runtime_protocol.instance_models import RuntimeInstanceSpec
from connector.runtime_protocol.supervisor import RuntimeSupervisor
from connector.runtimes.pi.provider import PiProvider
from connector.server.dispatch import ConnectorRequestDispatcher
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_rpc_payloads import capability_set_payload


class ModelHttp(BaseHTTPRequestHandler):
    calls = 0
    reject_next = False

    def do_POST(self):
        value = json.loads(self.rfile.read(int(self.headers["content-length"])))
        assert value["model"] == "physical-a"
        type(self).calls += 1
        if type(self).reject_next:
            type(self).reject_next = False
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"temporary fixture failure"}}')
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunk = {
            "id": "local",
            "object": "chat.completion.chunk",
            "model": "physical-a",
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": "API verified"},
                    "finish_reason": "stop",
                }
            ],
        }
        if type(self).calls == 1:
            chunk["choices"][0]["delta"] = {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "write-proof",
                        "type": "function",
                        "function": {
                            "name": "write",
                            "arguments": json.dumps(
                                {
                                    "path": str(PROOF_FILE),
                                    "content": "approved-pi-chain",
                                }
                            ),
                        },
                    }
                ]
            }
            chunk["choices"][0]["finish_reason"] = "tool_calls"
        self.wfile.write(
            ("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode()
        )

    def log_message(self, *args):
        pass


class Host(ConnectorRuntimeHost):
    def __init__(self, root, connector_id, store):
        self._kv = JsonKeyValueStore(root / "kv.json")
        self.notifications = []
        self.ingest = ConnectorNotificationService(
            store, ConnectorRealtimeService(None, None, None)
        )
        self.ingest_errors = []
        super().__init__(
            connector_id, self.notify, None, ingest_notifications=self.receive
        )

    @property
    def runtime_kv(self):
        return self._kv

    async def notify(self, method, params):
        await self.receive([{"method": method, "params": params}])

    async def receive(self, notifications, **kwargs):
        for notification in notifications:
            if notification["method"] == "timeline.itemUpsert":
                TimelineItemIn.model_validate(notification["params"]["item"])
            elif notification["method"] == "notice.upsert":
                NoticeIn.model_validate(notification["params"])
            try:
                await self.ingest.apply(
                    connector_id=self.connector_id,
                    method=notification["method"],
                    params=notification["params"],
                )
            except Exception as error:
                self.ingest_errors.append((notification["method"], str(error)))
                raise
        self.notifications.extend(notifications)


async def main():
    logger.remove()
    url = os.environ["AGENT_SERVER_TEST_DB_URL"]
    assert "test" in url.rsplit("/", 1)[1]
    store = Store(db_url=url)
    server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHttp)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    runtime = None
    temporary = tempfile.TemporaryDirectory(prefix="aa-pi-server-")
    try:
        directory = temporary.name
        root = Path(directory)
        agent = root / "agent"
        cwd = root / "project"
        physical = root / "project-source"
        agent.mkdir()
        (physical / ".pi/extensions").mkdir(parents=True)
        cwd.symlink_to(physical, target_is_directory=True)
        (agent / "settings.json").write_text(
            json.dumps(
                {
                    "retry": {"enabled": False},
                    "compaction": {"enabled": False},
                    "providerRetry": {"maxRetries": 0},
                }
            )
        )
        (agent / "models.json").write_text(
            json.dumps(
                {
                    "providers": {
                        "aa-verification": {
                            "api": "openai-completions",
                            "baseUrl": f"http://127.0.0.1:{server.server_port}",
                            "apiKey": "fixture",
                            "models": [
                                {
                                    "id": "physical-a",
                                    "name": "physical-a",
                                    "reasoning": False,
                                    "input": ["text"],
                                    "contextWindow": 4096,
                                    "maxTokens": 64,
                                    "cost": {
                                        "input": 0,
                                        "output": 0,
                                        "cacheRead": 0,
                                        "cacheWrite": 0,
                                    },
                                }
                            ],
                        }
                    }
                }
            )
        )
        (cwd / ".pi/extensions/startup.ts").write_text(
            "export default function(pi) { pi.on('session_start', async (_e, ctx) => { if (!(await ctx.ui.confirm('Initialize', 'Continue?'))) throw new Error('startup refused'); }); }"
        )
        global PROOF_FILE
        PROOF_FILE = cwd / "approved-output.txt"
        user = "pi-check-" + uuid4().hex[:10]
        await store.create_user(user_id=user, password_hash="fixture-disabled")
        connector, _, _ = await store.create_connector(name="pi-check", user_id=user)
        project = await store.create_project(
            user_id=user,
            connector_id=connector.id,
            name="pi-check",
            workspace_path=str(cwd),
        )
        host = Host(root, connector.id, store)
        provider = PiProvider()
        supervisor = RuntimeSupervisor((provider,), host)
        runtime = await supervisor.start(
            RuntimeInstanceSpec(
                runtime_id="rti_pi_review", runtime_type="pi", name="pi review"
            ),
            {"agentDir": str(agent)},
        )
        handler = ConnectorRequestDispatcher(
            supervisor, host, None, None, None, lambda job: asyncio.create_task(job)
        )

        class RuntimeService:
            async def get_runtime(self, connector_id, runtime_id, *, user_id):
                if (
                    user_id != user
                    or connector_id != connector.id
                    or runtime_id != "rti_pi_review"
                ):
                    raise KeyError(runtime_id)
                return SimpleNamespace(
                    runtimeType="pi", runtimeId="rti_pi_review", status="running"
                )

            async def ensure_session_routable(self, *args, **kwargs):
                pass

        class Rpc:
            drop_reserve_ack = False

            async def is_online(self, connector_id):
                return True

            async def request(self, connector_id, method, params, **kwargs):
                try:
                    result = await handler.dispatch(method, params)
                    if (
                        method == "workspace.preparation.reserve"
                        and Rpc.drop_reserve_ack
                    ):
                        Rpc.drop_reserve_ack = False
                        raise ConnectorRpcError(
                            "outcome_unknown", "controlled lost reservation ACK"
                        )
                    return result
                except Exception as error:
                    raise ConnectorRpcError(
                        getattr(error, "code", None) or type(error).__name__, str(error)
                    ) from error

        service = RuntimeWorkflowService(store, Rpc(), RuntimeService())
        app = FastAPI()
        app.include_router(router, prefix="/api/v2")
        app.dependency_overrides[current_user_id] = lambda: user
        app.dependency_overrides[get_runtime_workflow_service] = lambda: service

        @app.post("/api/v2/sessions/{sid}/runtime/notices/{nid}/respond")
        async def notice_response(
            sid: str, nid: str, payload: InteractionRespondRequest
        ):
            return await respond_interaction(
                sid,
                nid,
                payload,
                user_id=user,
                db=store,
                broker=TimelineBroker(),
                manager=Rpc(),
                runtime_state_cache=SessionRuntimeStateCache(),
            )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://fixture"
        ) as client:

            async def get(kind, identifier):
                result = await client.get(
                    f"/api/v2/runtime-workflows/{kind}/{identifier}"
                )
                assert result.status_code == 200, result.text
                return result.json()

            async def until(kind, identifier, predicate):
                for _ in range(200):
                    value = await get(kind, identifier)
                    assert value["state"]["phase"] != "failed", value
                    if predicate(value):
                        return value
                    await asyncio.sleep(0.05)
                raise AssertionError("workflow timed out")

            response = await client.post(
                "/api/v2/runtime-workflows/preparations",
                json={
                    "connectorId": connector.id,
                    "runtimeId": "rti_pi_review",
                    "projectId": project.id,
                    "clientPreparationId": "client-1",
                },
            )
            assert response.status_code == 202, response.text
            prep = response.json()
            prep = await until(
                "preparation",
                prep["id"],
                lambda value: any(
                    x["status"] == "open" for x in value["state"]["interactions"]
                ),
            )
            request = next(
                x for x in prep["state"]["interactions"] if x["status"] == "open"
            )

            async def answer(value, request, action, input=None):
                body = {
                    key: request[key]
                    for key in ("interactionId", "requestRevision", "ownerGeneration")
                }
                body.update(responseOperationId=uuid4().hex, actionId=action)
                if input is not None:
                    body["input"] = input
                result = await client.post(
                    f"/api/v2/runtime-workflows/{value['kind']}/{value['id']}/responses",
                    json=body,
                )
                assert result.status_code == 200, result.text

            await answer(prep, request, "trust_directory")
            prep = await until(
                "preparation",
                prep["id"],
                lambda value: value["state"]["phase"] == "ready",
            )
            state = prep["state"]
            model = next(
                item
                for item in state["catalog"]["models"]
                if item["id"].endswith("/physical-a")
            )
            body = {
                "preparationId": prep["id"],
                "createOperationId": "create-1",
                "expectedRevision": state["revision"],
                "catalogRevision": state["catalogRevision"],
                "selections": {"model": model["selectionId"], "permission": "ask"},
                "clientMessageId": "message-1",
                "content": "hello",
            }
            stale = {
                **body,
                "createOperationId": "create-stale",
                "expectedRevision": state["revision"] - 1,
            }
            refused = await client.post(
                "/api/v2/runtime-workflows/creations", json=stale
            )
            assert (
                refused.status_code == 202
                and refused.json()["state"]["phase"] == "rejected"
            ), refused.text
            assert (
                refused.json()["state"]["messageAccepted"] is False
                and refused.json()["sessionId"] is None
            )
            queried = await client.get(
                "/api/v2/runtime-workflows/creation/create-stale"
            )
            cancelled = await client.post(
                "/api/v2/runtime-workflows/creation/create-stale/cancel",
                json={"operationId": "cancel-stale"},
            )
            assert queried.status_code == cancelled.status_code == 200
            assert (
                queried.json()["state"]
                == cancelled.json()["state"]
                == refused.json()["state"]
            )
            assert (
                await store.get_runtime_workflow(
                    prep["id"], user_id=user, kind="preparation"
                )
            )["consumed_by"] is None
            assert ModelHttp.calls == 0
            Rpc.drop_reserve_ack = True
            unknown = await client.post(
                "/api/v2/runtime-workflows/creations", json=body
            )
            assert unknown.status_code == 503, unknown.text
            assert (
                await store.get_runtime_workflow(
                    prep["id"], user_id=user, kind="preparation"
                )
            )["consumed_by"] == body["createOperationId"]
            recovered = await client.get("/api/v2/runtime-workflows/creation/create-1")
            assert recovered.status_code == 200, recovered.text
            refused_again = await client.post(
                "/api/v2/runtime-workflows/creations", json=stale
            )
            assert (
                refused_again.status_code == 202
                and refused_again.json()["state"]["messageAccepted"] is False
            )
            assert (
                await store.get_runtime_workflow(
                    prep["id"], user_id=user, kind="preparation"
                )
            )["consumed_by"] == body["createOperationId"]
            print(
                "Known reservation rejection / durable query-cancel / claim release / lost-ACK recovery / late rejected retry: passed"
            )
            response, simultaneous = await asyncio.gather(
                client.post("/api/v2/runtime-workflows/creations", json=body),
                client.post("/api/v2/runtime-workflows/creations", json=body),
            )
            assert response.status_code == simultaneous.status_code == 202, (
                response.text + simultaneous.text
            )
            assert response.json()["sessionId"] == simultaneous.json()["sessionId"]
            creation = response.json()
            session_id = creation["sessionId"]
            duplicate = await client.post(
                "/api/v2/runtime-workflows/creations", json=body
            )
            assert (
                duplicate.status_code == 202
                and duplicate.json()["sessionId"] == session_id
            ), duplicate.text
            creation = await until(
                "creation",
                "create-1",
                lambda value: any(
                    x["status"] == "open" for x in value["state"]["interactions"]
                ),
            )
            request = next(
                x for x in creation["state"]["interactions"] if x["status"] == "open"
            )
            assert request["kind"] == "confirm"
            await answer(
                creation,
                request,
                "submit",
                {"kind": "confirm", "status": "submitted", "value": True},
            )
            creation = await until(
                "creation",
                "create-1",
                lambda value: value["state"].get("messageAccepted") is True,
            )
            for _ in range(200):
                notices = await runtime.get_session_notices(session_id)
                pending = [x for x in notices if x.status == "open"]
                if pending:
                    break
                await asyncio.sleep(0.025)
            assert pending and pending[0].interaction_type == "approval"
            assert not PROOF_FILE.exists()
            notice = pending[0]
            approval = {
                "actionId": "approve",
                "input": {
                    "ownerGeneration": notice.metadata["ownerGeneration"],
                    "requestRevision": notice.metadata["requestRevision"],
                    "responseOperationId": "qa-tool-answer",
                },
            }
            approval_response = await client.post(
                f"/api/v2/sessions/{session_id}/runtime/notices/{notice.notice_id}/respond",
                json=approval,
            )
            assert (
                approval_response.status_code == 200 and approval_response.json()["ok"]
            ), approval_response.text
            for _ in range(200):
                if (
                    PROOF_FILE.exists()
                    and ModelHttp.calls == 2
                    and (await runtime.get_session_state(session_id)).status == "idle"
                ):
                    break
                await asyncio.sleep(0.025)
            assert PROOF_FILE.read_text() == "approved-pi-chain"
            assert ModelHttp.calls == 2
            for _ in range(200):
                capabilities = await runtime.get_session_capabilities(session_id)
                if (
                    any(
                        x.capability_id == "session.send_message" and x.available
                        for x in capabilities.capabilities
                    )
                    and await store.get_active_run(session_id) is None
                ):
                    break
                await asyncio.sleep(0.025)
            else:
                raise AssertionError(
                    (
                        "send unavailable after tool completion",
                        [
                            (x.capability_id, x.available)
                            for x in capabilities.capabilities
                        ],
                        await runtime.get_session_notices(session_id),
                    )
                )
            runner = SessionRunService(store, Rpc(), RuntimeService())
            await runner.send_message(
                session_id,
                MessageCreateRequest(content="follow-up", clientMessageId="message-2"),
                user_id=user,
            )
            for _ in range(200):
                if (
                    ModelHttp.calls == 3
                    and (await runtime.get_session_state(session_id)).status == "idle"
                    and len(
                        [
                            x
                            for x in host.notifications
                            if x["method"] == "session.turnEnded"
                        ]
                    )
                    == 2
                ):
                    break
                await asyncio.sleep(0.025)
            assert ModelHttp.calls == 3
            await asyncio.sleep(0.3)
            items, _ = await store.list_timeline_latest(
                session_id=session_id, limit=100
            )
            assert sum(item.role == "user" for item in items) == 2
            assert any(item.role == "tool" for item in items)
            assistants = [item for item in items if item.role == "assistant"]
            assert len(assistants) == 3
            assert all(
                item.status == "done" and item.source.itemId for item in assistants
            )
            assert (
                sum(
                    "API verified" in item.content.get("text", "")
                    for item in assistants
                )
                == 2
            )
            assert not host.ingest_errors, host.ingest_errors
            print(
                "HTTP startup / HTTP tool approval / actual write / follow-up / persisted Timeline:",
                len(items),
                "items,",
                ModelHttp.calls,
                "model calls",
            )
            close = await client.post(
                f"/api/v2/runtime-workflows/sessions/{session_id}/close",
                json={
                    "ownerGeneration": creation["state"]["workerGeneration"],
                    "closeOperationId": "close-review",
                },
            )
            assert close.status_code == 200 and close.json()["ok"], close.text

            before_native = (await store.get_session(session_id)).externalSessionId
            resumed = asyncio.create_task(
                runner.send_message(
                    session_id,
                    MessageCreateRequest(
                        content="restore-follow-up", clientMessageId="message-3"
                    ),
                    user_id=user,
                )
            )
            for _ in range(200):
                pending = [
                    x
                    for x in await runtime.get_session_notices(session_id)
                    if x.status == "open"
                ]
                if pending:
                    break
                if resumed.done():
                    await resumed
                await asyncio.sleep(0.025)
            assert pending
            notice = pending[0]
            result = await client.post(
                f"/api/v2/sessions/{session_id}/runtime/notices/{notice.notice_id}/respond",
                json={
                    "actionId": "submit",
                    "input": {
                        "ownerGeneration": notice.metadata["ownerGeneration"],
                        "requestRevision": notice.metadata["requestRevision"],
                        "responseOperationId": "resume-answer",
                        "response": {
                            "kind": "confirm",
                            "status": "submitted",
                            "value": True,
                        },
                    },
                },
            )
            assert result.status_code == 200 and result.json()["ok"], result.text
            await resumed
            for _ in range(200):
                if (
                    ModelHttp.calls == 4
                    and len(
                        [
                            x
                            for x in host.notifications
                            if x["method"] == "session.turnEnded"
                        ]
                    )
                    == 3
                ):
                    break
                await asyncio.sleep(0.025)
            await asyncio.sleep(0.3)
            assert ModelHttp.calls == 4
            assert (
                await store.get_session(session_id)
            ).externalSessionId == before_native
            print(
                "HTTP close / clean restore / restored session_start answer / continued SDK request: passed"
            )

            for _ in range(200):
                caps = await runtime.get_session_capabilities(session_id)
                if (
                    any(
                        cap.capability_id == "session.send_message" and cap.available
                        for cap in caps.capabilities
                    )
                    and await store.get_active_run(session_id) is None
                ):
                    break
                await asyncio.sleep(0.025)
            ModelHttp.reject_next = True
            await runner.send_message(
                session_id,
                MessageCreateRequest(
                    content="provider failure", clientMessageId="provider-failure"
                ),
                user_id=user,
            )
            for _ in range(200):
                if (
                    await runtime.get_session_state(session_id)
                ).status == "error" and await store.get_active_run(session_id) is None:
                    break
                await asyncio.sleep(0.025)
            assert (await runtime.get_session_state(session_id)).status == "error"
            await runner.send_message(
                session_id,
                MessageCreateRequest(
                    content="after provider failure",
                    clientMessageId="after-provider-failure",
                ),
                user_id=user,
            )
            for _ in range(200):
                if (
                    ModelHttp.calls == 6
                    and (await runtime.get_session_state(session_id)).status == "idle"
                    and await store.get_active_run(session_id) is None
                ):
                    break
                await asyncio.sleep(0.025)
            assert ModelHttp.calls == 6
            assert (await runtime.get_session_state(session_id)).status == "idle"
            print(
                "Provider HTTP 500 / Server error-state admission / subsequent SDK request: passed"
            )

            assert (
                await store.get_session(session_id, user_id=user)
            ).projectId == project.id
            before_reconnect = len(host.notifications)
            await runtime.resynchronize()
            recovered_methods = {
                item["method"] for item in host.notifications[before_reconnect:]
            }
            assert {
                "timeline.itemUpsert",
                "session.state.updated",
                "runtime.capability.updated",
            } <= recovered_methods
            inventory = await runtime.list_complete_session_inventory()
            assert len(inventory) == 1 and inventory[0].cwd == str(cwd)
            assert runtime.sync_mode == "events"
            print(
                "Symbolic workspace project binding / event-mode reconnect state, capability and Timeline refill: passed"
            )
            assert any(
                x["method"] == "timeline.itemUpsert" for x in host.notifications
            ), await runtime.native_runtime._request("ping")
            caps = await runtime.get_session_capabilities(session_id)
            assert caps.capabilities and all(
                cap.session_id == session_id for cap in caps.capabilities
            )
            session = (await store.get_session(session_id, user_id=user)).model_copy(
                update={"connectorStatus": "online", "takeover": True}
            )
            effective = derive_session_effective_capabilities(
                session=session,
                runtime_capabilities=ProtocolCapabilitySet.model_validate(
                    capability_set_payload(caps)
                ),
            )
            assert any(
                cap.capabilityId == "session.execution_position.read"
                and cap.available
                and cap.allowed
                for cap in effective.capabilities
            )
            assert any(
                cap.capabilityId == "session.send_message" and cap.supported
                for cap in effective.capabilities
            )
            first_end = await store.record_session_turn_end(
                session_id=session_id,
                source_event_id="event-1",
                source_event_digest="same",
            )
            duplicate_end = await store.record_session_turn_end(
                session_id=session_id,
                source_event_id="event-1",
                source_event_digest="same",
            )
            assert first_end.updatedSeq == duplicate_end.updatedSeq
            bad = await client.post(
                "/api/v2/runtime-workflows/creations",
                json={**body, "content": "different"},
            )
            assert bad.status_code == 409, bad.text
            app.dependency_overrides[current_user_id] = lambda: "another-account"
            assert (
                await client.get("/api/v2/runtime-workflows/creation/create-1")
            ).status_code == 404
            print(
                "HTTP 202 / startup reply / PostgreSQL identity / duplicate create / conflict / account isolation / SDK HTTP / timeline ACK: passed"
            )
    finally:
        if runtime:
            await supervisor.stop("rti_pi_review")
        await (await local_hub()).stop()
        await store.close()
        server.shutdown()
        server.server_close()
        temporary.cleanup()


if __name__ == "__main__":
    asyncio.run(main())

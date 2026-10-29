"""Direct integration check with a fresh Router and real packaged Host."""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

from loguru import logger

from connector.core.json_kv import JsonKeyValueStore
from connector.mesh.hub import local_hub
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.instance_binding import RuntimeInstanceHost
from connector.runtime_protocol.instance_models import RuntimeInstanceSpec
from connector.runtime_protocol.workflows import RuntimeWorkflowRequest
from connector.runtimes.pi.provider import PiProvider
from connector.server.runtime_rpc import RuntimeRpcHandler
from connector.server.runtime_sync import RuntimeSyncRunner


class Host(RuntimeHostClient):
    connector_id = "pi-local-verification"

    def __init__(self, root: Path):
        self._kv = JsonKeyValueStore(root / "kv.json")
        self.notifications = []

    @property
    def runtime_kv(self):
        return self._kv

    async def publish_runtime_notifications(
        self, runtime, notifications, runtime_id=None
    ):
        self.notifications.extend(notifications)


async def main():
    logger.remove()
    with tempfile.TemporaryDirectory(prefix="aa-pi-connector-") as directory:
        root = Path(directory)
        (root / "project").mkdir()
        provider = PiProvider()
        config = await provider.validate_config({"agentDir": str(root / "agent")})
        history = root / "agent/sessions/native.jsonl"
        history.parent.mkdir(parents=True)
        history.write_text(
            "\n".join(
                json.dumps(value)
                for value in [
                    {
                        "type": "session",
                        "id": "native-probe",
                        "cwd": str(root / "project"),
                    },
                    {
                        "type": "message",
                        "id": "message-1",
                        "parentId": None,
                        "message": {"role": "user", "content": "native history probe"},
                    },
                ]
            )
            + "\n"
        )
        (history.parent / "broken-header.jsonl").write_text("{\n")
        (history.parent / "broken-body.jsonl").write_text(
            json.dumps(
                {"type": "session", "id": "native-broken", "cwd": str(root / "project")}
            )
            + "\n{\n"
        )
        host = Host(root)
        runtime = await provider.create_runtime(
            config,
            RuntimeInstanceHost(
                base=host,
                instance=RuntimeInstanceSpec(
                    runtime_id="rti_pi_probe", runtime_type="pi", name="pi probe"
                ),
            ),
        )
        try:
            await runtime.start()
            assert runtime.identity.runtime_id == "rti_pi_probe"
            assert runtime.sync_mode == "events"
            assert RuntimeRpcHandler(None, None).supports("session.close")
            page = await runtime._request("listSessions", {"limit": 100})
            assert len(page["sessions"]) == 2
            assert len(page["diagnostics"]) == 1
            assert page["diagnostics"][0]["path"].endswith("broken-header.jsonl")
            runner = RuntimeSyncRunner(
                None,
                SimpleNamespace(
                    runtimes=("rti_pi_probe",), resolve_runtime=lambda _: runtime
                ),
                host,
                dict,
                None,
            )
            await runner.reconnect_event_runtimes()
            methods = {item["method"] for item in host.notifications}
            assert {
                "session.meta.upsert",
                "timeline.itemUpsert",
                "session.state.updated",
                "runtime.capability.updated",
            } <= methods
            assert any(
                item["method"] == "timeline.itemUpsert"
                and "native history probe"
                in item["params"]["item"]["content"].get("text", "")
                for item in host.notifications
            )
            result = await runtime.execute_workflow(
                RuntimeWorkflowRequest(
                    "prepare",
                    {
                        "preparationId": "prep-mesh",
                        "clientPreparationId": "client-mesh",
                        "cwd": str(root / "project"),
                    },
                )
            )
            assert result.values["preparationId"] == "prep-mesh"
            for _ in range(100):
                state = await runtime.execute_workflow(
                    RuntimeWorkflowRequest(
                        "get_preparation", {"preparationId": "prep-mesh"}
                    )
                )
                if state.values["phase"] == "ready":
                    break
                assert state.values["phase"] != "failed", state.values
                await asyncio.sleep(0.05)
            else:
                raise AssertionError("preparation timed out")
            assert any(
                item.capability_id == "runtime.session.async_create"
                for item in (await runtime.get_runtime_capabilities()).capabilities
            )
            print(
                "Python → MeshCall → packaged SDK preview / close dispatch / events reconnect / corrupt-history isolation: passed"
            )
        finally:
            await runtime.stop()
            await (await local_hub()).stop()


if __name__ == "__main__":
    asyncio.run(main())

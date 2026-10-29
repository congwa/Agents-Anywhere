from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from meshcall import MeshCallError, mutates, service
from pydantic import BaseModel, ConfigDict, Field

from connector.mesh.hub import (
    PI_BRIDGE_SERVICE,
    PI_SYNC_SERVICE,
    local_hub,
    run_on_loop,
)
from connector.runtime_protocol.errors import RuntimeUpstreamError
from connector.runtime_protocol.host import RuntimeHostClient


class Payload(BaseModel):
    model_config = ConfigDict(extra="allow")


class SyncBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runtimeId: str = Field(min_length=1, max_length=160)
    sessionNamespace: str = Field(min_length=1, max_length=1024)
    batchId: str = Field(min_length=1, max_length=160)
    notifications: list[dict[str, Any]] = Field(min_length=1, max_length=256)


@service(PI_SYNC_SERVICE, description="Acknowledged pi Runtime notification ingestion")
class PiSyncService:
    def __init__(self) -> None:
        self.hosts: dict[
            tuple[str, str], tuple[RuntimeHostClient, asyncio.AbstractEventLoop]
        ] = {}

    @mutates(idempotent=True)
    async def ingestBatch(self, batch: SyncBatch) -> Payload:
        """Ingest durable runtime notifications and acknowledge accepted delivery."""
        target = self.hosts.get((batch.runtimeId, batch.sessionNamespace))
        if target is None:
            raise MeshCallError("runtime_unavailable", "pi Runtime is not registered")
        host, loop = target
        # This path awaits the shared ingest transport; queued UI callbacks are
        # not sufficient ACKs for a durable runtime delivery record.
        await run_on_loop(
            loop,
            host.publish_runtime_notifications(
                "pi", batch.notifications, runtime_id=batch.runtimeId
            ),
        )
        return Payload(ok=True)


_services: dict[int, PiSyncService] = {}


async def bind_sync(
    host: RuntimeHostClient, runtime_id: str
) -> tuple[Any, PiSyncService]:
    hub = await local_hub()
    current = _services.get(id(hub))
    if current is None:
        current = PiSyncService()
        await hub.mount(current)
        _services[id(hub)] = current
    current.hosts[(runtime_id, host.session_namespace)] = (
        host,
        asyncio.get_running_loop(),
    )
    return hub, current


class PiBridgeClient:
    def __init__(self, hub: Any, runtime_id: str, namespace: str) -> None:
        self.hub, self.runtime_id, self.namespace = hub, runtime_id, namespace

    async def request(
        self, method: str, params: Mapping[str, Any] | None = None, timeout: float = 30
    ) -> dict[str, Any]:
        try:
            result = await self.hub.mesh.call_unary(
                PI_BRIDGE_SERVICE,
                method,
                Payload(
                    **{
                        **dict(params or {}),
                        "runtimeId": self.runtime_id,
                        "sessionNamespace": self.namespace,
                    }
                ),
                Payload,
                timeout=timeout,
            )
            return result.model_dump()
        except MeshCallError as error:
            mapped = RuntimeUpstreamError(error.message)
            mapped.code = error.code
            raise mapped from error

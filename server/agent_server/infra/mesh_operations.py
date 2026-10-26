"""Worker-side shared Router access and scoped device grants."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import time

from meshcall import Mesh, Router, RouterCredentials
from meshcall.router_auth import RouterScope

from agent_server.generated.operations import OperationsServiceClient
from agent_server.infra.connector_mesh_contract import (
    operations_service_name,
    service_names,
)
from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcManager
from agent_server.infra.redis_coordinator import RedisCoordinator


def service_name(connector_id: str, connection_id: str) -> str:
    """Compatibility helper for the existing durable Operations client."""

    return operations_service_name(connector_id, connection_id)


class MeshOperations:
    def __init__(self, rpc: ConnectorRpcManager, coordinator: RedisCoordinator) -> None:
        self.rpc, self.coordinator = rpc, coordinator
        self.mesh: Mesh | None = None
        self.local_grants: dict[str, dict] = {}

    def connection(self) -> Mesh:
        if self.mesh is not None:
            return self.mesh
        if not os.environ.get("AGENT_SERVER_MESH_URL"):
            raise ConnectorOfflineError(
                "Start AA through python -m agent_server.main for MeshCall"
            )
        self.mesh = Mesh(
            Router(os.environ["AGENT_SERVER_MESH_URL"]),
            credentials=RouterCredentials.basic(
                "server", os.environ["AGENT_SERVER_MESH_KEY"]
            ),
        )
        return self.mesh

    async def close(self) -> None:
        mesh, self.mesh = self.mesh, None
        if mesh is not None:
            with contextlib.suppress(Exception):
                await mesh.close()

    async def client(self, connector_id: str) -> tuple[OperationsServiceClient, str]:
        connection_id = await self.rpc.current_connection_id(connector_id)
        if connection_id is None:
            raise ConnectorOfflineError("connector is offline")
        return OperationsServiceClient(
            self.connection(), service_name(connector_id, connection_id), connection_id
        ), connection_id

    async def issue(
        self, connector_id: str, connection_id: str, fingerprint: str
    ) -> dict:
        names = service_names(connector_id, connection_id)
        issued = await self.connection().auth.issue_token(
            [
                RouterScope(
                    service=name,
                    methods=["ping"] if domain == "Operations" else [],
                    register_service=True,
                )
                for domain, name in names.items()
            ],
            ttl_seconds=900,
        )
        value = {
            "connectorId": connector_id,
            "connectionId": connection_id,
            "fingerprint": fingerprint,
            "expiresAt": time.time() + 900,
            "tokenId": issued.token_id,
        }
        digest = hashlib.sha256(issued.token.encode()).hexdigest()
        if self.coordinator.distributed:
            await self.coordinator.client.set(
                self.coordinator.key("mesh-grant", digest), json.dumps(value), ex=900
            )
        else:
            self.local_grants = {
                k: v
                for k, v in self.local_grants.items()
                if v["expiresAt"] > time.time()
            }
            self.local_grants[digest] = value
        return {
            "protocolVersion": "1.0",
            "path": "/api/v2/connector/mesh",
            "service": names["Operations"],
            "services": names,
            "instanceId": connection_id,
            "connectionId": connection_id,
            "token": issued.token,
            "expiresIn": 900,
        }

    async def grant(self, token: str) -> dict | None:
        digest = hashlib.sha256(token.encode()).hexdigest()
        if self.coordinator.distributed:
            raw = await self.coordinator.client.get(
                self.coordinator.key("mesh-grant", digest)
            )
            value = json.loads(raw) if raw else None
        else:
            value = self.local_grants.get(digest)
        return value if value and value["expiresAt"] > time.time() else None

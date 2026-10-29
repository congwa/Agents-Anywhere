from __future__ import annotations

import asyncio
import contextlib
import hashlib
import re
from collections.abc import Mapping
from dataclasses import fields
from typing import Any

from loguru import logger

from connector.runtime_protocol.errors import (
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
    RuntimeUpstreamError,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.models import (
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeReasoningItem,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.protocol import AgentRuntime
from connector.runtime_protocol.workflows import (
    RuntimeWorkflowRequest,
    RuntimeWorkflowResult,
)
from connector.runtimes.pi.bridge import PiBridgeClient, bind_sync
from connector.runtimes.pi.environment import resolve_environment
from connector.runtimes.pi.lifecycle import HostProcess


def dto[T](cls: type[T], value: Mapping[str, Any], **defaults: Any) -> T:
    names = {field.name for field in fields(cls)}
    data = {
        re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower(): item
        for key, item in value.items()
    }
    return cls(
        **{key: item for key, item in {**defaults, **data}.items() if key in names}
    )


def operation(value: dict[str, Any]) -> RuntimeOperationResult:
    return RuntimeOperationResult(
        ok=value.get("ok", True),
        code=value.get("code"),
        message=value.get("message"),
        result=value,
    )


WORKFLOWS = {
    "prepare": "prepareWorkspace",
    "get_preparation": "getPreparation",
    "refresh_preparation": "refreshPreparation",
    "cancel_preparation": "cancelPreparation",
    "respond_preparation": "respondPreparationInteraction",
    "reserve": "reservePreparation",
    "begin_creation": "beginCreateAndStartSession",
    "get_creation": "getCreationOperation",
    "respond_creation": "respondCreationInteraction",
    "cancel_initialization": "cancelInitialization",
    "get_response": "getInteractionResponse",
    "get_tree": "getSessionTree",
    "select_position": "selectExecutionPosition",
    "close_session": "closeSession",
}


class PiRuntime(AgentRuntime):
    def __init__(self, config: RuntimeConfig, host: RuntimeHostClient) -> None:
        self.config, self.host = config, host
        self.process = HostProcess()
        self.client: PiBridgeClient | None = None
        self.sync_service = None
        self._watch_task: asyncio.Task | None = None
        self._stopping = False
        self._calibration_task: asyncio.Task | None = None

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="pi",
            runtime_version="1.4.0",
            display_name="pi",
            runtime_id=self.config.runtime_id,
        )

    @property
    def sync_mode(self) -> str:
        return "events"

    async def start(self) -> None:
        environment = await resolve_environment(dict(self.config.values))
        runtime_id = self.config.runtime_id or "pi"
        hub, self.sync_service = await bind_sync(self.host, runtime_id)
        namespace = self.host.session_namespace
        root = (
            self.host.runtime_kv.path.parent
            / "pi"
            / hashlib.sha256(f"{runtime_id}:{namespace}".encode()).hexdigest()
        )
        values = dict(self.config.values)
        config = {
            key: values[key]
            for key in (
                "agentDir",
                "maxWorkers",
                "maxRunMs",
                "maxConcurrentRuns",
                "preparationTtlMs",
            )
        }
        config.update(
            runtimeId=runtime_id, sessionNamespace=namespace, storageRoot=str(root)
        )
        try:
            await self.process.start(environment, hub, config)
            self.client = PiBridgeClient(hub, runtime_id, namespace)
            initialized = await self._request("initialize", {"protocolVersion": "1.0"})
            features = initialized.get("features")
            if (
                not isinstance(features, Mapping)
                or features.get("orderedSessionSync") is not True
            ):
                raise RuntimeUnavailableError(
                    "pi 运行产物缺少有序回填能力，请更新本实例的运行产物。"
                )
            self._stopping = False
            self._watch_task = asyncio.create_task(self._watch())
            self._calibration_task = asyncio.create_task(self._calibrate())
        except BaseException:
            await self.stop()
            raise

    async def _calibrate(self) -> None:
        while not self._stopping:
            try:
                await self.resynchronize()
                return
            except (RuntimeError, OSError, ValueError) as error:
                if (
                    not self.process.process
                    or self.process.process.returncode is not None
                ):
                    return
                logger.warning("pi 启动回填等待重试：{}", error)
                await asyncio.sleep(1)

    async def resynchronize(self, session_id=None, external_session_id=None) -> None:
        if session_id:
            await self._request(
                "resynchronizeSession", {"sessionId": session_id, "limit": 1000}
            )
            return
        cursor = None
        while True:
            page = await self._request(
                "listSessions", {"limit": 100, **({"cursor": cursor} if cursor else {})}
            )
            for diagnostic in page.get("diagnostics", []):
                logger.warning("pi 原生历史扫描异常：{}", diagnostic)
            for meta in page["sessions"]:
                try:
                    await self.resynchronize(
                        meta["sessionId"], meta.get("externalSessionId")
                    )
                except RuntimeUpstreamError as error:
                    if error.code not in {
                        "history_invalid",
                        "history_too_large",
                        "history_unavailable",
                        "history_source_changed",
                    }:
                        raise
                    logger.warning(
                        "pi 历史同步跳过异常会话 {}：{}", meta["sessionId"], error
                    )
            cursor = page.get("nextCursor")
            if not cursor:
                return

    async def sync_session_timeline(self, session_id, external_session_id=None):
        await self.resynchronize(session_id, external_session_id)
        return True

    async def _watch(self) -> None:
        process = self.process.process
        if process:
            await process.wait()
            if not self._stopping:
                await self.host.runtime_health_update(
                    "error",
                    {
                        "code": "pi_host_exited",
                        "message": "pi Host 已退出，请重新启动此 Runtime。",
                    },
                )

    async def stop(self) -> None:
        self._stopping = True
        if self._calibration_task:
            self._calibration_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._calibration_task
            self._calibration_task = None
        await self.process.stop()
        if self._watch_task:
            self._watch_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._watch_task
            self._watch_task = None
        if self.sync_service:
            self.sync_service.hosts.pop(
                (self.config.runtime_id or "pi", self.host.session_namespace), None
            )
        self.client = None

    async def _request(
        self, method: str, params: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        if (
            not self.client
            or not self.process.process
            or self.process.process.returncode is not None
        ):
            raise RuntimeUnavailableError("pi Host 未运行。")
        return await self.client.request(method, params)

    async def execute_workflow(
        self, request: RuntimeWorkflowRequest
    ) -> RuntimeWorkflowResult:
        return RuntimeWorkflowResult(
            await self._request(WORKFLOWS[request.operation], request.values)
        )

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        ids = (
            "runtime.workspace.prepare",
            "runtime.session.async_create",
            "catalog.permission",
            "catalog.model",
        )
        return RuntimeCapabilitySet(
            runtime="pi",
            runtime_id=self.config.runtime_id,
            revision=1,
            capabilities=tuple(
                RuntimeCapability(
                    capability_id=key,
                    scope="runtime",
                    runtime="pi",
                    metadata={"workflowVersion": "1.1"},
                )
                for key in ids
            ),
        )

    async def list_model_catalog(self, query=None, limit=100) -> RuntimeModelCatalog:
        return RuntimeModelCatalog(runtime="pi", revision=0, models=())

    async def list_scoped_model_catalog(self, session_id: str, query=None, limit=100):
        value = (
            await self._request("getScopedModelCatalog", {"sessionId": session_id})
        )["catalog"]
        models = tuple(
            dto(
                RuntimeModelItem,
                {
                    **item,
                    "reasoningItems": tuple(
                        dto(RuntimeReasoningItem, effort)
                        for effort in item["reasoningItems"]
                    ),
                },
            )
            for item in value["models"]
        )
        return RuntimeModelCatalog(
            runtime="pi", revision=value["revision"], models=models
        )

    async def list_permission_catalog(
        self, query=None, limit=100
    ) -> RuntimePermissionCatalog:
        return RuntimePermissionCatalog(
            runtime="pi",
            revision=1,
            permissions=tuple(
                RuntimePermissionItem(id=key, title=title, selection_id=key)
                for key, title in (
                    ("ask", "写入与命令需审批"),
                    ("ask_all", "所有工具需审批"),
                    ("readonly", "只读"),
                )
            ),
        )

    async def list_sessions(
        self, limit=100, cursor=None, force=False
    ) -> tuple[SessionMeta, ...]:
        result = await self._request(
            "listSessions", {"limit": limit, **({"cursor": cursor} if cursor else {})}
        )
        return tuple(dto(SessionMeta, row, runtime="pi") for row in result["sessions"])

    async def list_complete_session_inventory(self, page_size=100, force=False):
        result = []
        cursor = None
        while True:
            page = await self._request(
                "listSessions",
                {
                    "limit": min(page_size, 1000),
                    **({"cursor": cursor} if cursor else {}),
                },
            )
            result.extend(
                dto(SessionMeta, row, runtime="pi") for row in page["sessions"]
            )
            cursor = page.get("nextCursor")
            if not cursor:
                return tuple(result)

    async def get_session_state(
        self, session_id, external_session_id=None
    ) -> SessionState:
        value = await self._request("getSessionState", {"sessionId": session_id})
        return dto(
            SessionState,
            value["state"],
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="pi",
        )

    async def get_session_notices(
        self, session_id, external_session_id=None
    ) -> tuple[SessionNotice, ...]:
        value = await self._request("getSessionNotices", {"sessionId": session_id})
        return tuple(dto(SessionNotice, item) for item in value["notices"])

    async def get_session_capabilities(
        self, session_id, external_session_id=None
    ) -> RuntimeCapabilitySet:
        value = (
            await self._request("getSessionCapabilities", {"sessionId": session_id})
        )["capabilitySet"]
        return dto(
            RuntimeCapabilitySet,
            {
                **value,
                "capabilities": tuple(
                    dto(RuntimeCapability, item) for item in value["capabilities"]
                ),
            },
        )

    async def get_session_snapshot(
        self, session_id, external_session_id=None, limit=None
    ) -> RuntimeTimelineSnapshot:
        result = await self._request(
            "getSessionSnapshot",
            {"sessionId": session_id, "limit": min(limit or 1000, 1000)},
        )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="pi",
            complete=False,
            items=tuple(dto(RuntimeTimelineItem, row) for row in result["items"]),
        )

    async def start_turn(
        self,
        session_id,
        external_session_id,
        content,
        selections=None,
        attachments=(),
        client_message_id=None,
        cwd=None,
    ):
        if attachments:
            raise RuntimeInvalidRequestError("pi 尚未启用附件交付。")
        if selections:
            await self.update_session_selections(
                session_id, external_session_id, selections
            )
        if not client_message_id:
            raise RuntimeInvalidRequestError("pi 消息需要稳定的 clientMessageId。")
        return operation(
            await self._request(
                "startTurn",
                {
                    "sessionId": session_id,
                    "content": content,
                    "clientMessageId": client_message_id,
                },
            )
        )

    async def interrupt_session(self, session_id, reason=None):
        return operation(
            await self._request("interruptSession", {"sessionId": session_id})
        )

    async def update_session_selections(
        self, session_id, external_session_id, selections
    ):
        return operation(
            await self._request(
                "updateSelections",
                {"sessionId": session_id, "selections": dict(selections)},
            )
        )

    async def respond_interaction(
        self, session_id, notice_id, action_id, input_data=None
    ):
        data = dict(input_data or {})
        required = ("ownerGeneration", "requestRevision", "responseOperationId")
        if any(key not in data for key in required):
            raise RuntimeInvalidRequestError("审批回答缺少请求版本、所有者或幂等身份。")
        response = {key: data[key] for key in required}
        if "response" in data:
            response["input"] = data["response"]
        result = await self._request(
            "respondInteraction",
            {
                "sessionId": session_id,
                "interactionId": notice_id,
                "actionId": action_id,
                **response,
            },
        )
        return operation(
            {
                "ok": result.get("disposition") in ("applied", "already_applied"),
                **result,
            }
        )

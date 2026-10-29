from __future__ import annotations

from connector.runtime_protocol import AgentRuntime
from connector.runtime_protocol.errors import (
    RuntimeInvalidRequestError,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
)
from connector.runtime_protocol.models import (
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.workflows import RuntimeWorkflowResult

from .application.agent_capabilities import AgentCapabilities
from .composition import build_services
from .domain.definitions import AcpError


class AcpRuntime(AgentRuntime):
    def __init__(self, config, host, profile, launch, *, preparation_driver=None):
        self.config, self.host, self.profile, self.launch = (
            config,
            host,
            profile,
            launch,
        )
        self.app, self.sync = build_services(
            config, host, profile, launch, preparation_driver=preparation_driver
        )

        self.agent_capabilities = AgentCapabilities(self.app)
        self.app.on_binding_changed = self._publish_session_capabilities

    @property
    def identity(self):
        return RuntimeIdentity(
            runtime="acp",
            runtime_version=self.launch.release_id,
            display_name=self.profile.title,
            runtime_id=self.config.runtime_id,
        )

    @property
    def sync_mode(self):
        return "events"

    async def start(self):
        self.app.restore()
        self.app.start_background()
        self.sync.start()

    async def stop(self):
        await self.app.stop()
        await self.sync.close()
        self.app.store.close()

    async def get_config(self):
        return self.config

    async def get_session_configuration(self, session_id):
        return self._configuration_view(session_id)

    def _configuration_view(self, session_id):
        self.app.store.require("binding", session_id)
        snapshot = self.app.configurations.snapshot(session_id)
        return {
            "configuration": {
                "revision": snapshot.revision,
                "options": list(snapshot.options),
            }
        }

    async def update_session_configuration(self, session_id, values):
        from .domain.definitions import fingerprint
        from .domain.operations import require_same_input

        key = fingerprint([session_id, values["operationId"]])
        digest = fingerprint(
            {"revision": values["expectedRevision"], "values": values["values"]}
        )
        previous = self.app.store.get("configuration_operation", key)
        if previous:
            require_same_input(previous["digest"], digest)
            return previous["result"]
        binding = self.app._binding(self.app.store.require("binding", session_id))
        binding.require_writable()
        snapshot = self.app.configurations.snapshot(session_id)
        if snapshot.revision != values["expectedRevision"]:
            raise RuntimeInvalidRequestError("配置已变化，请刷新后重新确认。")
        snapshot.validate(values["values"])
        context = self.app.sessions.get(session_id)
        if not context or context["closing"]:
            raise RuntimeInvalidRequestError("执行者已断开。")
        row = {
            "digest": digest,
            "result": {
                "operationId": values["operationId"],
                "phase": "outcome_unknown",
                **await self.get_session_configuration(session_id),
            },
        }
        with self.app.store.transaction():
            self.app.store.put("configuration_operation", key, row)
            self.app._save_binding(
                binding.observe(binding.connection_generation, foreground="running")
            )
        try:
            configuration = await self.app.configurations.update(
                session_id,
                context["agentSessionId"],
                context["client"],
                values["values"],
            )
            row["result"] = {
                "operationId": values["operationId"],
                "phase": "completed",
                "configuration": configuration,
            }
        finally:
            with self.app.store.transaction():
                row["result"].update(self._configuration_view(session_id))
                self.app.store.put("configuration_operation", key, row)
                current = self.app._binding(
                    self.app.store.require("binding", session_id)
                )
                if (
                    current.connection_generation == binding.connection_generation
                    and not context["closing"]
                ):
                    self.app._save_binding(
                        current.observe(
                            current.connection_generation,
                            foreground="idle"
                            if row["result"]["phase"] == "completed"
                            else "unknown",
                            attachment="attached"
                            if row["result"]["phase"] == "completed"
                            else "recovery_required",
                        )
                    )
        return row["result"]

    async def get_runtime_capabilities(self):
        return RuntimeCapabilitySet(
            runtime="acp",
            runtime_id=self.config.runtime_id,
            revision=1,
            capabilities=tuple(
                RuntimeCapability(
                    capability_id=key,
                    scope="runtime",
                    runtime="acp",
                    metadata={"workflowVersion": "1.2"},
                )
                for key in ("runtime.workspace.prepare", "runtime.session.async_create")
            ),
        )

    def _publish_session_capabilities(self, session_id):
        value = self._session_capabilities(session_id)
        self.app._emit("runtime.capability.updated", {
            "runtime": "acp", "runtimeId": self.config.runtime_id,
            "sessionId": session_id, "revision": value.revision,
            "capabilities": [{
                "capabilityId": item.capability_id, "scope": item.scope,
                "runtime": "acp", "runtimeId": self.config.runtime_id,
                "sessionId": session_id, "version": item.version,
                "supported": item.supported, "available": item.available,
                "allowed": item.allowed, "unavailableReason": item.unavailable_reason,
                "metadata": dict(item.metadata),
            } for item in value.capabilities],
        })

    async def get_session_capabilities(self, session_id, external_session_id=None):
        return self._session_capabilities(session_id)

    def _session_capabilities(self, session_id):
        state = self.app.state(session_id)
        live = self.app.sessions.get(session_id)
        ready = bool(live and not live["closing"])
        capabilities = [
            RuntimeCapability(
                capability_id="session.configuration.read",
                scope="session",
                runtime="acp",
                session_id=session_id,
            ),
            RuntimeCapability(
                capability_id="session.configuration.update",
                scope="session",
                runtime="acp",
                session_id=session_id,
                available=ready and state["status"] == "idle",
            ),
            RuntimeCapability(
                capability_id="session.send_message",
                scope="session",
                runtime="acp",
                session_id=session_id,
                available=ready and state["status"] == "idle",
            ),
            RuntimeCapability(
                capability_id="session.interrupt",
                scope="session",
                runtime="acp",
                session_id=session_id,
                available=ready and state["status"] == "running",
            ),
            RuntimeCapability(
                capability_id="session.close",
                scope="session",
                runtime="acp",
                session_id=session_id,
                available=ready,
            ),
            RuntimeCapability(
                capability_id="session.interaction.approval",
                scope="session",
                runtime="acp",
                session_id=session_id,
                available=ready,
            ),
        ]
        snapshot = self.app.configurations.snapshot(session_id)
        categories = {item.get("category") for item in snapshot.options}
        for category in ("model", "permission"):
            supported = category in categories
            capabilities.append(
                RuntimeCapability(
                    capability_id="catalog." + category,
                    scope="session",
                    runtime="acp",
                    session_id=session_id,
                    supported=supported,
                    available=supported and ready,
                )
            )
        for capability_id in ("session.commands", "runtime.attachment"):
            supported = self.agent_capabilities.supported(session_id, capability_id)
            capabilities.append(
                RuntimeCapability(
                    capability_id=capability_id,
                    scope="session",
                    runtime="acp",
                    session_id=session_id,
                    supported=supported,
                    available=supported and ready and state["status"] == "idle",
                    metadata={"maxFiles": 16, "maxBytes": 33554432}
                    if capability_id == "runtime.attachment"
                    else {},
                )
            )
        return RuntimeCapabilitySet(
            runtime="acp",
            session_id=session_id,
            revision=state["metadata"]["stateRevision"],
            capabilities=tuple(capabilities),
        )

    async def execute_workflow(self, request):
        values, method = dict(request.values), request.operation
        try:
            if method == "prepare":
                result = self.app.prepare(values)
            elif method in {"get_preparation", "refresh_preparation"}:
                result = self.app.preparation_view(values["preparationId"])
            elif method == "reserve":
                result = self.app.reserve(values)
            elif method == "begin_creation":
                result = self.app.begin(values)
            elif method == "get_creation":
                result = self.app.creation_view(values["createOperationId"])
            elif method in {"respond_preparation", "respond_creation"}:
                scope = values.get("preparationId", values.get("createOperationId"))
                result = self.app.interactions.respond(scope, values)
            elif method == "cancel_preparation":
                key = values["preparationId"]
                row = self.app.store.require("preparation", key)
                if row.get("create_operation_id"):
                    raise AcpError(
                        "preparation_consumed", "准备已绑定创建操作，请取消该操作。"
                    )
                with self.app.store.transaction():
                    row.update(phase="cancelled", revision=row["revision"] + 1)
                    self.app.store.put("preparation", key, row)
                if key in self.app.contexts:
                    await self.app._close_context(self.app.contexts[key])
                result = self.app.preparation_view(key)
            elif method == "cancel_initialization":
                key = values["createOperationId"]
                row = self.app.store.require("creation", key)
                context = self.app.sessions.get(row["session_id"])
                if context:
                    await self.app._close_context(context)
                with self.app.store.transaction():
                    row = self.app.store.require("creation", key)
                    if row["message_accepted"] is None:
                        row["phase"] = "outcome_unknown"
                        self.app.store.put("creation", key, row)
                result = self.app.creation_view(key)
            elif method == "close_session":
                result = await self.app.close_session(
                    values["sessionId"], values["ownerGeneration"]
                )
            elif method == "get_response":
                scope = values["scopeId"]
                rows = [
                    row
                    for row in self.app.store.values("interaction")
                    if row["scope_id"] == scope
                    and row.get("response_operation_id")
                    == values["responseOperationId"]
                ]
                result = {"disposition": "applied" if rows else "unknown"}
            else:
                raise RuntimeUnsupportedError(method)
            return RuntimeWorkflowResult(result)
        except AcpError as error:
            mapped = RuntimeUpstreamError(str(error))
            mapped.code = error.code
            raise mapped from error

    async def list_model_catalog(self, query=None, limit=100):
        return RuntimeModelCatalog(runtime="acp", revision=0, models=())

    async def list_permission_catalog(self, query=None, limit=100):
        return RuntimePermissionCatalog(
            runtime="acp",
            revision=1,
            permissions=tuple(
                RuntimePermissionItem(id=value, title=title, selection_id=value)
                for value, title in self.profile.permission_options
            ),
        )

    async def list_scoped_model_catalog(self, session_id, query=None, limit=100):
        snapshot = self.app.configurations.snapshot(session_id)
        models = []
        for option in snapshot.options:
            if option.get("category") == "model":
                for group in option.get("options", []):
                    models.extend(
                        RuntimeModelItem(
                            id=value["value"],
                            title=value["name"],
                            selection_id=value["value"],
                        )
                        for value in group.get("options", [group])
                    )
        return RuntimeModelCatalog(
            runtime="acp", revision=snapshot.revision, models=tuple(models[:limit])
        )

    async def list_sessions(self, limit=100, cursor=None, force=False):
        return tuple(
            SessionMeta(
                session_id=row["session_id"],
                external_session_id=row["agent_session_id"],
                runtime="acp",
                cwd=row["workspace"]["registered_path"],
            )
            for row in self.app.store.values("binding")[:limit]
        )

    async def get_session_state(self, session_id, external_session_id=None):
        value = self.app.state(session_id)
        return SessionState(
            session_id=session_id,
            external_session_id=value["externalSessionId"],
            runtime="acp",
            status=value["status"],
            status_reason=value["statusReason"],
            selections=value["selections"],
            metadata=value["metadata"],
        )

    async def get_session_snapshot(
        self, session_id, external_session_id=None, limit=None
    ):
        items = []
        for row in self.app.store.values("projection"):
            if row["sessionId"] == session_id:
                items.append(
                    RuntimeTimelineItem(
                        id=row["id"],
                        session_id=session_id,
                        type=row["type"],
                        role=row.get("role"),
                        status=row["status"],
                        order_seq=row["orderSeq"],
                        content_hash=row["contentHash"],
                        revision=row["revision"],
                        content=row["content"],
                        source=row["source"],
                    )
                )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="acp",
            items=tuple(
                sorted(items, key=lambda item: item.order_seq)[-(limit or 1000) :]
            ),
            complete=False,
        )

    async def get_session_notices(self, session_id, external_session_id=None):
        context = self.app.sessions.get(session_id)
        if not context:
            return ()
        return tuple(
            SessionNotice(
                notice_id=row["interactionId"],
                session_id=session_id,
                runtime="acp",
                type="interaction",
                title=row["title"],
                status="open" if row["status"] == "open" else "closed",
                interaction_type="approval"
                if row["kind"] == "approval"
                else "input_request",
                response_required=row["status"] == "open",
                actions=tuple(row["actions"]),
                metadata={
                    **row["metadata"],
                    "kind": row["kind"],
                    "ownerGeneration": row["ownerGeneration"],
                    "requestRevision": row["requestRevision"],
                },
            )
            for row in self.app.interactions.views(context["scopeId"])
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
        if (
            external_session_id
            != self.app.store.require("binding", session_id)["agent_session_id"]
        ):
            raise RuntimeInvalidRequestError("原生会话身份不匹配。")
        current = self.app.state(session_id)["selections"]
        changes = {
            key: value
            for key, value in (selections or {}).items()
            if value is not None and current.get(key) != value
        }
        if changes:
            updated = await self.update_session_selections(
                session_id, external_session_id, changes
            )
            if not updated.ok:
                return updated
        blocks = None
        if attachments:
            from .infrastructure.attachments import materialize

            if not self.agent_capabilities.supported(session_id, "runtime.attachment"):
                raise RuntimeInvalidRequestError("当前 Agent 不支持附件。")
            blocks = await materialize(
                self.host, session_id, attachments, self.app.root / "attachments"
            )
        result = await self.app.submit(
            session_id, client_message_id, content, blocks=blocks
        )
        return RuntimeOperationResult(
            ok=result["ok"], code=result.get("code"), result=result
        )

    async def list_commands(
        self, session_id, external_session_id=None, query=None, limit=50
    ):
        value = await self.agent_capabilities.invoke(
            session_id,
            "session.commands",
            "aa/list_commands",
            {},
            external_session_id=external_session_id,
        )
        return tuple(
            RuntimeCommand(
                id=item["name"],
                title=item["name"],
                description=item.get("description"),
                accepts_args=True,
                args_schema={"type": "string"},
                metadata={
                    "ui": {
                        "kind": "execute",
                        "acceptsMultiline": True,
                        "allowedStatuses": ["idle"],
                    }
                },
            )
            for item in value["commands"]
            if not query
            or query.casefold()
            in (item["name"] + " " + item.get("description", "")).casefold()
        )[:limit]

    async def execute_command(
        self, session_id, command, external_session_id=None, raw=None, args=()
    ):
        try:
            value = await self.agent_capabilities.invoke(
                session_id,
                "session.commands",
                "aa/execute_command",
                {"command": command, "raw": raw, "args": list(args)},
                writable=True,
                external_session_id=external_session_id,
            )
            return RuntimeCommandResult(
                command=command,
                ok=value["ok"],
                code=value.get("code"),
                message=value.get("message"),
                result=value.get("result", {}),
            )
        except AcpError as error:
            return RuntimeCommandResult(
                command=command, ok=False, code=error.code, message=str(error)
            )

    async def update_session_selections(
        self, session_id, external_session_id, selections
    ):
        self.agent_capabilities.context(session_id, external_session_id)
        snapshot = self.app.configurations.snapshot(session_id)
        values = {}
        for category, value in selections.items():
            if value is None:
                continue
            option = next(
                (item for item in snapshot.options if item.get("category") == category),
                None,
            )
            if option is None:
                raise RuntimeInvalidRequestError("当前 Agent 不支持此配置。")
            values[option["id"]] = value
        from uuid import uuid4

        result = await self.update_session_configuration(
            session_id,
            {
                "operationId": uuid4().hex,
                "expectedRevision": snapshot.revision,
                "values": values,
            },
        )
        return RuntimeOperationResult(ok=result["phase"] == "completed", result=result)

    async def interrupt_session(self, session_id, reason=None):
        context = self.app.sessions.get(session_id)
        if not context:
            raise RuntimeInvalidRequestError("执行者已断开。")
        await context["client"].interrupt(context["agentSessionId"])
        return RuntimeOperationResult(
            result={"interruptRequested": True, "executionStopped": False}
        )

    async def respond_interaction(
        self, session_id, notice_id, action_id, input_data=None
    ):
        context = self.app.sessions.get(session_id)
        if not context:
            raise RuntimeInvalidRequestError("执行者已断开。")
        data = dict(input_data or {})
        result = self.app.interactions.respond(
            context["scopeId"],
            {
                **data,
                "interactionId": notice_id,
                "actionId": action_id,
                "input": data.get("response"),
            },
        )
        return RuntimeOperationResult(result=result)

    async def resynchronize(self, session_id=None, external_session_id=None):
        rows = (
            [self.app.store.require("binding", session_id)]
            if session_id
            else self.app.store.values("binding")
        )
        with self.app.store.transaction():
            for row in rows:
                self.app._emit("session.meta.upsert", self.app.meta(row["session_id"]))
                self.app._emit(
                    "session.state.updated", self.app.state(row["session_id"])
                )
                self._publish_session_capabilities(row["session_id"])
        await self.sync.flush()

    async def sync_session_timeline(self, session_id, external_session_id=None):
        await self.resynchronize(session_id, external_session_id)
        return True

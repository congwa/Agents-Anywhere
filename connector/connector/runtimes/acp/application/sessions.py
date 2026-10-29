from __future__ import annotations

import asyncio
import time
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

from ..domain.definitions import AcpError, Workspace, fingerprint
from ..domain.operations import CreationOperation, PromptOperation, require_same_input
from ..domain.preparations import Preparation
from ..domain.sessions import SessionBinding
from .configuration import ConfigurationService
from .interactions import InteractionService
from .preparations import SessionPreparation
from .prompts import PromptService, prompt_digest


class SessionService:
    """Application coordinator. SDK callbacks never wait inside a transaction."""

    def __init__(
        self,
        store,
        profile,
        launch,
        client_factory,
        projection_factory,
        root: Path,
        *,
        max_workers=8,
        max_runs=4,
        max_run_seconds=600,
        preparation_driver=None,
    ):
        self.store, self.profile, self.launch = store, profile, launch
        self.client_factory, self.projection_factory, self.root = (
            client_factory,
            projection_factory,
            root,
        )
        self.max_workers, self.max_runs, self.max_run_seconds = (
            max_workers,
            max_runs,
            max_run_seconds,
        )
        self.contexts: dict[str, dict] = {}
        self.sessions: dict[str, dict] = {}
        self.tasks: set[asyncio.Task] = set()
        self.active_runs: set[str] = set()
        self.configurations = ConfigurationService(store)
        self.prompts = PromptService(store)
        self.interactions = InteractionService(store, self._notice)
        self.stopping = False
        self.on_binding_changed = None
        self.preparation_driver = preparation_driver or SessionPreparation()

    def start_background(self):
        self._job(self._maintain())

    async def _maintain(self):
        while not self.stopping:
            await self.expire_preparations()
            await asyncio.sleep(1)

    async def expire_preparations(self, now: float | None = None):
        current_time = time.time() if now is None else now
        expired = []
        with self.store.transaction():
            for row in self.store.values("preparation"):
                if (
                    row["phase"] in {"opening", "ready"}
                    and current_time >= row["expires_at"]
                    and not row.get("create_operation_id")
                ):
                    row.update(phase="expired", revision=row["revision"] + 1)
                    self.store.put("preparation", row["preparation_id"], row)
                    expired.append(row["preparation_id"])
        for key in expired:
            if key in self.contexts:
                await self._close_context(self.contexts[key])

    def _job(self, work):
        task = asyncio.create_task(work)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        # Application failures have durable outcomes; retrieve unexpected errors
        # without leaking raw Agent payloads through the event loop logger.
        task.add_done_callback(
            lambda done: done.exception() if not done.cancelled() else None
        )
        return task

    def _emit(self, method: str, params: dict):
        return self.store.emit(method, {**params, "runtime": "acp"})

    def _notice(self, context: dict, interaction):
        if not context.get("sessionId"):
            return
        view = next(
            item
            for item in self.interactions.views(interaction.scope_id)
            if item["interactionId"] == interaction.interaction_id
        )
        binding = self._binding(self.store.require("binding", context["sessionId"]))
        if (
            binding.connection_generation == context["generation"]
            and not context["closing"]
        ):
            waiting = any(
                row["status"] == "open"
                for row in self.interactions.views(context["scopeId"])
            )
            self._save_binding(
                binding.observe(
                    context["generation"],
                    foreground="requires_action"
                    if waiting
                    else "running"
                    if context["sessionId"] in self.active_runs
                    else "idle",
                )
            )
        self._emit(
            "notice.upsert",
            {
                "noticeId": view["interactionId"],
                "sessionId": context["sessionId"],
                "type": "interaction",
                "title": view["title"],
                "status": "open" if view["status"] == "open" else "closed",
                "interactionType": "approval"
                if interaction.kind == "permission"
                else "input_request",
                "responseRequired": view["status"] == "open",
                "actions": view["actions"],
                "context": {
                    "purpose": "tool_permission"
                    if interaction.kind == "permission"
                    else "form"
                },
                "metadata": {
                    **view["metadata"],
                    "ownerGeneration": view["ownerGeneration"],
                    "requestRevision": view["requestRevision"],
                    "kind": view["kind"],
                },
            },
        )

    def restore(self):
        with self.store.transaction():
            self.prompts.restore()
            for row in self.store.values("preparation"):
                if row["phase"] not in {"consumed", "cancelled", "expired"}:
                    row.update(phase="expired", revision=row["revision"] + 1)
                    self.store.put("preparation", row["preparation_id"], row)
                reservation = row.get("reservation")
                if (
                    reservation
                    and self.store.get("creation", reservation["createOperationId"])
                    is None
                ):
                    recovered = asdict(
                        CreationOperation(
                            reservation["createOperationId"],
                            reservation["platformSessionId"],
                            "",
                            phase="rejected",
                            platform_session_created=None,
                            agent_session_created=True
                            if row.get("agentSessionId")
                            else None,
                            message_accepted=False,
                        )
                    )
                    recovered.update(
                        recoveredBeforeSubmission=True,
                        failure={
                            "code": "initialization_interrupted",
                            "message": "准备执行者已退出，首条消息未提交，请重新准备。",
                        },
                    )
                    self.store.put("creation", recovered["operation_id"], recovered)
            for row in self.store.values("creation"):
                if row["phase"] not in {"accepted", "rejected", "cancelled", "failed"}:
                    prompt = (
                        self.store.get(
                            "prompt",
                            fingerprint(
                                [row["session_id"], row.get("client_message_id")]
                            ),
                        )
                        if row.get("client_message_id")
                        else None
                    )
                    if row.get("client_message_id") and prompt is None:
                        row.update(
                            phase="rejected",
                            message_accepted=False,
                            failure={
                                "code": "initialization_interrupted",
                                "message": "初始化执行者已退出，首条消息尚未提交。",
                            },
                        )
                    else:
                        row.update(
                            phase=prompt["phase"] if prompt else "outcome_unknown",
                            message_accepted=prompt["message_accepted"]
                            if prompt
                            else None,
                        )
                    self.store.put("creation", row["operation_id"], row)
            for row in self.store.values("interaction"):
                if row["status"] == "open":
                    row.update(status="cancelled", revision=row["revision"] + 1)
                    self.store.put("interaction", row["interaction_id"], row)
            for row in self.store.values("binding"):
                binding = self._binding(row).interrupted()
                self._save_binding(binding)

    @staticmethod
    def _binding(row: dict) -> SessionBinding:
        return SessionBinding(**{**row, "workspace": Workspace(**row["workspace"])})

    def _save_binding(self, binding: SessionBinding):
        self.store.put("binding", binding.session_id, asdict(binding))
        self._emit("session.state.updated", self.state(binding.session_id))
        if self.on_binding_changed is not None:
            self.on_binding_changed(binding.session_id)

    def state(self, session_id: str) -> dict:
        row = self.store.require("binding", session_id)
        status = (
            "blocked"
            if row["attachment"] in {"opening", "recovery_required", "detached"}
            else {
                "unknown": "blocked",
                "requires_action": "waiting_approval",
                "cancelling": "stopping",
            }.get(row["foreground"], row["foreground"])
        )
        return {
            "sessionId": session_id,
            "externalSessionId": row["agent_session_id"],
            "runtime": "acp",
            "status": status,
            "statusReason": "agent_recovery_required" if status == "blocked" else None,
            "metadata": {
                "ownerGeneration": row["owner_generation"],
                "connectionGeneration": row["connection_generation"],
                "componentReleaseId": row["release_id"],
                "stateRevision": row["revision"],
            },
            "selections": {
                option["category"]: option["currentValue"]
                for option in self.configurations.snapshot(session_id).options
                if option.get("category") in {"model", "permission"}
                and isinstance(option.get("currentValue"), str)
            },
        }

    def meta(self, session_id: str) -> dict:
        row = self.store.require("binding", session_id)
        return {
            "sessionId": session_id,
            "externalSessionId": row["agent_session_id"],
            "cwd": row["workspace"]["registered_path"],
            "metadata": {
                "agentProfileId": row["profile_id"],
                "componentReleaseId": row["release_id"],
                "origin": "managed_acp",
            },
        }

    def _new_context(self, scope_id: str, workspace: Workspace) -> dict:
        if self.stopping:
            raise AcpError("runtime_stopping", "Runtime 正在关闭。")
        if len(self.contexts) >= self.max_workers:
            raise AcpError("worker_capacity", "Agent 执行进程已达到上限。")
        context = {
            "scopeId": scope_id,
            "generation": uuid4().hex,
            "workspace": workspace,
            "closing": False,
        }
        with self.store.transaction():
            self.store.put(
                "executor_reference",
                context["generation"],
                {
                    "releaseId": self.launch.release_id,
                    "scopeId": scope_id,
                },
            )
        context["client"] = self.client_factory(
            lambda agent_id, update: self._update(context, agent_id, update),
            lambda agent_id, kind, request: self.interactions.open(
                context, agent_id, kind, request
            ),
        )
        self.contexts[scope_id] = context
        return context

    def prepare(self, values: dict) -> dict:
        key = values["preparationId"]
        digest = fingerprint(
            {
                "cwd": values["cwd"],
                "clientPreparationId": values.get("clientPreparationId"),
            }
        )
        previous = self.store.get("preparation", key)
        if previous:
            require_same_input(previous["input_digest"], digest)
            return self.preparation_view(key)
        original = Path(values["cwd"])
        if not original.is_absolute() or not original.is_dir():
            raise AcpError("invalid_cwd", "请选择存在的绝对工作目录。")
        workspace = Workspace(str(original), str(original.resolve(strict=True)))
        context = self._new_context(key, workspace)
        row = Preparation(key, workspace, digest, time.time() + 300)
        with self.store.transaction():
            self.store.put("preparation", key, asdict(row))
        self._job(self._open_preparation(context, row))
        return self.preparation_view(key)

    async def _open_preparation(self, context: dict, preparation: Preparation):
        try:
            await context["client"].start(self.launch, str(self.root))
            process = context["client"].process.process
            self._job(self._watch(context, process))
            result = await self.preparation_driver.prepare(context)
            known = context.get("provisionalAgentSessionId")
            if known and known != result["sessionId"]:
                raise AcpError(
                    "agent_session_mismatch", "创建返回的会话身份与初始化交互不一致。"
                )
            if context["closing"]:
                return
            context["agentSessionId"] = result["sessionId"]
            context["deferredSession"] = result.get("deferred", False)
            context["preparationTicket"] = result.get("ticket")
            with self.store.transaction():
                self.configurations.observe(
                    preparation.preparation_id, result.get("configOptions", [])
                )
                current = self.store.require("preparation", preparation.preparation_id)
                current.update(
                    phase="ready",
                    revision=current["revision"] + 1,
                    agentSessionId=result["sessionId"],
                )
                self.store.put("preparation", preparation.preparation_id, current)
        except Exception as error:  # noqa: BLE001 -- external Agent boundary preserves unknown outcomes
            with self.store.transaction():
                current = self.store.require("preparation", preparation.preparation_id)
                if current["phase"] not in {"cancelled", "expired"}:
                    current.update(
                        phase="outcome_unknown",
                        revision=current["revision"] + 1,
                        failure={
                            "code": getattr(error, "code", "agent_open_failed"),
                            "message": "Agent 初始化未完成，请查询原操作。",
                        },
                    )
                    self.store.put("preparation", preparation.preparation_id, current)
            await self._close_context(context)

    def preparation_view(self, key: str) -> dict:
        row = self.store.require("preparation", key)
        options = self.configurations.snapshot(key)
        models = []
        for option in options.options:
            if option.get("category") == "model" and option.get("type") == "select":
                for choice in option.get("options", []):
                    for value in choice.get("options", [choice]):
                        models.append(
                            {
                                "id": value["value"],
                                "selectionId": value["value"],
                                "title": value["name"],
                                "reasoningItems": [],
                                "enabled": True,
                            }
                        )
        return {
            "preparationId": key,
            "phase": row["phase"],
            "revision": row["revision"],
            "catalogRevision": options.revision,
            "catalog": {
                "runtime": "acp",
                "revision": options.revision,
                "models": models,
            },
            "configuration": {
                "revision": options.revision,
                "options": list(options.options),
            },
            "interactions": self.interactions.views(key),
            "canRespond": key in self.contexts,
            "canCancel": row["phase"] in {"opening", "ready"},
            "failure": row.get("failure"),
            "expiresAt": row["expires_at"],
            "cwd": row["workspace"]["registered_path"],
        }

    def reserve(self, values: dict) -> dict:
        try:
            row = self.store.require("preparation", values["preparationId"])
            reservation = {
                key: values.get(key, {})
                for key in (
                    "createOperationId",
                    "platformSessionId",
                    "selections",
                    "configuration",
                )
            }
            if row.get("reservation"):
                require_same_input(
                    fingerprint(row["reservation"]), fingerprint(reservation)
                )
                return {"reserved": True}
            preparation = Preparation(
                **{
                    key: value
                    for key, value in row.items()
                    if key in Preparation.__dataclass_fields__ and key != "workspace"
                },
                workspace=Workspace(**row["workspace"]),
            )
            snapshot = self.configurations.snapshot(values["preparationId"])
            if snapshot.revision != values["catalogRevision"]:
                raise AcpError("preparation_stale", "工作区配置已变化，请重新确认。")
            snapshot.merge_legacy(
                values.get("configuration", {}), values.get("selections", {})
            )
            reserved = preparation.reserve(
                values["createOperationId"], values["expectedRevision"], time.time()
            )
            context = self.contexts.get(values["preparationId"])
            if (
                not context
                or context.get("closing")
                or not context.get("agentSessionId")
            ):
                raise AcpError("preparation_stale", "准备所持有的 Agent 已退出。")
            with self.store.transaction():
                self.store.put(
                    "preparation",
                    preparation.preparation_id,
                    {**row, **asdict(reserved), "reservation": reservation},
                )
            return {"reserved": True}
        except AcpError as error:
            return {
                "reserved": False,
                "failure": {"code": error.code, "message": str(error)},
            }

    def begin(self, values: dict) -> dict:
        operation_id = values["createOperationId"]
        digest = fingerprint(values)
        previous = self.store.get("creation", operation_id)
        if previous:
            if previous.get("recoveredBeforeSubmission"):
                if previous["session_id"] != values["sessionId"]:
                    raise AcpError(
                        "operation_input_conflict", "创建操作已绑定其他平台会话。"
                    )
                return self.creation_view(operation_id)
            require_same_input(previous["input_digest"], digest)
            return self.creation_view(operation_id)
        preparation_id = values["preparationId"]
        preparation = self.store.require("preparation", preparation_id)
        reservation = preparation.get("reservation", {})
        if (
            reservation.get("createOperationId") != operation_id
            or reservation.get("platformSessionId") != values["sessionId"]
        ):
            raise AcpError("preparation_not_reserved", "准备尚未为当前创建操作预留。")
        for key in ("configuration", "selections"):
            require_same_input(
                fingerprint(reservation.get(key, {})), fingerprint(values.get(key, {}))
            )
        context = self.contexts.get(preparation_id)
        if not context or context.get("closing"):
            raise AcpError(
                "operation_outcome_unknown", "准备执行者已退出，请查询原操作。"
            )
        context.update(scopeId=operation_id, sessionId=values["sessionId"])
        context["projection"] = self.projection_factory(
            values["sessionId"], context["generation"]
        )
        self.sessions[values["sessionId"]] = context
        operation = CreationOperation(
            operation_id,
            values["sessionId"],
            digest,
            phase="opening" if context.get("deferredSession") else "submitting",
            agent_session_created=None if context.get("deferredSession") else True,
            client_message_id=values["clientMessageId"],
        )
        binding = SessionBinding(
            values["sessionId"],
            self.profile.id,
            self.launch.release_id,
            context["workspace"],
            context["generation"],
            context["generation"],
            context["agentSessionId"],
            attachment="opening" if context.get("deferredSession") else "attached",
            foreground="idle",
        )
        with self.store.transaction():
            self.store.put("creation", operation_id, asdict(operation))
            preparation.update(phase="consumed", revision=preparation["revision"] + 1)
            self.store.put("preparation", preparation_id, preparation)
            self.store.put(
                "configuration",
                binding.session_id,
                asdict(self.configurations.snapshot(preparation_id)),
            )
            self.store.put("binding", binding.session_id, asdict(binding))
            self._emit("session.meta.upsert", self.meta(binding.session_id))
            self._save_binding(binding)
        self._job(self._begin_prompt(context, values))
        return self.creation_view(operation_id)

    async def _begin_prompt(self, context: dict, values: dict):
        try:
            if context.get("deferredSession"):
                result = await self.preparation_driver.activate(
                    context, values["sessionId"]
                )
                if (
                    context["closing"]
                    or result["sessionId"] != context["agentSessionId"]
                ):
                    raise AcpError(
                        "agent_session_mismatch", "正式会话与准备身份不一致。"
                    )
                context["deferredSession"] = False
                with self.store.transaction():
                    row = self.store.require("creation", values["createOperationId"])
                    row.update(agent_session_created=True, phase="submitting")
                    self.store.put("creation", row["operation_id"], row)
                    binding = self._binding(
                        self.store.require("binding", values["sessionId"])
                    )
                    self._save_binding(
                        binding.observe(context["generation"], attachment="attached")
                    )
            configured = self.configurations.snapshot(values["sessionId"]).merge_legacy(
                values.get("configuration", {}),
                values.get("selections", {}),
            )
            await self.configurations.update(
                values["sessionId"],
                context["agentSessionId"],
                context["client"],
                configured,
            )
            await self.submit(
                values["sessionId"],
                values["clientMessageId"],
                values["content"],
                creation_id=values["createOperationId"],
            )
        except Exception as error:  # noqa: BLE001 -- configuration boundary precedes prompt dispatch
            with self.store.transaction():
                row = self.store.require("creation", values["createOperationId"])
                row.update(
                    phase="rejected",
                    message_accepted=False,
                    failure={
                        "code": getattr(error, "code", "agent_configuration_failed"),
                        "message": "配置或提交尚未完成，请查询操作。",
                    },
                )
                self.store.put("creation", row["operation_id"], row)
                binding = self._binding(
                    self.store.require("binding", values["sessionId"])
                )
                if binding.connection_generation == context["generation"]:
                    self._save_binding(binding.interrupted())
            await self._close_context(context)

    def creation_view(self, key: str) -> dict:
        row = self.store.require("creation", key)
        return {
            "createOperationId": key,
            "revision": row.get("revision", 1),
            "platformSessionId": row["session_id"],
            "phase": row["phase"],
            "platformSessionCreated": row["platform_session_created"],
            "created": row["agent_session_created"],
            "messageAccepted": row["message_accepted"],
            "interactions": self.interactions.views(key),
            "canRespond": row["session_id"] in self.sessions,
            "canCancelInitialization": row["phase"] in {"opening", "submitting"},
            "failure": row.get("failure"),
        }

    async def submit(
        self,
        session_id: str,
        message_id: str,
        content: str,
        *,
        creation_id: str | None = None,
        blocks=None,
    ) -> dict:
        if not message_id:
            raise AcpError("message_identity_required", "消息需要稳定身份。")
        with self.store.transaction():
            previous = self.store.get("prompt", fingerprint([session_id, message_id]))
            if previous:
                require_same_input(
                    previous["input_digest"],
                    prompt_digest(session_id, content, blocks),
                )
                return {
                    "ok": previous["message_accepted"] is True,
                    "messageAccepted": previous["message_accepted"],
                    "phase": previous["phase"],
                }
            binding = self._binding(self.store.require("binding", session_id))
            binding.require_writable()
            context = self.sessions.get(session_id)
            if not context or context["closing"]:
                raise AcpError("agent_recovery_required", "会话执行者需要恢复。")
            if len(self.active_runs) >= self.max_runs:
                raise AcpError("run_capacity", "并发执行已达到上限。")
            operation, _ = self.prompts.prepare(session_id, message_id, content, blocks)
            self.active_runs.add(session_id)
            self._save_binding(
                binding.observe(binding.connection_generation, foreground="running")
            )
        self._job(self._run_prompt(context, operation, content, creation_id, blocks))
        return {
            "ok": False,
            "code": "operation_pending",
            "messageAccepted": None,
            "phase": "dispatching",
            "clientMessageId": message_id,
        }

    async def _run_prompt(self, context, operation, content, creation_id, blocks=None):
        failed = False
        stop_reason = None
        try:
            if context["closing"]:
                operation = operation.reject_before_dispatch()
                stop_reason = "cancelled"
                return
            result = await asyncio.wait_for(
                context["client"].prompt(
                    context["agentSessionId"],
                    content,
                    operation.operation_id,
                    **({"blocks": blocks} if blocks else {}),
                ),
                self.max_run_seconds,
            )
            stop_reason = result["stopReason"]
            operation = operation.accept("v1_prompt_completed")
        except asyncio.CancelledError:
            failed = True
            operation = operation.lose_connection()
            raise
        except Exception:  # noqa: BLE001 -- v1 errors do not establish pre-insertion rejection
            failed = True
            operation = operation.lose_connection()
        finally:
            session_id = operation.session_id
            with self.store.transaction():
                saved = self.store.get(
                    "prompt", fingerprint([session_id, operation.operation_id])
                )
                if saved and saved["message_accepted"] is not None:
                    operation = PromptOperation(**saved)
                self.prompts.save(operation)
                if creation_id:
                    row = self.store.require("creation", creation_id)
                    row.update(
                        phase=operation.phase,
                        message_accepted=operation.message_accepted,
                    )
                    self.store.put("creation", creation_id, row)
                current = self._binding(self.store.require("binding", session_id))
                if (
                    current.connection_generation == context["generation"]
                    and not context["closing"]
                ):
                    self._save_binding(
                        current.observe(
                            context["generation"],
                            foreground="unknown" if failed else "idle",
                            attachment="recovery_required" if failed else "attached",
                        )
                    )
                    for item in context["projection"].finish():
                        self.store.put("projection", item["id"], item)
                        self._emit(
                            "timeline.itemUpsert",
                            {
                                "sessionId": session_id,
                                "externalSessionId": context["agentSessionId"],
                                "item": item,
                            },
                        )
                    self._emit(
                        "session.turnEnded",
                        {
                            "sessionId": session_id,
                            "externalSessionId": context["agentSessionId"],
                            "turnId": operation.operation_id,
                            "outcome": "failed"
                            if failed
                            else "cancelled"
                            if stop_reason == "cancelled"
                            else "completed",
                            "metadata": {
                                "sourceEventId": fingerprint(
                                    [session_id, operation.operation_id, "ended"]
                                )
                            },
                        },
                    )
            if failed:
                await self._close_context(context)
            elif creation_id and operation.message_accepted is True:
                context["scopeId"] = session_id
            self.active_runs.discard(session_id)

    async def _update(self, context: dict, agent_id: str, update: dict):
        if context["closing"]:
            return
        known = context.get("agentSessionId") or context.get(
            "provisionalAgentSessionId"
        )
        if known and known != agent_id:
            raise AcpError("agent_session_mismatch", "事件来源与会话绑定不一致。")
        context["provisionalAgentSessionId"] = agent_id
        with self.store.transaction():
            scope_id = context.get("sessionId", context["scopeId"])
            if update.get("sessionUpdate") == "config_option_update":
                self.configurations.observe(scope_id, update.get("configOptions", []))
            if not context.get("sessionId"):
                return
            binding = self._binding(self.store.require("binding", context["sessionId"]))
            if binding.connection_generation != context["generation"]:
                return
            if update.get("sessionUpdate") == "aa_operation_update":
                receipt = update["receipt"]
                if (
                    receipt.get("ownerGeneration") != context["generation"]
                    or receipt.get("sessionId") != context["sessionId"]
                ):
                    raise AcpError("owner_changed", "接纳回执的执行者已变化。")
                key = fingerprint([context["sessionId"], receipt["clientMessageId"]])
                operation = PromptOperation(**self.store.require("prompt", key))
                accepted = receipt.get("messageAccepted")
                if type(accepted) is bool:
                    self.prompts.save(
                        operation.accept("agent_durable_receipt")
                        if accepted
                        else operation.reject("agent_durable_receipt")
                    )
                    for creation in self.store.values("creation"):
                        if (
                            creation["session_id"] == context["sessionId"]
                            and creation.get("client_message_id")
                            == operation.operation_id
                        ):
                            creation.update(
                                phase="accepted" if accepted else "rejected",
                                message_accepted=accepted,
                            )
                            self.store.put(
                                "creation", creation["operation_id"], creation
                            )
                return
            item = context["projection"].apply(update)
            if item:
                self.store.put("projection", item["id"], item)
                self._emit(
                    "timeline.itemUpsert",
                    {
                        "sessionId": context["sessionId"],
                        "externalSessionId": agent_id,
                        "item": item,
                    },
                )

    async def _watch(self, context, process):
        await process.wait()
        if context["closing"]:
            return
        with self.store.transaction():
            self.interactions.close_scope(context["scopeId"])
            session_id = context.get("sessionId")
            if session_id:
                binding = self._binding(self.store.require("binding", session_id))
                if binding.connection_generation == context["generation"]:
                    self._save_binding(binding.interrupted())
        await self._close_context(context)

    async def _close_context(self, context):
        if context.get("closeTask"):
            await asyncio.shield(context["closeTask"])
            return
        context["closing"] = True

        async def close():
            with self.store.transaction():
                self.interactions.close_scope(context["scopeId"])
            try:
                if context.get("agentSessionId"):
                    await context["client"].close_session(context["agentSessionId"])
            except Exception:  # noqa: BLE001 -- force process cleanup after protocol close failure
                context["closeProtocolFailed"] = True
            finally:
                await context["client"].close()
                with self.store.transaction():
                    self.store.delete("executor_reference", context["generation"])
                for key, value in list(self.contexts.items()):
                    if value is context:
                        self.contexts.pop(key, None)
                if context.get("sessionId"):
                    self.sessions.pop(context["sessionId"], None)

        context["closeTask"] = asyncio.create_task(close())
        await asyncio.shield(context["closeTask"])

    async def close_session(self, session_id: str, owner_generation: str) -> dict:
        binding = self._binding(self.store.require("binding", session_id))
        if binding.owner_generation != owner_generation:
            raise AcpError("owner_changed", "关闭操作所属执行者已变化。")
        context = self.sessions.get(session_id)
        if context:
            with self.store.transaction():
                self._save_binding(
                    binding.observe(binding.connection_generation, attachment="closing")
                )
            await self._close_context(context)
        with self.store.transaction():
            current = self._binding(self.store.require("binding", session_id))
            if current.owner_generation == owner_generation:
                self._save_binding(
                    current.observe(
                        current.connection_generation,
                        attachment="detached",
                        foreground="unknown",
                    )
                )
        return {"ok": True, "closed": True}

    async def stop(self):
        self.stopping = True
        await asyncio.gather(
            *(self._close_context(context) for context in list(self.contexts.values())),
            return_exceptions=True,
        )
        pending = list(self.tasks)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

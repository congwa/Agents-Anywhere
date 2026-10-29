from __future__ import annotations

from pathlib import Path

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInvalidRequestError,
    RuntimeProvider,
    RuntimeTypeDescriptor,
    RuntimeUnavailableError,
)

from .profiles.pi import PI_PROFILE


class AcpProvider(RuntimeProvider):
    runtime_type = "acp"
    display_name = "ACP Agents"
    implementation_type = "acp-stdio"
    instance_policy = "multiple"

    def __init__(self):
        self._component_services = {}

    def _components(self, host):
        import hashlib

        from .application.components import ComponentService
        from .infrastructure.artifacts import Artifacts
        from .infrastructure.persistence import Store
        from .infrastructure.releases import TRUSTED_RELEASE_KEYS, ReleaseFeed

        key = f"{host.session_namespace}:{host.runtime_id}"
        if key not in self._component_services:
            root = (
                host.runtime_kv.path.parent
                / "acp"
                / hashlib.sha256(key.encode()).hexdigest()
            )
            store = Store(root / "coordination.sqlite")
            artifacts = Artifacts(root / "releases", TRUSTED_RELEASE_KEYS)
            self._component_services[key] = ComponentService(
                store, artifacts, ReleaseFeed(artifacts), profile_ids={PI_PROFILE.id}
            )
        return self._component_services[key]

    async def manage_components(self, host, values):
        return await self._components(host).execute(dict(values))

    async def get_config_schema(self):
        return RuntimeConfigSchema(
            runtime="acp",
            revision=1,
            schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "agentProfileId": {"const": "pi"},
                    "agentDir": {"type": "string", "minLength": 1},
                    "componentReleaseId": {
                        "type": "string",
                        "pattern": "^[0-9a-f]{64}$",
                    },
                    "maxWorkers": {"type": "integer", "minimum": 1, "maximum": 32},
                    "maxConcurrentRuns": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 16,
                    },
                    "maxRunMs": {
                        "type": "integer",
                        "minimum": 10000,
                        "maximum": 3600000,
                    },
                },
            },
            defaults={
                "agentProfileId": "pi",
                "agentDir": str(Path.home() / ".pi" / "agent"),
                "maxWorkers": 8,
                "maxConcurrentRuns": 4,
                "maxRunMs": 600000,
            },
            metadata={"releaseGate": PI_PROFILE.unavailable_reason},
        )

    async def discover(self):
        from .domain.capabilities import verified_release

        available = False
        installation_error = None
        for service in self._component_services.values():
            for installed in service.store.values("installation"):
                if verified_release(PI_PROFILE, installed["manifest"]):
                    try:
                        service.artifacts.verify_installed(installed)
                    except Exception as error:  # noqa: BLE001 -- damaged installation remains unavailable
                        installation_error = getattr(error, "code", "component_invalid")
                    else:
                        available = True
        return RuntimeTypeDescriptor(
            runtime_type="acp",
            display_name="ACP Agents",
            available=available,
            reason=None
            if available
            else "AA Pi ACP 固定组件及三平台、四端统一验收尚未完成。",
            implementation_type=self.implementation_type,
            instance_policy="multiple",
            config_schema=await self.get_config_schema(),
            capabilities={"workspacePreparation": True, "asyncCreation": True}
            if available
            else {},
            metadata={
                "releaseGate": PI_PROFILE.unavailable_reason,
                "installationError": installation_error,
                "agentProfiles": [
                    {"id": "pi", "displayName": "Pi", "available": available}
                ],
            },
        )

    async def validate_config(self, values):
        schema = await self.get_config_schema()
        errors = list(Draft202012Validator(schema.schema).iter_errors(dict(values)))
        if errors:
            raise RuntimeInvalidRequestError(errors[0].message)
        normalized = {**schema.defaults, **values}
        if normalized["maxConcurrentRuns"] > normalized["maxWorkers"]:
            raise RuntimeInvalidRequestError("并发运行数不能超过执行进程数。")
        return RuntimeConfig(
            runtime="acp",
            revision=1,
            values=normalized,
            schema=schema.schema,
            metadata=schema.metadata,
        )

    async def create_runtime(self, config, host):
        import sys

        from .domain.capabilities import verified_release
        from .domain.definitions import LaunchDefinition
        from .profiles.pi.preparation import PiPreparation
        from .runtime import AcpRuntime

        components = self._components(host)
        selected = config.values.get("componentReleaseId")
        if selected is None:
            selected = (
                components.store.get("active_component", PI_PROFILE.id) or {}
            ).get("releaseId")
        installed = components.store.get("installation", selected) if selected else None
        if not installed:
            raise RuntimeUnavailableError("AA Pi ACP 尚未安装通过统一验收的固定组件。")
        components.artifacts.verify_installed(installed)
        manifest = installed["manifest"]
        if not verified_release(PI_PROFILE, manifest):
            raise RuntimeUnavailableError(
                "AA Pi ACP 组件缺少三平台、四端或执行保证的签名验收记录。"
            )
        root = Path(installed["path"])
        launcher = manifest["launcher"]
        arguments = tuple(
            arg.replace("${COMPONENT_ROOT}", str(root)) for arg in launcher["arguments"]
        )
        state_root = components.artifacts.root.parent / "agent-state"
        launch = LaunchDefinition(
            str(root / launcher["executable"]),
            arguments
            + (
                "--agent-dir",
                config.values["agentDir"],
                "--state-dir",
                str(state_root),
                "--runtime-id",
                config.runtime_id,
                "--python",
                sys.executable,
            ),
            selected,
        )
        return AcpRuntime(
            config, host, PI_PROFILE, launch, preparation_driver=PiPreparation()
        )

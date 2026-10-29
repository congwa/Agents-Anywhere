from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInvalidRequestError,
    RuntimeProvider,
    RuntimeResourceClaim,
    RuntimeSourceKey,
    RuntimeTypeDescriptor,
    RuntimeUnavailableError,
)
from connector.runtime_protocol.filesystem import filesystem_resource_key
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.pi.environment import (
    default_artifact_directory,
    resolve_environment,
)


def config_schema() -> RuntimeConfigSchema:
    return RuntimeConfigSchema(
        runtime="pi",
        revision=1,
        schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                **{
                    key: {"type": "string", "minLength": 1}
                    for key in ("runtimeDirectory", "nodePath", "agentDir")
                },
                "maxWorkers": {"type": "integer", "minimum": 1, "maximum": 32},
                "maxConcurrentRuns": {"type": "integer", "minimum": 1, "maximum": 16},
                "maxRunMs": {"type": "integer", "minimum": 10000, "maximum": 3600000},
                "preparationTtlMs": {
                    "type": "integer",
                    "minimum": 30000,
                    "maximum": 600000,
                },
            },
        },
        defaults={
            "runtimeDirectory": str(default_artifact_directory()),
            "agentDir": str(Path.home() / ".pi" / "agent"),
            "maxWorkers": 8,
            "maxConcurrentRuns": 4,
            "maxRunMs": 600000,
            "preparationTtlMs": 300000,
        },
        metadata={"workspacePreparation": True, "asyncCreation": True},
    )


class PiProvider(RuntimeProvider):
    runtime_type = "pi"
    display_name = "pi"
    implementation_type = "isolated-sdk"
    description = "pi SDK：独立进程、工作区准备与远程审批"

    async def discover(self) -> RuntimeTypeDescriptor:
        available, reason = True, None
        try:
            await resolve_environment(dict(config_schema().defaults))
        except RuntimeUnavailableError as error:
            available, reason = False, str(error)
        return RuntimeTypeDescriptor(
            runtime_type="pi",
            display_name="pi",
            available=available,
            reason=reason,
            implementation_type=self.implementation_type,
            config_schema=config_schema(),
            capabilities={"workspacePreparation": True, "asyncCreation": True},
            metadata={
                "storageMode": "pi-native",
                "sdkVersion": "1.4.0",
                "strictSelectionEnforced": True,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return config_schema()

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        schema = config_schema()
        errors = list(Draft202012Validator(schema.schema).iter_errors(dict(values)))
        if errors:
            raise RuntimeInvalidRequestError(errors[0].message)
        normalized = {**schema.defaults, **values}
        if normalized["maxConcurrentRuns"] > normalized["maxWorkers"]:
            raise RuntimeInvalidRequestError("并发运行数不能超过 worker 数。")
        return RuntimeConfig(
            runtime="pi",
            revision=1,
            values=normalized,
            schema=schema.schema,
            metadata=schema.metadata,
        )

    async def create_runtime(self, config: RuntimeConfig, host: RuntimeHostClient):
        from connector.runtimes.pi.runtime import PiRuntime

        return PiRuntime(
            replace(config, runtime_id=host.runtime_id or config.runtime_id), host
        )

    def resource_claims(
        self, config: RuntimeConfig
    ) -> tuple[RuntimeResourceClaim, ...]:
        return (
            RuntimeResourceClaim(
                kind="pi-host", key="connector-local-pi-host", label="pi Host"
            ),
        )

    def session_source_key(self, config: RuntimeConfig) -> RuntimeSourceKey:
        return RuntimeSourceKey(
            kind="pi-agent-dir",
            key=filesystem_resource_key(str(config.values["agentDir"])),
        )

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform as machine_platform
import re
import sys
from pathlib import Path
from typing import Any

from connector.paths import connector_data_dir
from connector.runtime_protocol.errors import RuntimeUnavailableError


def default_artifact_directory() -> Path:
    configured = os.environ.get("AA_PI_RUNTIME_ARTIFACT")
    if configured:
        return Path(configured).expanduser()
    bundled = Path(__file__).resolve().parents[4] / "pi-runtime" / "artifact"
    if (bundled / "manifest.json").is_file() or (bundled.parent / "package.json").is_file():
        return bundled
    return connector_data_dir() / "runtimes" / "pi" / "artifact"


def _artifact(values: dict[str, Any]) -> tuple[Path, Path, Path, dict[str, Any]]:
    directory = (
        Path(values.get("runtimeDirectory") or default_artifact_directory())
        .expanduser()
        .resolve()
    )
    try:
        manifest = json.loads((directory / "manifest.json").read_text())
        if not isinstance(manifest, dict):
            raise TypeError("产物清单无效")
        if manifest.get("sdkVersion") != "1.4.0":
            raise ValueError("SDK 版本不兼容")
        platform = {"darwin": "darwin", "linux": "linux", "win32": "win32"}.get(
            sys.platform
        )
        architecture = {
            "arm64": "arm64",
            "aarch64": "arm64",
            "x86_64": "x64",
            "AMD64": "x64",
        }.get(machine_platform.machine())
        if manifest.get("arch") != architecture:
            raise ValueError("运行产物 CPU 架构不匹配")
        if platform != manifest.get("platform"):
            raise ValueError("运行产物平台不匹配")
        node = (
            Path(values.get("nodePath") or directory / manifest["node"])
            .expanduser()
            .resolve()
        )
        entry = (directory / manifest["entry"]).resolve()
        if (
            not entry.is_relative_to(directory)
            or not node.is_file()
            or not entry.is_file()
        ):
            raise ValueError("运行产物不完整")
        # Native executable only: do not recursively execute shell/version-manager shims.
        with node.open("rb") as handle:
            magic = handle.read(4)
        if not (
            magic.startswith((b"\x7fELF", b"MZ"))
            or magic in {b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe"}
        ):
            raise ValueError("Node 路径必须是原生可执行文件")
        checksums = manifest.get("checksums")
        if (
            not isinstance(checksums, dict)
            or manifest["entry"] not in checksums
            or manifest["node"] not in checksums
        ):
            raise ValueError("缺少产物完整性记录")
        for relative, expected in checksums.items():
            path = (directory / relative).resolve()
            if (
                not path.is_relative_to(directory)
                or hashlib.sha256(path.read_bytes()).hexdigest() != expected
            ):
                raise ValueError("运行产物校验失败")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RuntimeUnavailableError(f"pi 环境未就绪：{error}") from error
    return directory, node, entry, manifest


async def resolve_environment(values: dict[str, Any]) -> dict[str, Any]:
    directory, node, entry, manifest = await asyncio.to_thread(_artifact, values)
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("NODE_", "ELECTRON_"))
    }
    try:
        process = await asyncio.create_subprocess_exec(
            str(node),
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
        )
    except OSError as error:
        raise RuntimeUnavailableError("无法执行产物中的原生 Node。") from error
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 5)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise RuntimeUnavailableError("Node 版本检查超时") from None
    if (
        process.returncode
        or not re.fullmatch(rb"v22\.\d+\.\d+\s*", output)
        or int(output.strip().split(b".")[1]) < 18
    ):
        raise RuntimeUnavailableError(
            "pi 需要经过验证的 Node 22.18 或更高的 22.x 版本。"
        )
    # A platform without the process-tree backend must not pretend to support write ownership.
    if sys.platform == "win32":
        raise RuntimeUnavailableError("pi 的 Windows Job 监督后端尚未验证。")
    return {
        "directory": directory,
        "node": node,
        "entry": entry,
        "manifest": manifest,
        "environment": environment,
    }

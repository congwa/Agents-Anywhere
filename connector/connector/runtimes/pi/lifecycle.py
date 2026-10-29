from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import sys
from typing import Any

from connector.mesh.hub import PI_HOST_ROLE
from connector.runtime_protocol.errors import RuntimeUnavailableError


class HostProcess:
    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None
        self.drains: list[asyncio.Task[Any]] = []

    async def start(
        self, environment: dict[str, Any], hub: Any, config: dict[str, Any]
    ) -> None:
        self.process = await asyncio.create_subprocess_exec(
            str(environment["node"]),
            str(environment["entry"]),
            cwd=str(environment["directory"]),
            env=environment["environment"],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
            limit=128 * 1024,
        )
        process = self.process
        assert process.stdin and process.stdout and process.stderr
        descriptor = hub.descriptor(PI_HOST_ROLE)
        bootstrap = {
            **config,
            "endpoint": descriptor["endpoint"],
            "key": descriptor["key"],
            "python": sys.executable,
        }
        process.stdin.write(json.dumps(bootstrap).encode() + b"\n")
        await process.stdin.drain()
        self.drains.append(asyncio.create_task(self._drain(process.stderr)))
        try:
            line = await asyncio.wait_for(process.stdout.readline(), 20)
            if not json.loads(line).get("ready"):
                raise ValueError("invalid startup receipt")
        except (ValueError, TimeoutError) as error:
            await self.stop()
            raise RuntimeUnavailableError(
                "pi Host 未能就绪，请检查产物及本机权限。"
            ) from error
        self.drains.append(asyncio.create_task(self._drain(process.stdout)))

    async def _drain(self, stream: asyncio.StreamReader) -> None:
        while await stream.read(64 * 1024):
            pass

    async def stop(self) -> None:
        process = self.process
        if process is None:
            return
        if process.stdin:
            process.stdin.close()  # Parent liveness channel also initiates orderly shutdown.
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), 25)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                await process.wait()
        await asyncio.gather(*self.drains, return_exceptions=True)
        self.drains.clear()
        self.process = None

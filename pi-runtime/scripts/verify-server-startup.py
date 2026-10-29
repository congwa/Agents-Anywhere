"""Exercise the real Server lifespan against a disposable migrated database."""

from __future__ import annotations

import asyncio
import contextlib
import io
import os

from loguru import logger


def main() -> None:
    url = os.environ["AGENT_SERVER_TEST_DB_URL"]
    assert "test" in url.rsplit("/", 1)[-1]
    os.environ["AGENT_SERVER_DB_URL"] = url
    os.environ["AGENT_SERVER_WORKERS"] = "1"
    os.environ["AGENT_SERVER_REDIS_URL"] = ""
    logger.remove()
    from agent_server.app import create_app
    from agent_server.infra.db.migrations import (
        CURRENT_SCHEMA_REVISION,
        database_revision,
        upgrade_database,
    )

    upgrade_database(db_url=url)

    async def run() -> None:
        # The first-run console may contain a temporary setup token.
        with (
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            app = create_app(redis_url="")
            async with app.router.lifespan_context(app):
                assert (
                    await database_revision(app.state.store.engine)
                    == CURRENT_SCHEMA_REVISION
                )

    asyncio.run(run())
    print(
        f"Formal Server lifespan: migrated {CURRENT_SCHEMA_REVISION}, startup/shutdown passed"
    )


if __name__ == "__main__":
    main()

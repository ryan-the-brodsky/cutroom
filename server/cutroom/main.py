"""Cutroom app factory + CLI.

    cutroom                       # serve API + built SPA
    cutroom --host 0.0.0.0 --port 8770
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api import (backends, comps, deps, direction, generate, jobs, media,
                  projects, separate, system, timeline)
from .adapters.registry import default_backends
from .config import get_settings
from .db import init_db, session_scope
from .jobs.queue import get_queue
from .models import Backend


def seed_backends() -> None:
    """First-boot defaults: local ComfyUI enabled; hosted templates disabled
    until keys land; direction providers wired from env when present."""
    rows = list(default_backends())
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    rows += [
        {"id": "anthropic", "type": "anthropic",
         "label": "Claude (hosted director)", "api_key": anthropic_key,
         "enabled": bool(anthropic_key),
         "options": {"model": "claude-sonnet-5"}},
        {"id": "lmstudio", "type": "openai-chat",
         "label": "LM Studio (local, advisory)",
         "base_url": "http://127.0.0.1:1234/v1", "enabled": False,
         "options": {}},
        {"id": "claude-cli", "type": "claude-cli",
         "label": "Claude CLI (self-host, agentic)",
         "enabled": get_settings().allow_claude_cli,
         "options": {"model": "opus"}},
    ]
    with session_scope() as s:
        for r in rows:
            if not s.get(Backend, r["id"]):
                s.add(Backend(**r))


def create_app() -> FastAPI:
    settings = get_settings()
    init_db()
    seed_backends()

    app = FastAPI(title="Cutroom", version="0.1.0")
    origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins or ["*"],
                       allow_methods=["*"], allow_headers=["*"])

    auth = [Depends(deps.require_auth)]
    for r in (projects.router, media.router, generate.router, comps.router,
              direction.router, jobs.router, backends.router, system.router,
              timeline.router, separate.router):
        app.include_router(r, prefix="/api", dependencies=auth)

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.on_event("startup")
    async def _startup():
        if settings.run_workers:
            get_queue().start()

    @app.on_event("shutdown")
    async def _shutdown():
        await get_queue().stop()

    # the built SPA, when present (deploy builds web/ into server/static).
    # history-fallback: unknown non-API paths serve index.html so deep links
    # (/p/<project>/shot/<sid>) load the app.
    static = Path(__file__).parent / "static"
    if static.is_dir():
        from fastapi.responses import FileResponse
        app.mount("/assets",
                  StaticFiles(directory=str(static / "assets")),
                  name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/") or path == "api":
                from fastapi import HTTPException
                raise HTTPException(404, path)
            target = (static / path).resolve()
            if path and target.is_file() and static in target.parents:
                return FileResponse(target)
            return FileResponse(static / "index.html")
    return app


def cli() -> None:
    import argparse

    import uvicorn
    ap = argparse.ArgumentParser(description="Cutroom server")
    settings = get_settings()
    ap.add_argument("--host", default=settings.host)
    ap.add_argument("--port", type=int, default=settings.port)
    args = ap.parse_args()
    uvicorn.run(create_app(), host=args.host, port=args.port,
                log_level="info")


if __name__ == "__main__":
    cli()

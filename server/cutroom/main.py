"""Cutroom app factory + CLI.

    cutroom                       # serve API + built SPA
    cutroom --host 0.0.0.0 --port 8770
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api import (backends, comps, cues, deps, direction, generate, jobs,
                  media, projects, separate, system, timeline)
from .adapters.registry import default_backends
from .budget import BudgetExceeded, default_cost
from .config import get_settings
from .db import init_db, session_scope
from .jobs.queue import get_queue
from .models import Backend


def _env_any(*names: str) -> str:
    """First non-empty of several accepted spellings of one key.

    The provider docs, your env file and the adapter code do not
    agree on names (FAL_KEY vs FAL_AI_API_KEY, ELEVEN_LABS_API_KEY vs
    ELEVENLABS_API_KEY), and a silently-unseeded backend looks exactly like
    a broken adapter. Accept them all."""
    for n in names:
        v = os.environ.get(n, "").strip()
        if v:
            return v
    return ""


def seed_backends() -> None:
    """First-boot defaults plus env-wired hosted providers.

    Keys come from the environment (`OPENROUTER_API_KEY`, `FAL_KEY`,
    `ELEVEN_LABS_API_KEY`, `ANTHROPIC_API_KEY`); a backend with a key is
    enabled, one without stays a disabled template. On an existing row the
    env is authoritative for the api_key and for "enabled because keyed",
    while model/cost options only fill in when missing — so an admin's
    Settings edits survive until the next boot, and a redeploy re-asserts
    what the environment says.

    Every row carries `options.cost_usd` (dollars per produced take) which
    the spend cap counts; override per backend with
    `CUTROOM_COST_<BACKEND_ID>` (dashes become underscores).
    """
    settings = get_settings()
    rows = list(default_backends())
    anthropic_key = _env_any("ANTHROPIC_API_KEY")
    openrouter_key = _env_any("OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY")
    fal_key = _env_any("FAL_KEY", "FAL_AI_API_KEY", "FAL_API_KEY")
    eleven_key = _env_any("ELEVEN_LABS_API_KEY", "ELEVENLABS_API_KEY")

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
         "enabled": settings.allow_claude_cli,
         "options": {"model": "opus"}},
        # Addendum A: the hosted demo's real providers.
        {"id": "openrouter", "type": "openai-chat",
         "label": "OpenRouter (direction)",
         "base_url": "https://openrouter.ai/api/v1",
         "api_key": openrouter_key, "enabled": bool(openrouter_key),
         "options": {"model": settings.openrouter_model}},
    ]

    # env keys land on the templates default_backends() already declares
    env_keyed = {"openrouter-image": (openrouter_key,
                                      {"model": settings.openrouter_image_model}),
                 "fal": (fal_key, {"model": settings.fal_motion_model,
                                   "models": [settings.fal_motion_model],
                                   "extra_payload": {"resolution": "480p"}}),
                 "elevenlabs": (eleven_key, {}),
                 "openrouter": (openrouter_key,
                                {"model": settings.openrouter_model}),
                 "anthropic": (anthropic_key, {})}
    # options an explicitly-set env var owns outright, on new AND existing
    # rows — otherwise `CUTROOM_FAL_MOTION_MODEL` would only ever apply to a
    # virgin database, which is exactly when nobody needs to change it.
    forced: dict[str, dict] = {}
    if os.environ.get("CUTROOM_OPENROUTER_MODEL"):
        forced["openrouter"] = {"model": settings.openrouter_model}
    if os.environ.get("CUTROOM_OPENROUTER_IMAGE_MODEL"):
        forced["openrouter-image"] = {"model": settings.openrouter_image_model}
    if os.environ.get("CUTROOM_FAL_MOTION_MODEL"):
        forced["fal"] = {"model": settings.fal_motion_model,
                         "models": [settings.fal_motion_model]}
    for r in rows:
        key, opts = env_keyed.get(r["id"], ("", {}))
        # the configured model is the default whether or not a key is present,
        # so pasting a key in Settings is all it takes to go live
        r["options"] = {**r.get("options", {}), **opts}
        if key:
            r["api_key"] = key
            r["enabled"] = True
        cost_env = "CUTROOM_COST_" + r["id"].upper().replace("-", "_")
        if os.environ.get(cost_env):
            forced.setdefault(r["id"], {})["cost_usd"] = \
                default_cost(r["id"], r["type"])
        r["options"].setdefault("cost_usd", default_cost(r["id"], r["type"]))

    if settings.demo:
        for r in rows:
            if r["id"] == "mock":
                r["enabled"] = True             # the always-free fallback

    with session_scope() as s:
        for r in rows:
            row = s.get(Backend, r["id"])
            if not row:
                s.add(Backend(**r))
                continue
            env_key, _ = env_keyed.get(r["id"], ("", {}))
            if env_key:
                row.api_key = env_key
                row.enabled = True
            opts = dict(row.options or {})
            for k, v in r["options"].items():
                opts.setdefault(k, v)
            opts.update(forced.get(r["id"], {}))
            row.options = opts
            if r["id"] == "mock" and settings.demo:
                row.enabled = True


def create_app() -> FastAPI:
    settings = get_settings()
    init_db()
    seed_backends()

    app = FastAPI(title="Cutroom", version="0.1.0")

    from fastapi.responses import JSONResponse

    @app.exception_handler(BudgetExceeded)
    async def _budget_exceeded(_request, exc: BudgetExceeded):
        # flat body — the WebMCP cost guard relays spent/budget verbatim
        return JSONResponse(status_code=402, content=exc.body())

    origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins or ["*"],
                       allow_methods=["*"], allow_headers=["*"])

    auth = [Depends(deps.require_auth)]
    for r in (projects.router, media.router, generate.router, comps.router,
              direction.router, jobs.router, backends.router, system.router,
              timeline.router, separate.router, cues.router):
        app.include_router(r, prefix="/api", dependencies=auth)

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.on_event("startup")
    async def _startup():
        if settings.run_workers:
            get_queue().start()
        if settings.demo:
            from . import demo as demo_mod
            demo_mod.boot_import_async()
            demo_mod.apply_lane_env(settings.demo_project, log=lambda m: None)

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


def cmd_reimport_cast(args) -> None:
    """Refresh a project's cast index from a studio folder (no media copy)."""
    init_db()
    from .importer.folder import reimport_cast
    out = reimport_cast(args.project, args.src_root)
    print(json.dumps(out, indent=2))


def cmd_demo_bundle(args) -> None:
    from .demo import build_bundle
    out = build_bundle(args.src_root, args.out)
    print(json.dumps(out, indent=2))


def cmd_demo_import(args) -> None:
    init_db()
    seed_backends()
    from .demo import boot_import
    print(json.dumps(boot_import(force=args.force), indent=2))


SUBCOMMANDS = {"reimport-cast", "demo-bundle", "demo-import", "serve"}


def cli() -> None:
    import argparse
    import sys

    import uvicorn
    settings = get_settings()
    ap = argparse.ArgumentParser(
        prog="cutroom", description="Cutroom server + maintenance commands")
    sub = ap.add_subparsers(dest="cmd")

    serve = sub.add_parser("serve", help="serve the API and built SPA")
    for p in (ap, serve):
        p.add_argument("--host", default=settings.host)
        p.add_argument("--port", type=int, default=settings.port)

    rc = sub.add_parser("reimport-cast",
                        help="rebuild project.settings.cast from a studio folder")
    rc.add_argument("project")
    rc.add_argument("src_root")
    rc.set_defaults(func=cmd_reimport_cast)

    db_ = sub.add_parser("demo-bundle", help="pack a studio folder for the demo")
    db_.add_argument("src_root")
    db_.add_argument("out", help="path ending .tar.zst (or .tar.gz)")
    db_.set_defaults(func=cmd_demo_bundle)

    di = sub.add_parser("demo-import",
                        help="download + import CUTROOM_DEMO_BUNDLE now")
    di.add_argument("--force", action="store_true")
    di.set_defaults(func=cmd_demo_import)

    # `cutroom --port 8782` (no subcommand) still serves, as it always has,
    # while `cutroom --help` lists the maintenance commands.
    argv = sys.argv[1:]
    if not argv or (argv[0].startswith("-") and argv[0] not in ("-h", "--help")):
        argv = ["serve", *argv]
    args = ap.parse_args(argv)
    if getattr(args, "func", None):
        args.func(args)
        return
    uvicorn.run(create_app(), host=args.host, port=args.port,
                log_level="info")


if __name__ == "__main__":
    cli()

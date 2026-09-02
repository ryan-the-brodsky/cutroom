from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select

import shutil
import tempfile

from ..config import get_settings
from ..db import session_scope
from ..models import Job, Project
from .. import budget, demo
from .deps import require_admin

router = APIRouter()


@router.get("/system")
def system_state(request: Request):
    settings = get_settings()
    with session_scope() as s:
        counts = dict(s.execute(
            select(Job.status, func.count()).group_by(Job.status)).all())
        projects = s.query(Project).count()
    return {"projects": projects,
            "jobs": counts,
            "paused": (settings.data_dir / "PAUSED").exists(),
            "data_dir": str(settings.data_dir),
            "auth": bool(settings.auth_token),
            "workers": settings.run_workers,
            "demo": bool(settings.demo),
            "role": demo.role_for(request),
            "budget": budget.state(),
            "disk": _disk(settings),
            "version": "0.1.0"}


def _disk(settings) -> dict:
    """Free space where it matters: the data volume (takes, cuts) and the
    scratch dir the assembler/compositor write to. A full disk fails a cut
    with an opaque ffmpeg "No space left on device"; this makes it visible."""
    out = {}
    for name, path in (("data", settings.data_dir), ("tmp", tempfile.gettempdir())):
        try:
            u = shutil.disk_usage(str(path))
            out[name] = {"path": str(path), "used_mb": round(u.used / 1e6),
                         "free_mb": round(u.free / 1e6), "total_mb": round(u.total / 1e6)}
        except OSError:
            out[name] = {"path": str(path), "error": "unavailable"}
    return out


@router.post("/system/pause",
             dependencies=[Depends(require_admin("pausing the server"))])
async def system_pause(req: Request):
    body = await req.json()
    flag = get_settings().data_dir / "PAUSED"
    if body.get("paused"):
        flag.touch()
    else:
        flag.unlink(missing_ok=True)
    return {"paused": flag.exists()}

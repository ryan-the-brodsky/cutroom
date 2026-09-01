from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from ..config import get_settings
from ..db import session_scope
from ..models import Job, Project

router = APIRouter()


@router.get("/system")
def system_state():
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
            "version": "0.1.0"}


@router.post("/system/pause")
async def system_pause(req: Request):
    body = await req.json()
    flag = get_settings().data_dir / "PAUSED"
    if body.get("paused"):
        flag.touch()
    else:
        flag.unlink(missing_ok=True)
    return {"paused": flag.exists()}

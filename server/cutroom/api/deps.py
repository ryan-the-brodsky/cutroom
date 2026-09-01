from __future__ import annotations

from fastapi import HTTPException, Request

from ..config import get_settings
from ..db import session_scope
from ..models import Project
from ..storage import get_storage


async def require_auth(request: Request) -> None:
    """Bearer-token auth when CUTROOM_AUTH_TOKEN is set. GET media/thumbnail
    requests may pass ?token= (browsers can't set headers on <img>/<video>)."""
    token = get_settings().auth_token
    if not token:
        return
    header = request.headers.get("authorization", "")
    if header == f"Bearer {token}":
        return
    if request.method == "GET" and request.query_params.get("token") == token:
        return
    raise HTTPException(401, "missing or invalid token")


async def require_worker(request: Request) -> None:
    settings = get_settings()
    token = settings.worker_token or settings.auth_token
    if not token:
        return
    if request.headers.get("authorization") != f"Bearer {token}":
        raise HTTPException(401, "worker token required")


def project_or_404(project_id: str) -> str:
    with session_scope() as s:
        if not s.get(Project, project_id):
            raise HTTPException(404, f"no project {project_id}")
    return project_id


def store_for(project_id: str):
    project_or_404(project_id)
    return get_storage().project(project_id)

from __future__ import annotations

from fastapi import HTTPException, Request

from ..config import get_settings
from ..db import session_scope
from ..models import Project
from ..storage import get_storage


async def require_auth(request: Request) -> None:
    """Bearer-token auth when CUTROOM_AUTH_TOKEN is set. GET media/thumbnail
    requests may pass ?token= (browsers can't set headers on <img>/<video>).

    In demo mode there are two accepted tokens: the viewer token judges get
    in the link, and CUTROOM_ADMIN_TOKEN. Which one you presented decides
    your role (demo.role_for), not whether you get in."""
    settings = get_settings()
    accepted = [t for t in (settings.auth_token, settings.admin_token) if t]
    if not accepted:
        return
    header = request.headers.get("authorization", "")
    query = request.query_params.get("token")
    for token in accepted:
        if header == f"Bearer {token}":
            return
        if request.method == "GET" and query == token:
            return
    raise HTTPException(401, "missing or invalid token")


def require_admin(what: str = "this"):
    """Dependency: 403 for viewers in demo mode. See cutroom/demo.py."""
    from ..demo import require_admin as _require_admin
    return _require_admin(what)


async def require_worker(request: Request) -> None:
    """Remote workers claim jobs with CUTROOM_WORKER_TOKEN. On the demo the
    viewer token must NOT be enough — a judge claiming queued jobs would
    stall the pools — so the fallback there is the admin token."""
    settings = get_settings()
    fallback = settings.admin_token if settings.demo else settings.auth_token
    token = settings.worker_token or fallback
    if not token:
        if settings.demo:
            raise HTTPException(403, "worker endpoints are closed on the "
                                     "hosted demo")
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

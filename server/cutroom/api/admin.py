"""Studio-owner operations that never belong to a viewer: deleting a project."""
from __future__ import annotations

import shutil

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select

from ..db import session_scope
from ..models import ChatMessage, Comp, Job, LaneConfig, Project, Shot, Take
from .deps import require_admin, store_for

router = APIRouter()


@router.post("/projects/{pid}/delete",
             dependencies=[Depends(require_admin("deleting projects"))])
def delete_project(pid: str):
    """Remove a project: every row that points at it, then its media directory.
    Irreversible; running jobs for it are marked cancelled first."""
    with session_scope() as s:
        proj = s.get(Project, pid)
        if not proj:
            raise HTTPException(404, "no such project")
        running = s.execute(select(Job).where(Job.project_id == pid,
                                              Job.status.in_(("queued", "running")))).scalars().all()
        for j in running:
            j.status = "cancelled"
        counts = {}
        for model in (ChatMessage, LaneConfig, Job, Comp, Take, Shot):
            res = s.execute(delete(model).where(model.project_id == pid))
            counts[model.__tablename__] = res.rowcount
        s.delete(proj)
    try:
        store = store_for(pid)
        shutil.rmtree(store.root, ignore_errors=True)
        removed_dir = True
    except Exception:
        removed_dir = False
    return {"ok": True, "deleted": pid, "rows": counts, "media_removed": removed_dir}

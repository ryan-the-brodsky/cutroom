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
    # Resolve the media root while the project still exists (store_for 404s afterwards).
    try:
        media_root = store_for(pid).root
    except Exception:
        media_root = None
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
    removed_dir = False
    if media_root is not None:
        shutil.rmtree(media_root, ignore_errors=True)
        removed_dir = not media_root.exists()
    return {"ok": True, "deleted": pid, "rows": counts, "media_removed": removed_dir}


@router.post("/projects/{pid}/purge",
             dependencies=[Depends(require_admin("purging project files"))])
def purge_project(pid: str, keep_cuts: int = 3, drop_intermediates: bool = True,
                  superseded_motion: bool = False, keep_motion_per_shot: int = 1):
    """Free space without touching the film: keep the newest `keep_cuts` animatics,
    drop crop/matte intermediates under renders/motion/tests, and (opt-in) drop
    superseded motion clips: per shot, every motion/fx take that is neither the
    shot's timeline source nor among its newest `keep_motion_per_shot` clips.
    Picks, keepers and current sources are never removed."""
    from ..models import Shot as _Shot
    store = store_for(pid)
    freed = 0
    removed = {"cuts": 0, "intermediates": 0, "motion": 0}
    with session_scope() as s:
        if not s.get(Project, pid):
            raise HTTPException(404, "no such project")
        protected = set()
        for sh in s.execute(select(_Shot).where(_Shot.project_id == pid)).scalars():
            ov = sh.override or {}
            for v in (sh.keeper, ov.get("source"), ov.get("vo_file")):
                if v:
                    protected.add(v)
        cuts = s.execute(select(Take).where(Take.project_id == pid, Take.kind == "animatic")
                         .order_by(Take.created_at.desc())).scalars().all()
        for t in cuts[max(0, keep_cuts):]:
            p = store.resolve(t.path)
            if p.exists():
                freed += p.stat().st_size
                p.unlink()
            s.delete(t)
            removed["cuts"] += 1
        if drop_intermediates:
            for t in s.execute(select(Take).where(Take.project_id == pid,
                                                   Take.kind.in_(("crop", "matte")))).scalars().all():
                if t.path in protected:
                    continue
                p = store.resolve(t.path)
                if p.exists():
                    freed += p.stat().st_size
                    p.unlink()
                s.delete(t)
                removed["intermediates"] += 1
        if superseded_motion:
            by_shot: dict[str, list] = {}
            for t in s.execute(select(Take).where(Take.project_id == pid,
                                                   Take.kind.in_(("motion", "fx")))
                               .order_by(Take.created_at.desc())).scalars().all():
                by_shot.setdefault(t.shot_sid or "", []).append(t)
            for sid, takes in by_shot.items():
                for t in takes[max(0, keep_motion_per_shot):]:
                    if t.path in protected:
                        continue
                    p = store.resolve(t.path)
                    if p.exists():
                        freed += p.stat().st_size
                        p.unlink()
                    s.delete(t)
                    removed["motion"] += 1
    return {"ok": True, "project": pid, "removed": removed, "freed_mb": round(freed / 1e6, 1)}


@router.post("/system/purge-orphans",
             dependencies=[Depends(require_admin("purging orphan directories"))])
def purge_orphans():
    """Remove project directories on disk that no longer have a Project row."""
    from ..config import get_settings
    root = get_settings().data_dir / "projects"
    with session_scope() as s:
        live = {p.id for p in s.execute(select(Project)).scalars()}
    removed, freed = [], 0
    if root.exists():
        for d in root.iterdir():
            if d.is_dir() and d.name not in live:
                freed += sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                shutil.rmtree(d, ignore_errors=True)
                removed.append(d.name)
    return {"ok": True, "removed": removed, "freed_mb": round(freed / 1e6, 1)}

from __future__ import annotations

import re
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select

from ..db import session_scope
from ..jobs.queue import submit_job
from ..models import Comp, LaneConfig, Project, Shot, Take
from ..storage import get_storage
from .. import film
from .deps import project_or_404, require_admin, store_for

router = APIRouter()


@router.get("/projects")
def list_projects():
    with session_scope() as s:
        return [{"id": p.id, "label": p.label, "paused": p.paused,
                 "created_at": p.created_at,
                 "shots": s.query(Shot).filter_by(project_id=p.id).count()}
                for p in s.execute(select(Project)
                                   .order_by(Project.created_at)).scalars()]


@router.post("/projects",
             dependencies=[Depends(require_admin("creating projects"))])
async def create_project(req: Request):
    body = await req.json()
    pid = re.sub(r"[^a-z0-9-]+", "-", str(body.get("id", "")).lower()).strip("-")
    if not pid:
        raise HTTPException(400, "need an id (slug)")
    with session_scope() as s:
        if s.get(Project, pid):
            raise HTTPException(409, f"project {pid} exists")
        s.add(Project(id=pid, label=body.get("label", pid)))
    get_storage().create_project(pid)
    return {"id": pid, "label": body.get("label", pid)}


@router.post("/projects/{pid}/import",
             dependencies=[Depends(require_admin("importing projects"))])
async def import_project(pid: str, req: Request):
    """Ingest a game7-layout repo. Creates the project row if needed, then
    runs the (long) media copy + index as a job."""
    body = await req.json()
    src = body.get("src_root", "")
    if not src:
        raise HTTPException(400, "need src_root")
    pid = re.sub(r"[^a-z0-9-]+", "-", pid.lower()).strip("-")
    with session_scope() as s:
        if not s.get(Project, pid):
            s.add(Project(id=pid, label=body.get("label", pid)))
    get_storage().create_project(pid)
    with session_scope() as s:
        job = submit_job(s, "project.import",
                         {"project": pid, "src_root": src,
                          "label": body.get("label"),
                          "copy_media": body.get("copy_media", True)},
                         pid, "cpu", f"import {src} -> {pid}",
                         chain={"type": "thumbs.warm",
                                "payload": {"project": pid},
                                "project_id": pid, "pool": "cpu",
                                "title": f"warm thumbnails: {pid}"})
        return {"job": job.id}


@router.get("/projects/{pid}/film")
def get_film(pid: str):
    store = store_for(pid)
    with session_scope() as s:
        takes = film.takes_by_shot(s, pid)
        return [film.film_entry(store, sh, takes.get(sh.sid, []))
                for sh in film.shots_ordered(s, pid)]


@router.get("/projects/{pid}/cast")
def get_cast(pid: str):
    """The character index the shot resolver matches names against.
    [{id, name, aliases[], descriptor}] — built by the game7 importer from
    prompts/characters.jsonl; refresh with `cutroom reimport-cast`."""
    project_or_404(pid)
    with session_scope() as s:
        proj = s.get(Project, pid)
        settings = dict(proj.settings or {})
        cast = settings.get("cast")
        if not cast:
            # projects imported before the cast index existed
            from ..importer.game7 import build_cast
            cast = build_cast(settings.get("characters") or [])
        return {"cast": cast}


@router.post("/projects/{pid}/cast",
             dependencies=[Depends(require_admin("editing the cast"))])
async def set_cast(pid: str, req: Request):
    """Set the character index for a project created through the API (the game7
    importer does this from prompts/characters.jsonl; fresh projects need a way in).
    Body: {"characters": [{id, character, image_prompt?, negative?, seeds?}, …]}"""
    body = await req.json()
    rows = body.get("characters") or []
    if not isinstance(rows, list):
        raise HTTPException(400, "characters must be a list")
    from ..importer.game7 import build_cast
    cast = build_cast(rows)
    with session_scope() as s:
        proj = s.get(Project, pid)
        if not proj:
            raise HTTPException(404, "no such project")
        settings = dict(proj.settings or {})
        settings["characters"] = rows
        settings["cast"] = cast
        proj.settings = settings
    return {"ok": True, "cast": cast}


@router.get("/projects/{pid}/shots/{sid}")
def get_shot(pid: str, sid: str):
    store = store_for(pid)
    with session_scope() as s:
        shot = s.execute(select(Shot).where(
            Shot.project_id == pid, Shot.sid == sid)).scalar_one_or_none()
        if not shot:
            raise HTTPException(404, sid)
        takes = film.takes_by_shot(s, pid).get(sid, [])
        entry = film.film_entry(store, shot, takes)
        entry["takes"] = [
            {"id": t.id, "kind": t.kind, "path": t.path, "seed": t.seed,
             "backend": t.backend_id, "model": t.model, "prompt": t.prompt,
             "params": t.params, "sources": t.sources,
             "created_at": t.created_at, "meta": t.meta} for t in takes]
        comps = s.query(Comp).filter_by(project_id=pid, shot_sid=sid).all()
        entry["comps"] = [{"cid": c.cid, "background": c.background,
                           "duration": c.duration, "layers": c.layers,
                           "width": c.width, "height": c.height} for c in comps]
        return entry


@router.post("/projects/{pid}/shots")
async def upsert_shot(pid: str, req: Request):
    """Script editing: create or update a shot row."""
    body = await req.json()
    sid = body.get("sid", "")
    if not sid:
        raise HTTPException(400, "need sid")
    fields = ("beat", "act", "type", "seconds", "register", "image_prompt",
              "negative", "motion_prompt", "pan", "radio", "dialogue", "sfx",
              "ambient", "cut", "render_notes", "order_idx")
    with session_scope() as s:
        project_or_404(pid)
        shot = s.execute(select(Shot).where(
            Shot.project_id == pid, Shot.sid == sid)).scalar_one_or_none()
        if not shot:
            count = s.query(Shot).filter_by(project_id=pid).count()
            shot = Shot(project_id=pid, sid=sid, order_idx=count)
            s.add(shot)
        for f in fields:
            if f in body:
                setattr(shot, f, body[f])
    return {"ok": True, "sid": sid}


@router.post("/projects/{pid}/shots/{sid}/override")
async def set_override(pid: str, sid: str, req: Request):
    body = await req.json()
    allowed = ("seconds", "source", "vo_offset", "vo_file", "mute_vo", "note")
    with session_scope() as s:
        shot = s.execute(select(Shot).where(
            Shot.project_id == pid, Shot.sid == sid)).scalar_one_or_none()
        if not shot:
            raise HTTPException(404, sid)
        ov = dict(shot.override or {})
        ov.update({k: v for k, v in body.items() if k in allowed})
        ov = {k: v for k, v in ov.items() if v is not None}
        shot.override = ov
        return {"ok": True, "override": ov}


@router.post("/projects/{pid}/shots/{sid}/curate")
async def curate(pid: str, sid: str, req: Request):
    body = await req.json()
    from ..director.apply import apply_op
    project_or_404(pid)
    if not body.get("keeper"):
        raise HTTPException(400, "need keeper")
    return apply_op(pid, {"op": "set_keeper", "shot": sid,
                          "path": body["keeper"], "note": body.get("note")})


@router.post("/projects/{pid}/shots/{sid}/refs")
async def shot_refs(pid: str, sid: str, req: Request):
    body = await req.json()
    with session_scope() as s:
        shot = s.execute(select(Shot).where(
            Shot.project_id == pid, Shot.sid == sid)).scalar_one_or_none()
        if not shot:
            raise HTTPException(404, sid)
        ov = dict(shot.override or {})
        refs = list(ov.get("refs", []))
        if body.get("add") and body["add"] not in refs:
            refs.append(body["add"])
        if body.get("remove"):
            refs = [r for r in refs if r != body["remove"]]
        ov["refs"] = refs
        shot.override = ov
        return {"refs": refs}


@router.get("/projects/{pid}/takes")
def list_takes(pid: str, shot: str | None = None, kind: str | None = None,
               limit: int = 200):
    project_or_404(pid)
    with session_scope() as s:
        q = select(Take).where(Take.project_id == pid)
        if shot:
            q = q.where(Take.shot_sid == shot)
        if kind:
            q = q.where(Take.kind == kind)
        rows = s.execute(q.order_by(Take.created_at.desc())
                         .limit(limit)).scalars()
        return [{"id": t.id, "kind": t.kind, "path": t.path,
                 "shot": t.shot_sid, "seed": t.seed, "backend": t.backend_id,
                 "model": t.model, "prompt": t.prompt, "sources": t.sources,
                 "created_at": t.created_at, "meta": t.meta} for t in rows]


@router.get("/projects/{pid}/lanes")
def get_lanes(pid: str):
    project_or_404(pid)
    with session_scope() as s:
        return {lc.lane: {"backend": lc.backend_id, "model": lc.model,
                          "params": lc.params}
                for lc in s.query(LaneConfig).filter_by(project_id=pid)}


@router.post("/projects/{pid}/lanes",
             dependencies=[Depends(require_admin("editing lane defaults"))])
async def set_lane(pid: str, req: Request):
    body = await req.json()
    lane = body.get("lane")
    if not lane:
        raise HTTPException(400, "need lane")
    with session_scope() as s:
        project_or_404(pid)
        lc = s.execute(select(LaneConfig).where(
            LaneConfig.project_id == pid,
            LaneConfig.lane == lane)).scalar_one_or_none()
        if not lc:
            lc = LaneConfig(project_id=pid, lane=lane)
            s.add(lc)
        lc.backend_id = body.get("backend")
        lc.model = body.get("model")
        lc.params = body.get("params", {}) or {}
    return {"ok": True}


@router.post("/projects/{pid}/pause",
             dependencies=[Depends(require_admin("pausing a project"))])
async def pause_project(pid: str, req: Request):
    body = await req.json()
    with session_scope() as s:
        p = s.get(Project, pid)
        if not p:
            raise HTTPException(404, pid)
        p.paused = bool(body.get("paused"))
        return {"paused": p.paused}

from __future__ import annotations

import re
import time

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

from ..db import session_scope
from ..director.apply import _gen_pool, apply_op
from ..jobs.queue import submit_job
from ..models import Comp
from .deps import project_or_404

router = APIRouter()


def _comp(session, pid: str, cid: str) -> Comp:
    comp = session.execute(select(Comp).where(
        Comp.project_id == pid, Comp.cid == cid)).scalar_one_or_none()
    if not comp:
        raise HTTPException(404, cid)
    return comp


def _comp_dict(c: Comp) -> dict:
    return {"cid": c.cid, "shot": c.shot_sid, "background": c.background,
            "width": c.width, "height": c.height, "duration": c.duration,
            "layers": c.layers, "background_history": c.background_history,
            "created_at": c.created_at}


@router.get("/projects/{pid}/comps")
def list_comps(pid: str, shot: str | None = None):
    project_or_404(pid)
    with session_scope() as s:
        q = select(Comp).where(Comp.project_id == pid)
        if shot:
            q = q.where(Comp.shot_sid == shot)
        return [_comp_dict(c) for c in s.execute(q).scalars()]


@router.post("/projects/{pid}/comps")
async def create_comp(pid: str, req: Request):
    body = await req.json()
    if not body.get("background"):
        raise HTTPException(400, "need background (a plate path)")
    project_or_404(pid)
    cid = re.sub(r"[^A-Za-z0-9-]+", "-",
                 body.get("cid") or f"{body.get('shot', 'comp')}-"
                 f"{int(time.time()) % 100000}")
    with session_scope() as s:
        if s.execute(select(Comp).where(Comp.project_id == pid,
                                        Comp.cid == cid)).scalar_one_or_none():
            raise HTTPException(409, f"comp {cid} exists")
        c = Comp(project_id=pid, cid=cid, shot_sid=body.get("shot"),
                 background=body["background"],
                 duration=float(body.get("duration", 4.0)),
                 layers=body.get("layers", []))
        s.add(c)
        s.flush()
        return _comp_dict(c)


@router.post("/projects/{pid}/comps/{cid}")
async def update_comp(pid: str, cid: str, req: Request):
    body = await req.json()
    with session_scope() as s:
        c = _comp(s, pid, cid)
        if body.get("background") and body["background"] != c.background:
            # switching plates keeps every option toggleable
            hist = [h for h in (c.background_history or [])
                    if h != body["background"]]
            if c.background:
                hist.append(c.background)
            c.background_history = hist
        for k in ("background", "duration", "layers", "width", "height"):
            if k in body:
                setattr(c, k, body[k])
        if "shot" in body:
            c.shot_sid = body["shot"]
        s.flush()
        return _comp_dict(c)


@router.post("/projects/{pid}/comps/{cid}/delete")
def delete_comp(pid: str, cid: str):
    with session_scope() as s:
        s.delete(_comp(s, pid, cid))
    return {"ok": True}


@router.post("/projects/{pid}/comps/{cid}/render")
def render_comp(pid: str, cid: str):
    with session_scope() as s:
        _comp(s, pid, cid)
        job = submit_job(s, "comp.render", {"project": pid, "comp": cid},
                         pid, "cpu", f"render comp {cid}")
        return {"job": job.id}


@router.post("/projects/{pid}/comps/{cid}/layers")
async def add_layer(pid: str, cid: str, req: Request):
    body = await req.json()
    for k in ("region", "prompt"):
        if not body.get(k):
            raise HTTPException(400, f"need {k}")
    project_or_404(pid)
    return apply_op(pid, {"op": "add_layer", "comp": cid,
                          **{k: body.get(k) for k in
                             ("region", "prompt", "feather", "matte",
                              "frames", "steps", "cfg") if body.get(k)
                             is not None}})


@router.post("/projects/{pid}/comps/{cid}/layers/{lid}/reroll")
async def reroll_layer(pid: str, cid: str, lid: str, req: Request):
    body = await req.json()
    with session_scope() as s:
        _comp(s, pid, cid)
    pool = _gen_pool(pid, "motion", body.get("backend"))
    with session_scope() as s:
        job = submit_job(s, "comp.layer_reroll",
                         {"project": pid, "comp": cid, "layer": lid,
                          **{k: body[k] for k in
                             ("prompt", "frames", "steps", "cfg", "seed",
                              "backend", "model", "params")
                             if body.get(k) is not None}},
                         pid, pool, f"reroll layer {lid} of {cid}")
        return {"job": job.id}


@router.post("/projects/{pid}/comps/{cid}/background/reroll")
async def reroll_background(pid: str, cid: str, req: Request):
    body = await req.json()
    with session_scope() as s:
        _comp(s, pid, cid)
    mode = body.get("mode", "edit")
    pool = _gen_pool(pid, "still" if mode == "regen" else "i2i",
                     body.get("backend"))
    with session_scope() as s:
        job = submit_job(s, "comp.bg_reroll",
                         {"project": pid, "comp": cid, "mode": mode,
                          "prompt": body.get("prompt", ""),
                          "denoise": body.get("denoise", 0.55),
                          **{k: body[k] for k in ("seed", "backend", "model")
                             if body.get(k) is not None}},
                         pid, pool,
                         f"bg {'regen' if mode == 'regen' else 'edit'}: {cid}")
        return {"job": job.id}


@router.post("/projects/{pid}/panels")
async def render_panels(pid: str, req: Request):
    """Render a panel-screen spec (the Ping Pong grammar) as a job."""
    body = await req.json()
    if not body.get("spec"):
        raise HTTPException(400, "need spec")
    project_or_404(pid)
    with session_scope() as s:
        job = submit_job(s, "panel.render",
                         {"project": pid, "spec": body["spec"],
                          "name": body.get("name"), "shot": body.get("shot")},
                         pid, "cpu",
                         f"panels: {body.get('name') or body.get('shot', '')}")
        return {"job": job.id}

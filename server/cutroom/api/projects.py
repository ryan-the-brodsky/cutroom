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


def slugify(raw: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", str(raw or "").lower()).strip("-")[:64]


@router.post("/projects")
async def create_project(req: Request):
    """Start an empty film. Admin-only on a self-host is the wrong default for
    the hosted demo — a visitor who wants to make their own short has nowhere to
    put it — so viewers may create projects too, capped by
    `CUTROOM_DEMO_PROJECTS_PER_TOKEN` per rolling 24 h (demo.project_quota).

    The new project gets the instance's lane defaults (`CUTROOM_LANE_<LANE>`)
    applied straight away, so generation on a fresh project routes to the
    configured providers instead of falling through to "first enabled backend"."""
    from ..demo import project_quota
    body = await req.json()
    pid = slugify(body.get("id") or body.get("label") or body.get("title") or "")
    if not pid:
        raise HTTPException(400, "need an id (slug)")
    label = body.get("label") or body.get("title") or pid
    with session_scope() as s:
        if s.get(Project, pid):
            raise HTTPException(409, f"project {pid} exists")
    project_quota(req)
    settings: dict = {}
    fps = body.get("fps")
    if fps:
        try:
            settings["fps"] = max(1, min(60, int(float(fps))))
        except (TypeError, ValueError):
            raise HTTPException(400, "fps must be a number")
    with session_scope() as s:
        if s.get(Project, pid):
            raise HTTPException(409, f"project {pid} exists")
        s.add(Project(id=pid, label=label, settings=settings))
    get_storage().create_project(pid)
    from ..demo import apply_lane_env
    lanes = apply_lane_env(pid, log=lambda _m: None)
    return {"id": pid, "label": label, "lanes": lanes,
            **({"fps": settings["fps"]} if "fps" in settings else {})}


@router.post("/projects/{pid}/import",
             dependencies=[Depends(require_admin("importing projects"))])
async def import_project(pid: str, req: Request):
    """Ingest a studio folder. Creates the project row if needed, then
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
    [{id, name, aliases[], descriptor}] — built by the folder importer from
    prompts/characters.jsonl; refresh with `cutroom reimport-cast`."""
    project_or_404(pid)
    with session_scope() as s:
        proj = s.get(Project, pid)
        settings = dict(proj.settings or {})
        cast = settings.get("cast")
        if not cast:
            # projects imported before the cast index existed
            from ..importer.folder import build_cast
            cast = build_cast(settings.get("characters") or [])
        return {"cast": cast}


@router.post("/projects/{pid}/cast")
async def set_cast(pid: str, req: Request):
    """Set the character index for a project created through the API (the folder
    importer does this from prompts/characters.jsonl; fresh projects need a way in).
    Body: {"characters": [{id, character, image_prompt?, negative?, seeds?}, …]}

    Viewer-allowed on the hosted demo: a visitor who just wrote a script has to
    be able to name its cast, and per-project ownership is not modelled — the
    simplest honest rule is that casting is creative work, like the script."""
    body = await req.json()
    rows = body.get("characters") or []
    if not isinstance(rows, list):
        raise HTTPException(400, "characters must be a list")
    from ..importer.folder import cast_entry
    cast = []
    for rec in rows:
        entry = cast_entry(rec if isinstance(rec, dict) else {})
        if not entry:
            continue
        # An API caller may know aliases the descriptor does not spell out
        # ("the baker", "her"); the folder importer has no way to say them.
        for extra in (rec.get("aliases") or []) if isinstance(rec, dict) else []:
            alias = str(extra).strip().lower()
            if len(alias) >= 3 and alias not in entry["aliases"]:
                entry["aliases"].append(alias)
        cast.append(entry)
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


SID_RE = re.compile(r"^B\d\d-S\d+$")
BEAT_RE = re.compile(r"^B\d\d$")
SHOT_FIELDS = ("beat", "act", "type", "seconds", "register", "image_prompt",
               "negative", "motion_prompt", "pan", "radio", "dialogue", "sfx",
               "ambient", "cut", "render_notes")
MAX_BATCH_SHOTS = 40
MAX_BATCH_SECONDS = 300.0
MIN_SECONDS, MAX_SECONDS, DEFAULT_SECONDS = 2.0, 20.0, 6.0


def _beat_of(raw, act: int) -> str:
    """"B7" / "b07" / 7 all mean B07; nothing means one beat per act."""
    text = str(raw or "").strip().upper()
    if not text:
        return f"B{act:02d}"
    digits = re.sub(r"[^0-9]", "", text)
    if not digits:
        raise HTTPException(400, f"beat {raw!r} must look like B01")
    return f"B{int(digits):02d}"


@router.post("/projects/{pid}/shots/batch")
async def upsert_shots(pid: str, req: Request):
    """Write a whole script in one call: `{"shots": [...], "replace": false}`.

    Shots are upserted in the order given and `order_idx` is the position, so
    the list IS the cut. `sid` is optional — a missing one is assigned
    `B01-S1`, `B01-S2`, … one beat per act, or inside an explicit `beat`.
    Guard rails so an agent cannot write a feature film by accident: at most
    40 shots, 2–20 seconds each (default 6), 300 seconds in total.

    Viewer-allowed: writing the script is the creative act this whole room
    exists for. `replace: true` drops the shots this batch does not name."""
    body = await req.json()
    rows = body.get("shots")
    if not isinstance(rows, list) or not rows:
        raise HTTPException(400, "need shots: [{image_prompt, …}, …]")
    if len(rows) > MAX_BATCH_SHOTS:
        raise HTTPException(400, f"{len(rows)} shots — the cap is "
                                 f"{MAX_BATCH_SHOTS} in one script")
    project_or_404(pid)

    prepared: list[dict] = []
    per_beat: dict[str, int] = {}
    seen: set[str] = set()
    total = 0.0
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            raise HTTPException(400, f"shot {i + 1} is not an object")
        try:
            act = int(float(row.get("act") or 1))
        except (TypeError, ValueError):
            raise HTTPException(400, f"shot {i + 1}: act must be a number")
        act = max(1, min(99, act))
        beat = _beat_of(row.get("beat"), act)
        if not BEAT_RE.match(beat):
            raise HTTPException(400, f"shot {i + 1}: beat {beat!r} must look like B01")

        sid = str(row.get("sid") or row.get("id") or "").strip().upper()
        if sid:
            if not SID_RE.match(sid):
                raise HTTPException(400, f"sid {sid!r} must look like B01-S1")
            head, _, tail = sid.partition("-S")
            per_beat[head] = max(per_beat.get(head, 0), int(tail))
        else:
            per_beat[beat] = per_beat.get(beat, 0) + 1
            sid = f"{beat}-S{per_beat[beat]}"
        if sid in seen:
            raise HTTPException(400, f"sid {sid} appears twice in one batch")
        seen.add(sid)

        prompt = str(row.get("image_prompt") or "").strip()
        if not prompt:
            raise HTTPException(400, f"shot {sid}: need an image_prompt")
        try:
            seconds = float(row.get("seconds") or DEFAULT_SECONDS)
        except (TypeError, ValueError):
            raise HTTPException(400, f"shot {sid}: seconds must be a number")
        seconds = max(MIN_SECONDS, min(MAX_SECONDS, seconds))
        total += seconds
        if total > MAX_BATCH_SECONDS:
            raise HTTPException(400, (
                f"the script runs past {MAX_BATCH_SECONDS:.0f}s at {sid} — "
                "shorten it or cut shots"))

        fields = {f: row[f] for f in SHOT_FIELDS if f in row}
        fields.update({"beat": beat, "act": act, "seconds": seconds,
                       "image_prompt": prompt,
                       "type": str(row.get("type") or "STILL").upper()})
        dialogue = fields.get("dialogue")
        if dialogue is not None and not isinstance(dialogue, list):
            raise HTTPException(400, f"shot {sid}: dialogue must be a list")
        prepared.append({"sid": sid, "order_idx": i, **fields})

    with session_scope() as s:
        existing = {sh.sid: sh for sh in
                    s.query(Shot).filter_by(project_id=pid)}
        for row in prepared:
            shot = existing.get(row["sid"])
            if not shot:
                shot = Shot(project_id=pid, sid=row["sid"])
                s.add(shot)
            for f, v in row.items():
                if f != "sid":
                    setattr(shot, f, v)
        if body.get("replace"):
            for sid, shot in existing.items():
                if sid not in seen:
                    s.delete(shot)

    return {"count": len(prepared), "sids": [r["sid"] for r in prepared],
            "total_seconds": round(total, 2),
            "replaced": bool(body.get("replace"))}


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


def _recompute_edl(session, pid: str, scope: str) -> list[dict]:
    """The shot boundaries of a cut, rebuilt from the film as it stands.

    Only used for cuts assembled before the EDL was recorded in the take's
    meta. It is an approximation on one axis: the assembler stretches a shot
    to fit its VO (audio-fit), and that stretch is not reproducible from the
    shot list alone. Fresh cuts always take the stored EDL instead.
    """
    store = get_storage().project(pid)
    takes = film.takes_by_shot(session, pid)
    out: list[dict] = []
    t = 0.0
    for shot in film.shots_ordered(session, pid):
        if scope.startswith("act") and str(shot.act) != scope[3:]:
            continue
        ov = shot.override or {}
        seconds = float(ov.get("seconds", shot.seconds))
        src = film.active_source(store, shot, takes.get(shot.sid, []))
        out.append({"sid": shot.sid, "start": round(t, 3),
                    "seconds": round(seconds, 3), "source": src})
        t += seconds
    return out


@router.get("/projects/{pid}/cuts/{name:path}/edl")
def cut_edl(pid: str, name: str):
    """A cut's chapter list: which shot is on screen, from when, for how long.

    `name` is the cut's rel path or just its file name; "latest" takes the
    newest animatic. This is what the screening room's chapter strip draws and
    what "play the film from B03-S2" seeks against.
    """
    project_or_404(pid)
    want = (name or "").strip("/")
    base = want.split("/")[-1]
    with session_scope() as s:
        rows = s.execute(select(Take)
                         .where(Take.project_id == pid, Take.kind == "animatic")
                         .order_by(Take.created_at.desc())).scalars().all()
        if not rows:
            raise HTTPException(404, "this film has no cuts yet")
        if want in ("", "latest", "newest"):
            take = rows[0]
        else:
            take = next((t for t in rows
                         if t.path == want or t.path.split("/")[-1] == base), None)
        if take is None:
            raise HTTPException(404, f"no cut named {name}")
        meta = take.meta or {}
        scope = (take.params or {}).get("scope", "full")
        edl = meta.get("edl") or _recompute_edl(s, pid, scope)
        total = meta.get("total")
        if total is None and edl:
            total = round(edl[-1]["start"] + edl[-1]["seconds"], 3)
        return {"cut": take.path, "scope": scope, "total": total,
                "shots": len(edl), "edl": edl,
                "recomputed": not meta.get("edl")}


#: take kind -> the lane that paid for it
SPEND_LANES = {
    "still": "still", "i2i": "i2i", "motion": "motion", "crop": "motion",
    "chain": "motion", "fx": "motion", "comp": "comp", "panel": "comp",
    "vo": "vo", "sfx": "sfx", "music": "music", "animatic": "assembly",
}


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

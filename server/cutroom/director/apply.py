"""Apply an EditPlan: state ops mutate the DB inline; generative ops become
jobs (each returns a job id the UI can follow)."""
from __future__ import annotations

import re
import time

from sqlalchemy import select

from .. import film
from ..db import session_scope
from ..jobs.handlers import pick_backend
from ..jobs.queue import submit_job
from ..models import Backend, Comp, Shot
from ..adapters.registry import pool_for
from ..storage import StorageError, get_storage
from .ops import PlanError, validate_plan


def _gen_pool(project: str, lane: str, backend_id: str | None = None) -> str:
    choice = pick_backend(project, lane, backend_id)
    with session_scope() as s:
        row = s.get(Backend, choice.cfg.id)
        return pool_for(row)[0]


def _shot(session, project: str, sid: str) -> Shot:
    shot = session.execute(select(Shot).where(
        Shot.project_id == project, Shot.sid == sid)).scalar_one_or_none()
    if not shot:
        raise PlanError(f"shot {sid} not found")
    return shot


def _update_override(session, project: str, sid: str, patch: dict) -> dict:
    shot = _shot(session, project, sid)
    ov = dict(shot.override or {})
    ov.update({k: v for k, v in patch.items() if v is not None})
    ov = {k: v for k, v in ov.items() if v is not None}
    shot.override = ov
    return ov


PLATE_EXTS = (".png", ".jpg", ".jpeg", ".webp")


def _check_plate(project: str, path: str, what: str) -> str:
    """A plate is a still that EXISTS. Curating a path that is not there is the
    silent-failure the UI cannot see: motion, i2i and comps all start from the
    keeper, so a bad pick only surfaces hours later as a job that dies on
    `Image.open`. Fail here, with the path in the message."""
    path = str(path or "").strip().lstrip("/")
    if not path:
        raise PlanError(f"need a path for the {what}")
    if not path.lower().endswith(PLATE_EXTS):
        raise PlanError(
            f"the {what} has to be a still ({', '.join(PLATE_EXTS)}), got "
            f"{path} — for a clip use the timeline source override instead")
    try:
        exists = get_storage().project(project).exists(path)
    except StorageError as e:
        raise PlanError(str(e))
    if not exists:
        raise PlanError(f"no such file in {project}: {path}")
    return path


def apply_op(project: str, op: dict) -> dict:
    name = op["op"]

    # ---------------- state ops (inline) ----------------------------------
    if name == "set_keeper":
        path = _check_plate(project, op["path"], "keeper")
        with session_scope() as s:
            shot = _shot(s, project, op["shot"])
            previous = shot.keeper
            extra = dict(shot.extra or {})
            hist = extra.get("keeper_history", [])
            if shot.keeper:
                hist.append({"keeper": shot.keeper, "ts": time.time()})
            extra["keeper_history"] = hist[-20:]
            shot.extra = extra
            shot.keeper = path
            if op.get("note"):
                stamp = time.strftime("%m-%d")
                shot.curation_note = ((shot.curation_note + " | ")
                                      if shot.curation_note else "") + \
                    f"[{stamp}] {op['note']}"
            film.touch(s, project, f"new keeper on {op['shot']}")
        # Echo the pick: a caller (the UI, a WebMCP tool) confirms the change
        # from the response instead of assuming the write landed.
        return {"op": name, "applied": True, "shot": op["shot"],
                "keeper": path, "previous": previous}
    if name == "set_source":
        with session_scope() as s:
            _update_override(s, project, op["shot"], {"source": op["source"]})
            film.touch(s, project, f"timeline source set on {op['shot']}")
        return {"op": name, "applied": True, "shot": op["shot"]}
    if name == "set_seconds":
        with session_scope() as s:
            _update_override(s, project, op["shot"],
                             {"seconds": float(op["seconds"])})
            film.touch(s, project, f"{op['shot']} retimed")
        return {"op": name, "applied": True, "shot": op["shot"]}
    if name == "set_vo":
        with session_scope() as s:
            _update_override(s, project, op["shot"],
                             {"vo_file": op.get("file"),
                              "vo_offset": op.get("offset"),
                              "mute_vo": op.get("mute")})
            film.touch(s, project, f"VO changed on {op['shot']}")
        return {"op": name, "applied": True, "shot": op["shot"]}
    if name == "attach_ref":
        with session_scope() as s:
            shot = _shot(s, project, op["shot"])
            ov = dict(shot.override or {})
            refs = list(ov.get("refs", []))
            if op["path"] not in refs:
                refs.append(op["path"])
            ov["refs"] = refs
            shot.override = ov
        return {"op": name, "applied": True, "refs": refs}
    if name == "create_comp":
        cid = re.sub(r"[^A-Za-z0-9-]+", "-",
                     op.get("cid") or f"{op.get('shot', 'comp')}-"
                     f"{int(time.time()) % 100000}")
        with session_scope() as s:
            s.add(Comp(project_id=project, cid=cid,
                       shot_sid=op.get("shot"), background=op["background"],
                       duration=float(op.get("duration", 4.0))))
        return {"op": name, "applied": True, "comp": cid}
    if name == "add_layer":
        with session_scope() as s:
            comp = s.execute(select(Comp).where(
                Comp.project_id == project,
                Comp.cid == op["comp"])).scalar_one_or_none()
            if not comp:
                raise PlanError(f"comp {op['comp']} not found")
            layers = [dict(L) for L in comp.layers]
            lid = f"L{len(layers) + 1}"
            layers.append({"id": lid, "region": op["region"],
                           "prompt": op["prompt"],
                           "feather": op.get("feather", 24),
                           "matte": op.get("matte", "window"),
                           "frames": op.get("frames", 97),
                           "steps": op.get("steps"), "cfg": op.get("cfg"),
                           "media": {"loop": "hold"}, "opacity": 1.0,
                           "z": len(layers) + 1, "clip": None})
            comp.layers = layers
        # a fresh layer needs its cel generated
        with session_scope() as s:
            job = submit_job(s, "comp.layer_reroll",
                             {"project": project, "comp": op["comp"],
                              "layer": lid},
                             project, _gen_pool(project, "motion"),
                             f"cel for {op['comp']}/{lid}")
            jid = job.id
        return {"op": name, "applied": True, "layer": lid, "job": jid}

    # ---------------- job ops ---------------------------------------------
    job_specs = {
        "freeze_tail": ("gen.freeze",
                        {"source": op.get("clip"), "live": op.get("live", 1.0),
                         "total": op.get("total"), "name": op.get("name")},
                        "cpu", f"freeze-tail {op.get('live', 1.0)}s"),
        "trim": ("gen.trim",
                 {"source": op.get("clip"), "start": op.get("start", 0),
                  "end": op.get("end"), "name": op.get("name")},
                 "cpu", "trim"),
        "chain": ("gen.chain",
                  {"plate": op.get("plate"), "beats": op.get("beats"),
                   "name": op.get("name"), "shot": op.get("shot")},
                  None, f"chain ×{len(op.get('beats') or [])}"),
        "gen_still": ("gen.still",
                      {k: op.get(k) for k in ("prompt", "shot", "name",
                                              "seeds", "width", "height",
                                              "backend", "model", "negative")},
                      None, f"still: {op.get('name') or op.get('shot', '')}"),
        "gen_i2i": ("gen.i2i",
                    {k: op.get(k) for k in ("source", "prompt", "denoise",
                                            "shot", "name", "seeds",
                                            "backend", "model")},
                    None, f"i2i d{op.get('denoise', 0.85)}"),
        "gen_motion": ("gen.motion",
                       {k: op.get(k) for k in
                        ("plate", "prompt", "region", "frames", "steps",
                         "cfg", "seed", "feather", "matte", "start_frame",
                         "freeze_after", "shot", "name", "backend", "model")},
                       None, f"motion: {op.get('name') or op.get('shot', '')}"),
        "gen_vo": ("gen.vo",
                   {"text": op.get("text"), "voice": op.get("voice"),
                    "treatment": op.get("treatment"), "shot": op.get("shot"),
                    "name": op.get("name"), "backend": op.get("backend"),
                    **{k: op.get(k) for k in ("stability", "style", "speed")}},
                   None, f"vo: {op.get('shot') or ''}"),
        "reroll_layer": ("comp.layer_reroll",
                         {"comp": op.get("comp"), "layer": op.get("layer"),
                          "prompt": op.get("prompt")},
                         None, f"reroll layer {op.get('layer')}"),
        "reroll_background": ("comp.bg_reroll",
                              {"comp": op.get("comp"),
                               "prompt": op.get("prompt"),
                               "denoise": op.get("denoise", 0.55)},
                              None, f"bg reroll {op.get('comp')}"),
        "render_comp": ("comp.render", {"comp": op.get("comp")}, "cpu",
                        f"render comp {op.get('comp')}"),
        "render_panels": ("panel.render",
                          {"spec": op.get("spec"), "name": op.get("name"),
                           "shot": op.get("shot")},
                          "cpu", f"panels: {op.get('name') or ''}"),
        "assemble": ("animatic.assemble",
                     {"scope": op.get("scope", "full"),
                      "res": op.get("res", "720")},
                     "cpu", f"cut the film: {op.get('scope', 'full')} @ "
                            f"{op.get('res', '720')}p"),
    }
    if name not in job_specs:
        raise PlanError(f"op {name} has no applier")
    jtype, payload, pool, title = job_specs[name]
    payload = {"project": project,
               **{k: v for k, v in payload.items() if v is not None}}
    if pool is None:
        lane = {"gen.still": "still", "gen.i2i": "i2i", "gen.motion": "motion",
                "gen.chain": "motion", "gen.vo": "vo",
                "comp.layer_reroll": "motion",
                "comp.bg_reroll": "i2i"}[jtype]
        pool = _gen_pool(project, lane, payload.get("backend"))
    with session_scope() as s:
        job = submit_job(s, jtype, payload, project, pool, title)
        jid = job.id
    return {"op": name, "job": jid, "pool": pool, "title": title}


def apply_plan(project: str, plan: dict) -> dict:
    plan = validate_plan(plan)
    results = [apply_op(project, op) for op in plan["ops"]]
    return {"note": plan.get("note", ""), "results": results}

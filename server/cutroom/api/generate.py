from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..adapters import build_adapter
from ..adapters import motion_models
from ..adapters import motion_profiles as mprof
from ..adapters.registry import ADAPTER_TYPES, pool_for
from ..db import session_scope
from ..director.apply import _gen_pool
from ..jobs.queue import submit_job
from ..models import Backend
from .. import budget, demo
from .deps import project_or_404

router = APIRouter()

LANE_JOBS = {
    "still": ("gen.still", "still"),
    "i2i": ("gen.i2i", "i2i"),
    "motion": ("gen.motion", "motion"),
    "chain": ("gen.chain", "motion"),
    "freeze": ("gen.freeze", None),
    "trim": ("gen.trim", None),
    "vo": ("gen.vo", "vo"),
    "sfx": ("gen.sfx", "sfx"),
    "music": ("gen.sfx", "music"),
}


MOTION_LANES = ("motion", "chain")


def apply_motion_profile(pid: str, lane: str, body: dict) -> dict:
    """Resolve `seconds` -> frames against the chosen backend's profile.

    Doctrine (2026-09-02): a clip plays in FULL. `freeze_after` is applied only
    when the caller asks for it — it is a repair tool for a clip that drifts,
    not a default. `seconds` defaults to the profile's own clip length.
    """
    if lane not in MOTION_LANES:
        return body
    bid = budget.resolve_backend_id(pid, "motion", body.get("backend"))
    # a per-shot model (plan_motion picks one) owns the clip length and price
    if body.get("model"):
        body["model"] = motion_models.resolve_id(body["model"]) or body["model"]
    prof = mprof.backend_profile(bid, body.get("model"))
    seconds = body.get("seconds")
    if seconds is None and body.get("frames") is None:
        seconds = mprof.seconds_default(prof)
    if seconds is not None:
        seconds = mprof.clamp_seconds(prof, seconds)
        body["seconds"] = seconds
        body.setdefault("frames", mprof.frames_for_seconds(prof, seconds))
    elif body.get("frames") is not None:
        body["seconds"] = mprof.seconds_for_frames(prof, body["frames"])
    # `live_seconds` is the explicit opt-in spelling of freeze_after.
    if body.get("live_seconds") is not None and body.get("freeze_after") is None:
        body["freeze_after"] = mprof.clamp_live(prof, body.pop("live_seconds"))
    body.pop("live_seconds", None)
    body["motion_profile"] = {"backend": bid, **prof}
    return body


@router.post("/projects/{pid}/generate/{lane}")
async def generate(pid: str, lane: str, req: Request):
    project_or_404(pid)
    if lane not in LANE_JOBS:
        raise HTTPException(404, f"no lane {lane} "
                            f"(know: {sorted(LANE_JOBS)})")
    body = await req.json()
    jtype, pool_lane = LANE_JOBS[lane]
    # Demo guards: per-token rate limit, then the rolling 24h spend cap. Both
    # are no-ops off the demo, and free backends (mock, local ComfyUI) never
    # trip either — the fallback the errors point at always works.
    takes = max(1, len(body.get("seeds") or []) or int(body.get("count", 1)))
    paid = budget.is_paid(budget.resolve_backend_id(
        pid, pool_lane, body.get("backend"))) if pool_lane else False
    demo.rate_limit(req, paid=paid)
    budget.check_submission(pid, pool_lane, body.get("backend"), takes)
    if lane == "music":
        body["lane"] = "music"
    body = apply_motion_profile(pid, lane, body)
    payload = {"project": pid, **body}
    if pool_lane is None:
        pool = "cpu"
    else:
        try:
            pool = _gen_pool(pid, pool_lane, body.get("backend"))
        except RuntimeError as e:
            raise HTTPException(400, str(e))
    title = body.get("title") or f"{lane}: " + str(
        body.get("name") or body.get("shot") or body.get("prompt",
                                                         ""))[:60]
    with session_scope() as s:
        job = submit_job(s, jtype, payload, pid, pool, title)
        return {"job": job.id, "pool": pool}


@router.get("/lanes")
def lane_registry():
    """lane → backends that can serve it (for the model pickers)."""
    out: dict[str, list[dict]] = {}
    with session_scope() as s:
        for b in s.query(Backend).all():
            cls = ADAPTER_TYPES.get(b.type)
            lanes = sorted(getattr(cls, "lanes", set())) if cls else \
                (["direction"] if b.type in ("anthropic", "openai-chat",
                                             "claude-cli") else [])
            for lane in lanes:
                out.setdefault(lane, []).append(
                    {"id": b.id, "label": b.label or b.id, "type": b.type,
                     "enabled": b.enabled,
                     "pool": pool_for(b)[0] if cls else None})
    return out


@router.get("/backends/{bid}/models")
async def backend_models(bid: str, lane: str = "still"):
    with session_scope() as s:
        b = s.get(Backend, bid)
        if not b:
            raise HTTPException(404, bid)
        adapter = None
        if b.type in ADAPTER_TYPES:
            adapter = build_adapter(b)
    if adapter is None:
        return {"models": []}
    try:
        return {"models": await adapter.list_models(lane)}
    except Exception as e:
        raise HTTPException(502, f"model discovery failed: {e}")

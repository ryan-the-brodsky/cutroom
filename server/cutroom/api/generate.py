from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..adapters import build_adapter
from ..adapters import motion_models
from ..adapters import motion_profiles as mprof
from ..adapters.registry import ADAPTER_TYPES, pool_for
from ..db import session_scope
from ..director.apply import _gen_pool
from ..engine.audio import TREATMENT_NAMES
from ..jobs.queue import submit_job
from ..models import Backend
from ..storage import StorageError
from .. import budget, demo
from .deps import project_or_404, store_for

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

# The image (or clip) a lane starts FROM, named by the field its handler reads.
# `source` is the one spelling every caller can use — the motion lanes call it
# `plate` internally, so it is normalised here rather than in each client.
LANE_SOURCE_FIELD = {"motion": "plate", "chain": "plate", "i2i": "source",
                     "freeze": "source", "trim": "source"}
PLATE_EXTS = (".png", ".jpg", ".jpeg", ".webp")


def resolve_lane_source(pid: str, lane: str, body: dict) -> dict:
    """Normalise `source` -> the lane's own field and check the file is there.

    A motion job that starts from a path nobody has is the worst failure this
    app has: the submit succeeds, a clip comes back minutes later, and it is
    animated from the wrong frame (or the job dies deep in a handler). Both
    the alias and the existence check happen here so every caller — the
    console, a WebMCP tool, a curl — fails the same way, at submit time, with
    the path in the message.

    An absent source is left to the handler: some lanes fill it themselves,
    and the UI already refuses to submit without one.
    """
    field = LANE_SOURCE_FIELD.get(lane)
    if not field:
        return body
    if field != "source" and body.get("source"):
        alias = str(body.pop("source") or "").strip()
        have = str(body.get(field) or "").strip()
        if have and have != alias:
            raise HTTPException(400, (
                f"{lane} got two different sources: `source`={alias} and "
                f"`{field}`={have} — pass one"))
        body[field] = alias
    path = str(body.get(field) or "").strip().lstrip("/")
    if not path:
        return body
    if field == "plate" and not path.lower().endswith(PLATE_EXTS):
        raise HTTPException(400, (
            f"{lane} animates a still ({', '.join(PLATE_EXTS)}), got {path} — "
            "to animate from a clip, freeze or trim it instead"))
    try:
        exists = store_for(pid).exists(path)
    except StorageError as e:
        raise HTTPException(400, str(e))
    if not exists:
        raise HTTPException(400, f"no such file in {pid}: {path}")
    body[field] = path
    return body


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


def apply_vo_treatment(body: dict) -> dict:
    """Normalise the voice treatment: a named chain the line is heard through.

    Default is `none` — the platform has no house sound. `futz: true` was the
    single-film spelling of `treatment: "radio"`; it still works for one
    release."""
    name = body.pop("treatment", None)
    legacy = body.pop("futz", None)
    if name is None and legacy:
        name = "radio"
    name = str(name or "none").strip().lower()
    if name not in TREATMENT_NAMES:
        raise HTTPException(400, f"no voice treatment {name!r} "
                                 f"(know: {', '.join(TREATMENT_NAMES)})")
    if name != "none":
        body["treatment"] = name
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
    if lane == "vo":
        body = apply_vo_treatment(body)
    body = resolve_lane_source(pid, lane, body)
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

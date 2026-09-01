from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..adapters import build_adapter
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

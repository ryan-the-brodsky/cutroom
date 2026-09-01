from __future__ import annotations

import json
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from ..db import session_scope
from ..director import grammar, planner
from ..director.apply import apply_plan
from ..director.ops import OPS, PlanError, validate_plan
from ..engine import ffmpeg as e_ff
from ..models import Backend, ChatMessage, LaneConfig, Shot
from ..storage import get_storage
from .. import film
from .deps import project_or_404, store_for

router = APIRouter()

DIRECTION_TYPES = ("anthropic", "openai-chat", "claude-cli")


def _lane_direction(session, pid: str | None) -> LaneConfig | None:
    if not pid:
        return None
    return session.execute(select(LaneConfig).where(
        LaneConfig.project_id == pid,
        LaneConfig.lane == "direction")).scalar_one_or_none()


def _direction_backends(session, pid: str | None = None) -> list[Backend]:
    """Enabled direction providers, the project's `direction` lane default
    first — that is what makes CUTROOM_LANE_DIRECTION=openrouter:<model>
    actually route the planner and the director chat."""
    rows = [b for b in session.execute(select(Backend).where(
        Backend.enabled.is_(True))).scalars() if b.type in DIRECTION_TYPES]
    lc = _lane_direction(session, pid)
    if lc and lc.backend_id:
        rows.sort(key=lambda b: 0 if b.id == lc.backend_id else 1)
    return rows


def _apply_lane_model(backend: Backend, pid: str | None) -> Backend:
    """Lane-configured model wins over the backend's own default. Call after
    expunge — the row is detached, so this never writes to the DB."""
    with session_scope() as s:
        lc = _lane_direction(s, pid)
        if lc and lc.backend_id == backend.id and lc.model:
            backend.options = {**(backend.options or {}), "model": lc.model}
    return backend


def _context(pid: str, shot_sid: str | None, asset: str | None) -> dict:
    store = get_storage().project(pid)
    ctx: dict = {"project": pid}
    if asset:
        ctx["asset"] = asset
    if shot_sid:
        with session_scope() as s:
            shot = s.execute(select(Shot).where(
                Shot.project_id == pid,
                Shot.sid == shot_sid)).scalar_one_or_none()
            if shot:
                takes = film.takes_by_shot(s, pid).get(shot_sid, [])
                entry = film.film_entry(store, shot, takes)
                ctx["shot"] = shot_sid
                ctx["shot_state"] = {k: entry[k] for k in
                                     ("seconds", "keeper", "active_source",
                                      "motion", "fx", "vo", "override")}
                if not asset and entry["active_source"]:
                    ctx["asset"] = entry["active_source"]
                vo = entry["vo"]
                ov = entry["override"]
                vo_file = ov.get("vo_file") or (vo[0] if vo else None)
                if vo_file and store.exists(vo_file):
                    try:
                        ctx["vo_duration"] = e_ff.probe_duration(
                            store.resolve(vo_file))
                    except Exception:
                        pass
    return ctx


@router.get("/ops")
def ops_vocabulary():
    return {name: {a: {"required": req, "hint": d}
                   for a, (req, d) in schema.items()}
            for name, schema in OPS.items()}


@router.post("/projects/{pid}/direct")
async def direct(pid: str, req: Request):
    """Instruction → EditPlan (a PREVIEW — nothing runs until /plan/apply).
    The deterministic grammar goes first; an LLM planner backend picks up
    what the grammar can't parse."""
    project_or_404(pid)
    body = await req.json()
    instruction = body.get("instruction", "").strip()
    if not instruction:
        raise HTTPException(400, "need instruction")
    ctx = _context(pid, body.get("shot"), body.get("asset"))
    plan = grammar.parse(instruction, ctx)
    if plan:
        return {"plan": plan, "source": "grammar", "context": ctx}
    with session_scope() as s:
        planners = [b for b in _direction_backends(s, pid)
                    if b.type in ("anthropic", "openai-chat")]
        if body.get("provider"):
            planners = [b for b in planners if b.id == body["provider"]]
        if not planners:
            raise HTTPException(422, "the grammar could not parse that and no "
                                "LLM planner backend is enabled — rephrase "
                                "with the edit grammar or configure a "
                                "direction backend")
        backend = planners[0]
        s.expunge(backend)
        _apply_lane_model(backend, pid)
    try:
        plan = await planner.plan(instruction, ctx, backend)
    except (planner.PlannerError, PlanError) as e:
        raise HTTPException(502, str(e))
    return {"plan": plan, "source": backend.id, "context": ctx}


@router.post("/projects/{pid}/plan/apply")
async def plan_apply(pid: str, req: Request):
    project_or_404(pid)
    body = await req.json()
    try:
        plan = validate_plan(body)
        return apply_plan(pid, plan)
    except PlanError as e:
        raise HTTPException(400, str(e))


@router.post("/projects/{pid}/chat")
async def chat(pid: str, req: Request):
    """Director chat over SSE. Providers: anthropic (agentic, hosted-safe
    tools) · openai-chat (advisory) · claude-cli (self-host)."""
    project_or_404(pid)
    body = await req.json()
    message = body.get("message", "").strip()
    if not message:
        raise HTTPException(400, "need message")
    with session_scope() as s:
        backends = _direction_backends(s, pid)
        if body.get("provider"):
            backends = [b for b in backends if b.id == body["provider"]]
        if not backends:
            raise HTTPException(422, "no direction backend enabled")
        backend = backends[0]
        s.expunge(backend)
        _apply_lane_model(backend, pid)
        s.add(ChatMessage(project_id=pid, role="director", text=message,
                          provider=backend.id,
                          context={k: body.get(k) for k in ("shot", "asset")}))

    from ..director.providers import stream_for
    stream = stream_for(backend)
    if stream is None:
        raise HTTPException(422, f"backend {backend.id} cannot chat")
    ctx = _context(pid, body.get("shot"), body.get("asset"))

    async def sse():
        collected = []
        try:
            async for ev in stream(pid, message, backend, ctx):
                if ev.get("kind") in ("text", "done"):
                    collected.append(ev.get("text", ""))
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'kind': 'error', 'text': str(e)})}\n\n"
        with session_scope() as s2:
            s2.add(ChatMessage(project_id=pid, role="assistant",
                               provider=backend.id,
                               text="\n".join(collected)[-8000:]))
    return StreamingResponse(sse(), media_type="text/event-stream")


@router.get("/projects/{pid}/chat/history")
def chat_history(pid: str, limit: int = 50):
    project_or_404(pid)
    with session_scope() as s:
        rows = s.execute(select(ChatMessage).where(
            ChatMessage.project_id == pid)
            .order_by(ChatMessage.ts.desc()).limit(limit)).scalars()
        return list(reversed([{"role": m.role, "text": m.text,
                               "provider": m.provider, "ts": m.ts,
                               "context": m.context} for m in rows]))


@router.post("/projects/{pid}/animatic")
async def animatic(pid: str, req: Request):
    """Cut the film from current state (keepers + overrides + takes)."""
    project_or_404(pid)
    body = await req.json()
    res = str(body.get("res", "720"))
    scope = str(body.get("scope", "full"))
    if res not in ("720", "1080"):
        raise HTTPException(400, "res must be 720 or 1080")
    import re as _re
    if not _re.match(r"^(full|act[0-9])$", scope):
        raise HTTPException(400, "scope must be full or actN")
    from ..jobs.queue import submit_job
    with session_scope() as s:
        job = submit_job(s, "animatic.assemble",
                         {"project": pid, "scope": scope, "res": res,
                          "cues": body.get("cues")},
                         pid, "cpu",
                         f"cut the film: {scope} @ {res}p")
        return {"job": job.id}

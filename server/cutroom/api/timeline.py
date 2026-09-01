"""Timeline endpoints — compile the film into the clip model, and project it
onto the FreeCut engine's render input."""
from __future__ import annotations

from fastapi import APIRouter, Request

from ..db import session_scope
from ..engine_render import engine_available
from ..jobs.queue import submit_job
from ..timeline.compile import compile_film_cached, to_freecut_render_input
from .deps import store_for

router = APIRouter()


@router.get("/projects/{pid}/timeline")
def get_timeline(pid: str, fps: int = 24):
    """The Cutroom timeline model: the film as real clips (source in/out,
    handles, lineage) rather than shot slots."""
    store = store_for(pid)
    with session_scope() as s:
        tl = compile_film_cached(store, s, pid, fps=fps)
    return tl.to_dict()


@router.get("/projects/{pid}/timeline/freecut")
def get_timeline_freecut(pid: str, container: str = "mp4"):
    """The same timeline projected onto the FreeCut engine's renderTimeline
    input (media entries carry the project-relative `rel`; the render harness
    fills `url`). Useful for inspection and for driving the engine."""
    store = store_for(pid)
    with session_scope() as s:
        tl = compile_film_cached(store, s, pid)
    return to_freecut_render_input(tl, container=container)


@router.post("/projects/{pid}/timeline/render")
async def render_timeline(pid: str, req: Request):
    """Render the compiled timeline through the lifted FreeCut engine (a job).
    Body: {scope_sec?: number, container?: "mp4"|"webm"}."""
    store_for(pid)
    body = {}
    try:
        body = await req.json()
    except Exception:
        pass
    if not engine_available():
        from fastapi import HTTPException
        raise HTTPException(503, "render engine unavailable "
                            "(set CUTROOM_ENGINE_DIR / CUTROOM_NODE_BIN)")
    scope_sec = body.get("scope_sec")
    title = "timeline render (engine)"
    if scope_sec:
        title = f"timeline render — first {scope_sec}s"
    with session_scope() as s:
        job = submit_job(
            s, "timeline.render",
            {"project": pid, "scope_sec": scope_sec,
             "container": body.get("container", "mp4")},
            pid, "cpu", title)
        return {"job": job.id}


@router.get("/projects/{pid}/timeline/engine")
def timeline_engine_status(pid: str):
    """Whether the render engine is configured (drives the UI's render button)."""
    store_for(pid)
    return {"available": engine_available()}


@router.get("/projects/{pid}/timeline/otio")
def timeline_otio(pid: str):
    """The timeline as OpenTimelineIO (.otio) JSON — opens natively in Resolve,
    Nuke Studio, Kdenlive. Lineage rides under each clip's metadata.cutroom."""
    from ..timeline.interchange import to_otio
    store = store_for(pid)
    with session_scope() as s:
        tl = compile_film_cached(store, s, pid)
    return to_otio(tl, name=pid)


@router.get("/projects/{pid}/timeline/edl")
def timeline_edl(pid: str):
    """The timeline as a CMX3600 EDL (the universal conform format)."""
    from fastapi.responses import PlainTextResponse

    from ..timeline.interchange import to_edl
    store = store_for(pid)
    with session_scope() as s:
        tl = compile_film_cached(store, s, pid)
    return PlainTextResponse(to_edl(tl, title=pid),
                             headers={"Content-Disposition":
                                      f'attachment; filename="{pid}.edl"'})

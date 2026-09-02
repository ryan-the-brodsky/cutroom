"""Music and SFX cues — read, add, remove.

Deliberately NOT admin-gated: placing a cue is an edit a judge (or an agent
driving the page on their behalf) should be able to make on the hosted demo.
It writes JSON on the project, costs nothing, and `cut the film` is what
turns it into audio.

Gain is decibels everywhere. See `cutroom/cues.py` for the record shape.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import cues as C
from ..storage import get_storage
from .deps import project_or_404

router = APIRouter()


@router.get("/projects/{pid}/cues")
def list_cues(pid: str, scope: str = "full"):
    """`{music:[…], sfx:[…]}` — each cue with its resolved film time `at`."""
    project_or_404(pid)
    sheet = C.sheet(pid, scope)
    store = get_storage().project(pid)
    for rows in sheet.values():
        for row in rows:
            row["exists"] = store.exists(row["path"])
    return sheet


@router.post("/projects/{pid}/cues")
async def add_cue(pid: str, req: Request):
    """Place one cue. `{kind, path, start|shot, offset?, duration?, gain?,
    fade_in?, fade_out?, loop?, label?}` → the stored cue with its id."""
    project_or_404(pid)
    body = await req.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "expected a cue object")
    kind = str(body.get("kind") or "").strip().lower()
    if kind not in C.KINDS:
        # Infer from the path when the caller left it out: audio/music/… .
        path = C.cue_path(body) or ""
        kind = "music" if "/music/" in path else "sfx" if "/sfx/" in path else ""
    if kind not in C.KINDS:
        raise HTTPException(400, f"kind must be one of {list(C.KINDS)}")
    try:
        cue = C.add(pid, kind, body)
    except C.CueError as e:
        raise HTTPException(400, str(e))
    store = get_storage().project(pid)
    at = C.film_start(cue, C.shot_starts(pid))
    return {"cue": cue, "at": at, "exists": store.exists(cue["path"])}


@router.post("/projects/{pid}/cues/{cue_id}/delete")
def delete_cue(pid: str, cue_id: str):
    project_or_404(pid)
    removed = C.delete(pid, cue_id)
    if removed is None:
        raise HTTPException(404, f"no cue {cue_id}")
    return {"ok": True, "removed": removed}

"""The public surface of an invite-only studio.

Everything else under `/api` is behind `deps.require_auth`. This router is
mounted WITHOUT that dependency (see `main.create_app`) because it is the one
thing a visitor with no invite is allowed to have: the finished film, and the
two links that tell them how to get in.

Two routes, both read-only, both anonymous:

  GET /api/public           `{access_form_url, video_url, film}`
  GET /api/public/film.mp4  the demo project's newest assembled cut

The film is *only ever* `settings.demo_project`'s newest `animatic` take. It is
not a project parameter and cannot be pointed at anything else, so adding a
private project to a hosted instance can never publish it by accident.

`CUTROOM_ACCESS_FORM_URL` (the request-access Google Form) and
`CUTROOM_DEMO_VIDEO_URL` (the walkthrough on YouTube) are read here rather than
baked into the SPA bundle, so the owner sets them on the host and the next page
load has them — no rebuild.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select

from ..config import get_settings
from ..db import session_scope
from ..models import Project, Take
from ..storage import StorageError, get_storage

router = APIRouter()

#: Where the public player fetches the cut. Stable; the SPA hard-codes nothing else.
FILM_URL = "/api/public/film.mp4"


def _newest_cut() -> tuple[Path, str, float | None] | None:
    """(file, label, seconds) for the demo project's newest cut, or None.

    Newest *that still exists on disk*: `admin.py` prunes old animatics to free
    space, and a row whose file is gone must not become a 404 button on the
    front page while an older, playable cut is sitting right there.

    Length comes off the take's own metadata (the assembler records `total`, and
    the EDL adds up to the same number). Deliberately no ffprobe: this endpoint
    is unauthenticated, and an anonymous request must never be able to spawn a
    subprocess.
    """
    settings = get_settings()
    pid = settings.demo_project
    if not pid:
        return None
    try:
        store = get_storage().project(pid)
    except StorageError:
        return None
    with session_scope() as s:
        project = s.get(Project, pid)
        if project is None:
            return None
        label = project.label or pid
        rows = s.execute(
            select(Take)
            .where(Take.project_id == pid, Take.kind == "animatic")
            .order_by(Take.created_at.desc())).scalars().all()
        for take in rows:
            try:
                path = store.resolve(take.path)
            except StorageError:
                continue
            if not path.is_file():
                continue
            meta = take.meta or {}
            seconds = meta.get("total")
            edl = meta.get("edl") or []
            if seconds is None and edl:
                seconds = edl[-1].get("start", 0) + edl[-1].get("seconds", 0)
            return path, label, (round(float(seconds), 3)
                                 if seconds is not None else None)
    return None


@router.get("/public")
def public_config() -> dict:
    """What a tokenless visitor may know about this instance.

    Empty strings, not nulls, for the two links: an unset variable is "there is
    no such button", and the SPA renders nothing rather than a dead one.
    """
    settings = get_settings()
    found = _newest_cut()
    film = None
    if found is not None:
        _, label, seconds = found
        film = {"url": FILM_URL, "label": label, "seconds": seconds}
    return {"access_form_url": (settings.access_form_url or "").strip(),
            "video_url": (settings.demo_video_url or "").strip(),
            "film": film}


@router.get("/public/film.mp4")
def public_film() -> FileResponse:
    """Stream the demo project's newest cut, no token.

    `FileResponse` answers Range requests, which is what lets `<video>` seek
    instead of downloading 130 seconds before it will scrub.
    """
    found = _newest_cut()
    if found is None:
        raise HTTPException(404, "this instance has no public cut yet")
    path, _, _ = found
    return FileResponse(path, media_type="video/mp4",
                        headers={"Cache-Control": "public, max-age=300"})

"""Per-shot audio plan — what a reviewer should HEAR under one shot.

The assembler mixes VO, the music bed and SFX only at cut time, so the Shot
Editor monitor used to play a take in silence. This endpoint hands the browser
the same placement the cut would use, scoped to one shot's window, so the web
mixer (`web/src/audio/shotMix.ts`) can play it live.

Placement is NOT re-derived here. The shot's start and length come from the
compiled timeline (`timeline.compile.compile_film_cached` — the same clip
starts the renderer uses, behind its fingerprint cache), the VO comes from the
A1 clip that compile already placed at head_pad + vo_offset, and cue anchors
resolve through `cues.film_start` against those same starts.

Times in the reply are SHOT-RELATIVE seconds (`at`), except `shot_start`,
which is film time. Gain is decibels everywhere, as in the cue sheet.
"""
from __future__ import annotations

from functools import lru_cache

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from .. import cues as C
from .. import film
from ..db import session_scope
from ..engine import ffmpeg as ff
from ..models import Shot
from ..timeline import model as m
from ..timeline.compile import HEAD_PAD, compile_film_cached
from .deps import store_for

router = APIRouter()

EPS = 1e-6


@lru_cache(maxsize=4096)
def _probe_audio(path_str: str) -> float | None:
    """Length of an audio file in seconds. Cached — renders are immutable."""
    try:
        d = float(ff.probe_duration(path_str))
    except Exception:
        return None
    return d if d > 0 else None


def _r(x) -> float:
    return round(float(x), 3)


def _num(v, d: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def _windows(tl) -> tuple[dict[str, tuple[float, float]], dict[str, float]]:
    """(sid → (start, seconds)) from the compiled picture clips, plus the
    anchor map (sid and beat → start) cue resolution hangs off."""
    fps = tl.fps
    windows: dict[str, tuple[float, float]] = {}
    anchors: dict[str, float] = {}
    for c in tl.clips:
        if c.kind not in m.VISUAL_KINDS:
            continue
        sid = (c.cutroom or {}).get("shot")
        if not sid:
            continue
        start = m.frames_to_seconds(c.start, fps)
        windows[sid] = (start, m.frames_to_seconds(c.duration, fps))
        anchors.setdefault(sid, start)
        # beats resolve to their first shot, as the assembler's do
        for beat in ((c.cutroom or {}).get("beat"), str(sid).split("-")[0]):
            if beat:
                anchors.setdefault(str(beat), start)
    return windows, anchors


def _vo_from_timeline(tl, sid: str, shot_start: float) -> dict | None:
    """The first VO line compile placed under this shot (head_pad + offset)."""
    fps = tl.fps
    rows = [c for c in tl.clips
            if c.kind == "audio"
            and (c.cutroom or {}).get("role") == "vo"
            and (c.cutroom or {}).get("shot") == sid]
    if not rows:
        return None
    c = min(rows, key=lambda c: c.start)
    return {"path": c.source,
            "at": _r(m.frames_to_seconds(c.start, fps) - shot_start),
            "duration": _r(m.frames_to_seconds(c.duration, fps)),
            "muted": False}


def _vo_muted(store, sid: str, beat: str | None, override: dict,
              takes: list) -> dict | None:
    """A muted shot emits no A1 clip, but the reviewer still wants to see
    which line is being silenced — so report it with `muted: true`."""
    rels = ([override["vo_file"]] if override.get("vo_file")
            else film.vo_paths(store, sid, beat, takes))
    for rel in rels:
        if not store.exists(rel):
            continue
        dur = _probe_audio(str(store.resolve(rel)))
        return {"path": rel,
                "at": _r(HEAD_PAD + _num(override.get("vo_offset"), 0.0)),
                "duration": _r(dur) if dur else None,
                "muted": True}
    return None


def _cue_rows(store, kind: str, raw: list[dict], anchors: dict[str, float],
              shot_start: float, shot_end: float) -> list[dict]:
    """Cues that actually sound inside [shot_start, shot_end), clipped to it.

    A bed that started three shots ago is still playing here, so it reports
    `offset_into_file` — how far into the file the shot's head lands."""
    rows: list[dict] = []
    for c in raw:
        rel = C.cue_path(c)
        if not rel or not store.exists(rel):
            continue
        at = C.film_start(c, anchors)
        if at is None:                       # anchored to a shot not in the cut
            continue
        file_dur = _probe_audio(str(store.resolve(rel)))
        span = C.cue_duration(c) or file_dur
        if not span:
            continue
        end = at + span
        if end <= shot_start + EPS or at >= shot_end - EPS:
            continue
        head = max(0.0, shot_start - at)
        into = head
        if c.get("loop") and file_dur:
            into = head % file_dur           # a loop wraps back into the file
        rows.append({
            "id": c.get("id"),
            "kind": kind,
            "path": rel,
            "at": _r(max(0.0, at - shot_start)),
            "offset_into_file": _r(into),
            "duration_in_shot": _r(min(end, shot_end) - max(at, shot_start)),
            "gain_db": _r(C.cue_gain_db(c, kind)),
            "fade_in": _r(_num(c.get("fade_in"), 0.0)),
            "fade_out": _r(_num(c.get("fade_out"), 0.0)),
            "loop": bool(c.get("loop")),
            "label": c.get("label"),
        })
    rows.sort(key=lambda r: r["at"])
    return rows


@router.get("/projects/{pid}/shots/{sid}/audio-plan")
def audio_plan(pid: str, sid: str) -> dict:
    """`{shot_start, seconds, vo, music[], sfx[]}` for one shot's window."""
    store = store_for(pid)
    with session_scope() as s:
        shot = s.execute(
            select(Shot).where(Shot.project_id == pid, Shot.sid == sid)
        ).scalars().first()
        if shot is None:
            raise HTTPException(404, f"no shot {sid}")
        override = dict(shot.override or {})
        beat = shot.beat
        scripted = _num(override.get("seconds", shot.seconds), 0.0)
        takes = film.takes_by_shot(s, pid).get(sid, [])
        tl = compile_film_cached(store, s, pid)
        windows, anchors = _windows(tl)
        shot_start, seconds = windows.get(sid, (None, scripted))
        if shot_start is None:               # not in the compile (no picture)
            shot_start = C.shot_starts(pid).get(sid, 0.0)
            anchors.setdefault(sid, shot_start)
        if override.get("mute_vo"):
            vo = _vo_muted(store, sid, beat, override, takes)
        else:
            vo = _vo_from_timeline(tl, sid, shot_start)

    shot_end = shot_start + seconds
    sheet = C.read_all(pid)
    return {
        "sid": sid,
        "shot_start": _r(shot_start),
        "seconds": _r(seconds),
        "head_pad": HEAD_PAD,
        "vo": vo,
        "music": _cue_rows(store, "music", sheet["music"], anchors,
                           shot_start, shot_end),
        "sfx": _cue_rows(store, "sfx", sheet["sfx"], anchors,
                         shot_start, shot_end),
    }

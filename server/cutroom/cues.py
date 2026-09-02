"""Music and SFX cues — the film's audio bed, stored on the project.

A cue is a piece of audio placed on the film's timeline. Cues live in
`Project.settings["music_cues"]` and `["sfx_cues"]` — the same two keys the
folder importer writes and the timeline compiler already reads
(`timeline/compile.py::_compile_cues`) — so an imported film's cue sheet and
one an agent builds by hand are the same thing.

CANONICAL SHAPE (what this module writes; the readers accept more, see below):

    {"id": "cue_a1b2c3d4", "kind": "music"|"sfx",
     "path": "audio/music/opening.mp3",     # project-relative
     "start": 12.5,                          # absolute film seconds, OR
     "shot":  "B10-S2",                      # anchor to a shot's start
     "offset": 0.0,                          # seconds added to either anchor
     "duration": 20.0,                       # optional trim, seconds
     "gain": -16.0,                          # DECIBELS (0 = unity, -16 = bed)
     "fade_in": 0.5, "fade_out": 1.5,        # seconds
     "loop": false,                          # repeat to fill `duration`
     "label": "…", "created_at": 1756...}

GAIN IS ALWAYS DECIBELS. 0 dB is unity (as loud as the file), negative is
quieter. Defaults: music -16 dB (a bed under narration), SFX -8 dB (an
accent). The importer's `gain-hint` free text ("-16dB under narration") is
parsed for its leading number and otherwise ignored.

Legacy shapes preserved (the importer's, from audio/*-cues.jsonl):
  source key   path | file | source | sfx-file | sfx_file | music-file | music_file
  duration key duration | duration_s | duration_seconds
  gain key     gain | gain_db | gain-hint | gain_hint
  anchors      shot | shots[] | beats[]  (a beat id anchors to its first shot)
"""
from __future__ import annotations

import re
import time
import uuid

from sqlalchemy import select

from .db import session_scope
from .models import Project, Shot

KINDS = ("music", "sfx")
SETTINGS_KEY = {"music": "music_cues", "sfx": "sfx_cues"}
DEFAULT_GAIN_DB = {"music": -16.0, "sfx": -8.0}

SRC_KEYS = ("path", "file", "source", "sfx-file", "sfx_file",
            "music-file", "music_file")
DUR_KEYS = ("duration", "duration_s", "duration_seconds")
GAIN_KEYS = ("gain", "gain_db", "gain-hint", "gain_hint")

_GAIN_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*db", re.I)


def cue_get(cue: dict, keys: tuple[str, ...]):
    for k in keys:
        v = cue.get(k)
        if v not in (None, ""):
            return v
    return None


def cue_path(cue: dict) -> str | None:
    v = cue_get(cue, SRC_KEYS)
    return str(v) if v else None


def parse_gain_db(raw, default: float = 0.0) -> float:
    """A number is dB. A string is scanned for a leading `-16dB`-ish token."""
    if raw is None or raw == "":
        return default
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    m = _GAIN_RE.search(str(raw))
    if m:
        return float(m.group(1))
    try:
        return float(str(raw).strip())
    except ValueError:
        return default


def cue_gain_db(cue: dict, kind: str = "music") -> float:
    return parse_gain_db(cue_get(cue, GAIN_KEYS),
                         DEFAULT_GAIN_DB.get(kind, 0.0))


def cue_duration(cue: dict) -> float | None:
    v = cue_get(cue, DUR_KEYS)
    if v is None:
        return None
    try:
        d = float(v)
    except (TypeError, ValueError):
        return None
    return d if d > 0 else None


def cue_anchor(cue: dict) -> str | None:
    """The shot (or beat) this cue hangs off, if any."""
    sid = cue.get("shot")
    if sid:
        return str(sid)
    anchors = cue.get("shots") or cue.get("beats")
    if isinstance(anchors, str):
        return anchors
    if isinstance(anchors, list) and anchors:
        return str(anchors[0])
    return None


def _num(raw, default: float = 0.0) -> float:
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def new_id() -> str:
    return f"cue_{uuid.uuid4().hex[:8]}"


class CueError(ValueError):
    """A cue the caller got wrong — rendered as HTTP 400."""


def normalize(kind: str, body: dict, *, keep_id: str | None = None) -> dict:
    """Body (any accepted shape) → the canonical record. Raises CueError."""
    if kind not in KINDS:
        raise CueError(f"kind must be one of {list(KINDS)}")
    path = cue_path(body)
    if not path:
        raise CueError("a cue needs `path` — the project-relative audio file "
                       "(e.g. audio/music/opening.mp3)")
    shot = cue_anchor(body)
    start = body.get("start")
    if start is None and not shot:
        start = 0.0                       # unanchored → the head of the film
    cue: dict = {
        "id": keep_id or str(body.get("id") or new_id()),
        "kind": kind,
        "path": path,
        "offset": round(_num(body.get("offset"), 0.0), 3),
        "gain": round(cue_gain_db(body, kind), 2),
        "created_at": body.get("created_at") or time.time(),
    }
    if start is not None:
        cue["start"] = round(_num(start, 0.0), 3)
    if shot:
        cue["shot"] = shot
    dur = cue_duration(body)
    if dur:
        cue["duration"] = round(dur, 3)
    for k in ("fade_in", "fade_out"):
        v = _num(body.get(k), 0.0)
        if v > 0:
            cue[k] = round(v, 3)
    if body.get("loop"):
        cue["loop"] = True
        if not cue.get("duration"):
            raise CueError("loop needs a `duration` — how long to fill")
    label = body.get("label") or body.get("note")
    if label:
        cue["label"] = str(label)[:120]
    return cue


# ---------------------------------------------------------------- storage

def read_all(project_id: str) -> dict[str, list[dict]]:
    with session_scope() as s:
        p = s.get(Project, project_id)
        settings = dict(p.settings or {}) if p else {}
    out: dict[str, list[dict]] = {}
    for kind in KINDS:
        rows = settings.get(SETTINGS_KEY[kind])
        out[kind] = [r for r in rows if isinstance(r, dict)] \
            if isinstance(rows, list) else []
    return out


def _write(project_id: str, kind: str, rows: list[dict]) -> None:
    with session_scope() as s:
        p = s.get(Project, project_id)
        if not p:
            raise CueError(f"no project {project_id}")
        settings = dict(p.settings or {})
        settings[SETTINGS_KEY[kind]] = rows
        p.settings = settings          # reassign: the JSON column tracks identity


def add(project_id: str, kind: str, body: dict) -> dict:
    cue = normalize(kind, body)
    rows = read_all(project_id)[kind]
    rows = [r for r in rows if r.get("id") != cue["id"]]
    rows.append(cue)
    _write(project_id, kind, rows)
    return cue


def ensure_ids(project_id: str) -> int:
    """Give every stored cue an id, and return how many were missing.

    An imported cue sheet (`audio/*-cues.jsonl` straight into settings) has no
    ids, which makes its cues unaddressable: they cannot be deleted and they
    cannot be moved. Idempotent, and it writes only when something is missing,
    so it is safe to call on a read path.
    """
    everything = read_all(project_id)
    fixed = 0
    for kind in KINDS:
        rows = everything[kind]
        missing = [r for r in rows if not r.get("id")]
        if not missing:
            continue
        for r in missing:
            r["id"] = new_id()
        fixed += len(missing)
        _write(project_id, kind, rows)
    return fixed


def find(project_id: str, cue_id: str) -> tuple[str, dict] | None:
    """(kind, cue) for an id, or None."""
    everything = read_all(project_id)
    for kind in KINDS:
        hit = next((r for r in everything[kind]
                    if str(r.get("id")) == str(cue_id)), None)
        if hit is not None:
            return kind, hit
    return None


def move(project_id: str, cue_id: str, *, at: float | None = None,
         delta: float | None = None, scope: str = "full") -> dict | None:
    """Slide one cue along the film. Returns None when there is no such cue.

    `at` is absolute film seconds; `delta` adds to where the cue sits now. The
    record's own anchoring is preserved, because that is what the assembler
    honors: a SHOT-anchored cue keeps its shot and moves by changing `offset`,
    so re-timing that shot still carries the cue with it, while an absolutely
    placed cue moves its `start`. (`film_start` prefers `start` when a record
    carries both, so the branch below follows the same precedence.)
    """
    if at is None and delta is None:
        raise CueError("move needs `at` (film seconds) or `delta`")
    everything = read_all(project_id)
    starts = shot_starts(project_id, scope)
    for kind in KINDS:
        rows = everything[kind]
        hit = next((r for r in rows if str(r.get("id")) == str(cue_id)), None)
        if hit is None:
            continue
        was = film_start(hit, starts)
        if at is None:
            if was is None:
                raise CueError(
                    f"cue {cue_id} is anchored to {cue_anchor(hit)}, which is not in "
                    f"this scope — pass `at` instead of `delta`")
            at = was + _num(delta, 0.0)
        at = max(0.0, _num(at, 0.0))
        row = dict(hit)
        offset = round(_num(row.get("offset"), 0.0), 3)
        if row.get("start") is not None:
            row["start"] = round(at - offset, 3)
        else:
            anchor = cue_anchor(row)
            base = starts.get(anchor) if anchor is not None else 0.0
            if base is None:
                raise CueError(
                    f"cue {cue_id} hangs off {anchor}, which is not in this scope — "
                    f"nothing to measure the move against")
            row["offset"] = round(at - base, 3)
        _write(project_id, kind, [row if r is hit else r for r in rows])
        return {"kind": kind, "cue": row, "at": round(at, 3), "previous_at": was}
    return None


def delete(project_id: str, cue_id: str) -> dict | None:
    """Remove by id from whichever list holds it. Returns the removed cue."""
    everything = read_all(project_id)
    for kind in KINDS:
        rows = everything[kind]
        hit = next((r for r in rows if str(r.get("id")) == cue_id), None)
        if hit is None:
            continue
        _write(project_id, kind, [r for r in rows if r is not hit])
        return hit
    return None


# ---------------------------------------------------------------- film time

def shot_starts(project_id: str, scope: str = "full") -> dict[str, float]:
    """sid → its start in film seconds, plus beat → its first shot's start.

    Uses the shots' (overridden) seconds — the same arithmetic the Film
    Editor strip shows. The assembler's audio-fit can stretch a shot past
    its scripted seconds, so this is the cue sheet's estimate; the assembler
    re-resolves shot-anchored cues against the real EDL when it cuts.
    """
    act = None
    if scope and str(scope).lower().startswith("act"):
        try:
            act = int(str(scope)[3:])
        except ValueError:
            act = None
    starts: dict[str, float] = {}
    t = 0.0
    with session_scope() as s:
        rows = [(sh.sid, sh.beat, sh.act, sh.seconds, dict(sh.override or {}))
                for sh in s.execute(
                    select(Shot).where(Shot.project_id == project_id)
                    .order_by(Shot.order_idx, Shot.id)).scalars()]
    for sid, beat, sh_act, seconds, ov in rows:
        if act is not None and sh_act != act:
            continue
        starts[sid] = round(t, 3)
        if beat and beat not in starts:
            starts[beat] = round(t, 3)
        t += float(ov.get("seconds") or seconds or 0)
    return starts


def film_start(cue: dict, starts: dict[str, float]) -> float | None:
    """Absolute film seconds for a cue, or None when its anchor is out of
    scope (an act cut that doesn't contain the shot the cue hangs off)."""
    offset = _num(cue.get("offset"), 0.0)
    if cue.get("start") is not None:
        return max(0.0, _num(cue.get("start"), 0.0) + offset)
    anchor = cue_anchor(cue)
    if anchor is not None:
        base = starts.get(anchor)
        return None if base is None else max(0.0, base + offset)
    return max(0.0, offset)


def sheet(project_id: str, scope: str = "full") -> dict[str, list[dict]]:
    """The cue sheet the API and `list_cues` return: canonical fields plus
    the resolved `at` (film seconds) and the anchor that produced it."""
    starts = shot_starts(project_id, scope)
    everything = read_all(project_id)
    out: dict[str, list[dict]] = {}
    for kind in KINDS:
        rows = []
        for c in everything[kind]:
            path = cue_path(c)
            if not path:
                continue
            at = film_start(c, starts)
            rows.append({
                "id": c.get("id") or new_id(),
                "kind": kind,
                "path": path,
                "at": at,
                "shot": cue_anchor(c),
                "offset": round(_num(c.get("offset"), 0.0), 3),
                "duration": cue_duration(c),
                "gain": round(cue_gain_db(c, kind), 2),
                "fade_in": round(_num(c.get("fade_in"), 0.0), 3) or None,
                "fade_out": round(_num(c.get("fade_out"), 0.0), 3) or None,
                "loop": bool(c.get("loop")),
                "label": c.get("label"),
            })
        rows.sort(key=lambda r: (r["at"] is None, r["at"] or 0))
        out[kind] = rows
    return out

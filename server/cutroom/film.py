"""The film model — shots joined with their takes, curation, and overrides.

Source precedence (the director's ruling, preserved from the original pipeline):
  override.source > promoted motion (renders/motion/<sid>.webm) >
  newest non-boil rendered fx/comp/panel > keeper still > first still > None
Boil clips never auto-play (banned); they stay listed as candidates.
"""
from __future__ import annotations

import time
from collections import defaultdict

from sqlalchemy import func, select

from . import refs as refs_mod
from .models import Project, Shot, Take
from .storage import ProjectStore

FX_KINDS = ("motion", "comp", "panel", "chain", "fx")

#: Take kinds whose creation can change what the compiled film shows or
#: sounds like (a still that might become a fallback source, a fresh VO line,
#: a cue's audio). `crop`, `ref`, `upload` and `animatic` are excluded: the
#: first three never reach the timeline on their own, and `animatic` IS the
#: rendered film, not a change to catch up on.
FILM_CHANGE_KINDS = {"still", "i2i", "motion", "fx", "chain", "comp", "panel",
                     "vo", "music", "sfx"}

#: How many recent notes `touch()` keeps — enough for a status tooltip,
#: cheap enough to carry on every Project row.
_CHANGE_LOG_CAP = 30


def shots_ordered(session, project_id: str) -> list[Shot]:
    return list(session.execute(
        select(Shot).where(Shot.project_id == project_id)
        .order_by(Shot.order_idx, Shot.id)).scalars())


def takes_by_shot(session, project_id: str) -> dict[str, list[Take]]:
    out: dict[str, list[Take]] = defaultdict(list)
    for t in session.execute(
            select(Take).where(Take.project_id == project_id)
            .order_by(Take.created_at)).scalars():
        out[t.shot_sid or ""].append(t)
    return out


def _paths(takes: list[Take], kinds: tuple[str, ...]) -> list[str]:
    return [t.path for t in takes if t.kind in kinds]


def vo_paths(store: ProjectStore, sid: str, beat: str,
             takes: list[Take]) -> list[str]:
    vo = _paths(takes, ("vo",))
    if not vo:
        vo = store.listdir("audio/generated", f"{sid}_*.wav") + \
            store.listdir("audio/generated", f"{sid}_*.mp3")
    if not vo and beat:
        vo = store.listdir("audio/generated", f"{beat}_*.wav")
    return vo


def active_source(store: ProjectStore, shot: Shot,
                  takes: list[Take]) -> str | None:
    ov = shot.override or {}
    if ov.get("source"):
        return ov["source"]
    promoted = f"renders/motion/{shot.sid}.webm"
    if store.exists(promoted):
        return promoted
    # fx takes are CANDIDATES: the oldest plays (stable — a fresh render never
    # hijacks the timeline; promote explicitly via override). Mock/test takes
    # never auto-play; boil is banned from auto-play (director ruling).
    fx = [t.path for t in takes
          if t.kind in FX_KINDS and "-boil" not in t.path
          and not (t.meta or {}).get("mock") and store.exists(t.path)]
    if fx:
        return fx[0]
    if shot.keeper and store.exists(shot.keeper):
        return shot.keeper
    stills = [p for p in _paths(takes, ("still", "i2i")) if store.exists(p)]
    if stills:
        return stills[0]
    scan = store.listdir("renders/stills", f"{shot.sid}_*.png")
    return scan[0] if scan else None


def film_entry(store: ProjectStore, shot: Shot, takes: list[Take]) -> dict:
    ov = shot.override or {}
    return {
        "sid": shot.sid, "beat": shot.beat, "act": shot.act,
        "type": shot.type, "register": shot.register,
        "seconds": ov.get("seconds", shot.seconds),
        "scripted_seconds": shot.seconds,
        "image_prompt": shot.image_prompt, "negative": shot.negative,
        "motion_prompt": shot.motion_prompt, "pan": shot.pan,
        "narration": shot.narration,
        # `radio` is what narration was called when the platform knew one
        # film. Still emitted, so an older client keeps reading. Drop next release.
        "radio": shot.narration,
        "dialogue": shot.dialogue, "sfx": shot.sfx,
        "ambient": shot.ambient, "cut": shot.cut,
        "render_notes": shot.render_notes,
        "keeper": shot.keeper, "curation_note": shot.curation_note,
        "override": ov,
        # The shot's reference images, always in the {path, role} shape even
        # when the row still holds the old bare-string list (cutroom/refs.py).
        "references": refs_mod.normalize(ov.get("refs")),
        "stills": _paths(takes, ("still",)),
        "i2i": _paths(takes, ("i2i",)),
        "motion": _paths(takes, ("motion", "chain")),
        "crops": _paths(takes, ("crop",)),
        "fx": _paths(takes, ("fx", "comp", "panel")),
        "vo": vo_paths(store, shot.sid, shot.beat, takes),
        "active_source": active_source(store, shot, takes),
    }


def touch(session, project_id: str, note: str) -> None:
    """Record a short note of something that just changed the compiled film —
    a source, a keeper, a cue, a retime, a fresh take. `GET .../film/status`
    diffs this log against the last cut to say whether the Timeline preview
    has drifted ahead of the rendered film file. Cheap and additive: a JSON
    ring buffer on the Project row, capped so it never grows unbounded."""
    proj = session.get(Project, project_id)
    if not proj:
        return
    log = list(proj.film_changes or [])
    log.append({"note": note, "at": time.time()})
    proj.film_changes = log[-_CHANGE_LOG_CAP:]


#: How many of the since-the-cut notes `film_status` spells out — a tooltip's
#: worth. `changes_count` (below) stays exact even past this.
_CHANGES_SHOWN = 8


def film_status(session, project_id: str) -> dict:
    """{last_cut_at, last_change_at, stale, changes, changes_count} — has
    anything changed since the last `cut_film`? `last_cut_at` is the newest
    animatic take's `created_at`; `last_change_at` the newest entry `touch()`
    logged; `stale` is true when the film has changed since it was last cut
    (or was never cut at all but has changes waiting); `changes` lists what,
    newest first, a tooltip's worth; `changes_count` is the exact number
    (bounded by the change log's own cap, `_CHANGE_LOG_CAP`)."""
    proj = session.get(Project, project_id)
    log = list((proj.film_changes if proj else None) or [])
    last_cut_at = session.execute(
        select(func.max(Take.created_at)).where(
            Take.project_id == project_id, Take.kind == "animatic")).scalar()
    last_change_at = max((e.get("at", 0) for e in log), default=None)
    since_cut = [e["note"] for e in reversed(log)
                if last_cut_at is None or e.get("at", 0) > last_cut_at]
    stale = last_change_at is not None and (
        last_cut_at is None or last_change_at > last_cut_at)
    return {
        "last_cut_at": last_cut_at,
        "last_change_at": last_change_at,
        "stale": stale,
        "changes": since_cut[:_CHANGES_SHOWN],
        "changes_count": len(since_cut),
    }

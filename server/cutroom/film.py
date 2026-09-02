"""The film model — shots joined with their takes, curation, and overrides.

Source precedence (the director's ruling, preserved from the original pipeline):
  override.source > promoted motion (renders/motion/<sid>.webm) >
  newest non-boil rendered fx/comp/panel > keeper still > first still > None
Boil clips never auto-play (banned); they stay listed as candidates.
"""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy import select

from .models import Shot, Take
from .storage import ProjectStore

FX_KINDS = ("motion", "comp", "panel", "chain", "fx")


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
        "radio": shot.radio, "dialogue": shot.dialogue, "sfx": shot.sfx,
        "ambient": shot.ambient, "cut": shot.cut,
        "render_notes": shot.render_notes,
        "keeper": shot.keeper, "curation_note": shot.curation_note,
        "override": ov,
        "stills": _paths(takes, ("still",)),
        "i2i": _paths(takes, ("i2i",)),
        "motion": _paths(takes, ("motion", "chain")),
        "crops": _paths(takes, ("crop",)),
        "fx": _paths(takes, ("fx", "comp", "panel")),
        "vo": vo_paths(store, shot.sid, shot.beat, takes),
        "active_source": active_source(store, shot, takes),
    }

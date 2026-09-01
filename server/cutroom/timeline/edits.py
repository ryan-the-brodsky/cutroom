"""Pure timeline edit operations.

Every function here takes a :class:`Timeline` and returns a **new, validated**
Timeline — the input is never mutated. Purity is enforced structurally: each op
deep-copies the input first (``Timeline.from_dict(tl.to_dict())``), edits the
copy, then calls ``.validate()`` before returning, so an operation can only ever
hand back a timeline the model considers legal.

Rational (frame) time is preserved throughout — a clip's timeline position
(``start``/``duration``) is kept independent of the slice of source it shows
(``source_start``/``source_end``), which is exactly what makes slip, ripple
trims, freeze-tail-as-an-edit and non-destructive splits expressible instead of
destructive.

Clips are always identified by ``id``. If the id is not found (or the op does not
apply to the clip's kind) the function returns an unchanged — but freshly copied
and re-validated — timeline rather than raising, so callers can treat every op
as total.
"""
from __future__ import annotations

from typing import Optional

from .model import MEDIA_KINDS, Clip, Timeline, new_id

__all__ = [
    "slip",
    "set_source_range",
    "ripple_trim_start",
    "ripple_trim_end",
    "split_clip",
    "move_clip",
    "remove_clip",
    "freeze_tail_trim",
]


# --- internal helpers -----------------------------------------------------


def _clone(tl: Timeline) -> Timeline:
    """Deep copy via the JSON round-trip so the input is never touched."""
    return Timeline.from_dict(tl.to_dict())


def _find(tl: Timeline, clip_id: str) -> Optional[Clip]:
    return next((c for c in tl.clips if c.id == clip_id), None)


def _is_media(c: Clip) -> bool:
    return c.kind in MEDIA_KINDS and bool(c.source)


# --- source-window edits (position & duration fixed) ----------------------


def slip(tl: Timeline, clip_id: str, delta_frames: int) -> Timeline:
    """Slip a clip's source in/out window by ``delta_frames``.

    The timeline ``start`` and ``duration`` stay put; only *which* frames of the
    source play changes: ``source_start`` and ``source_end`` both shift by delta.

    Clamped to the available media using the clip's handles — you cannot slip the
    in-point below 0 (``head_handle``) nor the out-point past ``source_duration``
    (``tail_handle``). If the requested delta would exceed the media it is clamped
    to the maximum possible slip and **no error is raised**.
    """
    out = _clone(tl)
    c = _find(out, clip_id)
    if c is None or not _is_media(c):
        return out.validate()

    in_pt = c.source_start
    out_pt = c.effective_source_end

    delta = delta_frames
    # lower bound: in_pt + delta >= 0  (can't slip earlier than the head)
    delta = max(delta, -in_pt)
    # upper bound: out_pt + delta <= source_duration (can't slip past the tail)
    if c.source_duration is not None:
        delta = min(delta, c.source_duration - out_pt)

    c.source_start = in_pt + delta
    c.source_end = out_pt + delta
    return out.validate()


def set_source_range(tl: Timeline, clip_id: str, source_start: int,
                     source_end: int) -> Timeline:
    """Set an explicit source in/out point.

    Design choice for the "slip vs. trim" ambiguity: a *pure slip* keeps the
    timeline duration and only redefines which source frames play — but that is
    only meaningful when the new range has the **same length** as the current
    clip duration. When the requested range is a different length, keeping the
    old duration would imply a retime, which is out of scope here. So this op
    treats the range as authoritative: it pins the timeline ``start`` and sets
    ``duration = source_end - source_start`` (a retime-free trim-in-place).

    Both branches therefore collapse to the same rule — ``start`` unchanged,
    window = ``[source_start, source_end)``, ``duration`` = the window length —
    and when the length happens to equal the old duration the result is exactly
    a slip. An out-of-media or empty range is rejected by ``validate()``
    (raising ``TimelineError``); the in-point is clamped to >= 0.
    """
    out = _clone(tl)
    c = _find(out, clip_id)
    if c is None or not _is_media(c):
        return out.validate()

    ss = max(0, int(source_start))
    se = int(source_end)
    c.source_start = ss
    c.source_end = se
    c.duration = se - ss
    return out.validate()


# --- ripple trims (edge moves + downstream shifts to stay contiguous) ------


def ripple_trim_start(tl: Timeline, clip_id: str, delta_frames: int) -> Timeline:
    """Ripple-trim the clip's IN edge.

    ``delta_frames > 0`` extends the head (reveals earlier source frames — the
    in-point moves *earlier*, the clip gets longer); ``delta_frames < 0`` shortens
    it (in-point moves later, clip gets shorter). The clip's timeline ``start``
    and its out-point stay fixed, ``duration`` changes by the applied delta, and
    every later clip on the same track shifts by that same net delta so the track
    stays gap/overlap-free.

    Bounded by the handles: extension is limited by ``head_handle`` (available
    source before the in-point); shortening keeps ``duration >= 1`` and the source
    window non-empty. Excess is clamped, not raised.
    """
    out = _clone(tl)
    c = _find(out, clip_id)
    if c is None or not _is_media(c):
        return out.validate()

    orig_end = c.end
    in_pt = c.source_start
    window = c.effective_source_end - in_pt

    if delta_frames >= 0:
        applied = min(delta_frames, in_pt)              # head_handle == in_pt
    else:
        max_shorten = min(c.duration, window) - 1
        applied = max(delta_frames, -max_shorten)

    # in-point moves by -applied; out-point stays fixed (source_end untouched):
    #  - explicit source_end -> unchanged
    #  - implicit source_end -> effective end = source_start + duration, and both
    #    change by (-applied)/(+applied), so the out-point is preserved too.
    c.source_start = in_pt - applied
    c.duration = c.duration + applied
    _ripple_after(out, c, orig_end, applied)
    return out.validate()


def ripple_trim_end(tl: Timeline, clip_id: str, delta_frames: int) -> Timeline:
    """Ripple-trim the clip's OUT edge.

    ``delta_frames > 0`` extends the tail (out-point moves later, clip longer);
    ``delta_frames < 0`` shortens it. The clip's ``start`` and in-point stay
    fixed, ``duration`` changes by the applied delta, and every later clip on the
    same track shifts by that net delta to stay contiguous.

    Bounded by the handles: extension is limited by ``tail_handle`` (available
    source after the out-point, when ``source_duration`` is known); shortening
    keeps ``duration >= 1`` and the window non-empty. Excess is clamped.
    """
    out = _clone(tl)
    c = _find(out, clip_id)
    if c is None or not _is_media(c):
        return out.validate()

    orig_end = c.end
    out_pt = c.effective_source_end
    window = out_pt - c.source_start

    if delta_frames >= 0:
        if c.source_duration is not None:
            applied = min(delta_frames, c.source_duration - out_pt)  # tail_handle
        else:
            applied = delta_frames
    else:
        max_shorten = min(c.duration, window) - 1
        applied = max(delta_frames, -max_shorten)

    c.source_end = out_pt + applied
    c.duration = c.duration + applied
    _ripple_after(out, c, orig_end, applied)
    return out.validate()


def _ripple_after(tl: Timeline, edited: Clip, threshold_end: int, shift: int) -> None:
    """Shift every clip on the edited clip's track that starts at/after
    ``threshold_end`` by ``shift`` frames (in place, on the working copy)."""
    if shift == 0:
        return
    for c in tl.clips:
        if c.id != edited.id and c.track_id == edited.track_id and c.start >= threshold_end:
            c.start = max(0, c.start + shift)


# --- structural edits ------------------------------------------------------


def split_clip(tl: Timeline, clip_id: str, at_frame: int) -> Timeline:
    """Split a clip at absolute timeline frame ``at_frame`` into two clips that
    share the same source.

    The left clip keeps the original ``start`` and is shortened to end at
    ``at_frame``; the right clip begins at ``at_frame`` and its ``source_start``
    advances by ``(at_frame - original.start)`` so the source runs continuously
    across the cut. Both carry the original lineage plus a shared
    ``cutroom['origin_id']`` linking them back to the pre-split clip.

    Returns the timeline unchanged if ``at_frame`` falls on or outside the clip's
    bounds (nothing to split).
    """
    out = _clone(tl)
    c = _find(out, clip_id)
    if c is None:
        return out.validate()
    if at_frame <= c.start or at_frame >= c.end:
        return out.validate()

    offset = at_frame - c.start
    origin = c.cutroom.get("origin_id") or c.id

    # Build the right half from the ORIGINAL clip values first (before mutating).
    second = Clip(
        id=new_id("c_"),
        track_id=c.track_id,
        kind=c.kind,
        start=at_frame,
        duration=c.duration - offset,
        source=c.source,
        source_start=(c.source_start + offset) if c.source else 0,
        source_end=c.effective_source_end if c.source else None,
        source_duration=c.source_duration,
        source_fps=c.source_fps,
        label=c.label,
        text=c.text,
        color=c.color,
        cutroom=dict(c.cutroom),
    )
    second.cutroom["origin_id"] = origin

    # Shrink the left half in place.
    if c.source:
        c.source_end = c.source_start + offset
    c.duration = offset
    c.cutroom["origin_id"] = origin

    out.clips.insert(out.clips.index(c) + 1, second)
    return out.validate()


def move_clip(tl: Timeline, clip_id: str, new_start: int) -> Timeline:
    """Reposition a clip to a new timeline ``start`` (no ripple — later clips are
    left where they are). ``start`` is clamped to >= 0."""
    out = _clone(tl)
    c = _find(out, clip_id)
    if c is None:
        return out.validate()
    c.start = max(0, int(new_start))
    return out.validate()


def remove_clip(tl: Timeline, clip_id: str, ripple: bool = False) -> Timeline:
    """Remove a clip. With ``ripple=True`` the gap is closed by shifting every
    later clip on the same track left by the removed clip's duration; otherwise
    the gap is left in place."""
    out = _clone(tl)
    c = _find(out, clip_id)
    if c is None:
        return out.validate()

    track_id = c.track_id
    removed_end = c.end
    removed_dur = c.duration
    out.clips = [x for x in out.clips if x.id != clip_id]

    if ripple:
        for o in out.clips:
            if o.track_id == track_id and o.start >= removed_end:
                o.start = max(0, o.start - removed_dur)
    return out.validate()


def freeze_tail_trim(tl: Timeline, clip_id: str, live_frames: int) -> Timeline:
    """The FIRST-SECOND LAW as a non-destructive edit.

    Trim a **video** clip down to its first ``live_frames`` frames:
    ``source_end = source_start + live_frames`` and ``duration = live_frames``.
    The held-tail portion (freezing the last live frame for the remainder) is a
    separate future concern — this op only performs the trim.

    Only valid on video clips; on any other kind the timeline is returned
    unchanged. ``live_frames`` outside ``[1, duration)`` is a no-op (there is
    nothing to trim), so the op never lengthens a clip or produces an empty one.
    """
    out = _clone(tl)
    c = _find(out, clip_id)
    if c is None or c.kind != "video":
        return out.validate()

    live = int(live_frames)
    if live < 1 or live >= c.duration:
        return out.validate()

    c.source_end = c.source_start + live
    c.duration = live
    return out.validate()

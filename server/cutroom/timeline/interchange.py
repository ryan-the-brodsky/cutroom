"""Interchange exporters for the Cutroom timeline model.

Two lossy-but-standard round-trips out of the frame-based :class:`Timeline`:

* :func:`to_otio` — an OpenTimelineIO ``.otio`` JSON structure (plain dict; we do
  **not** import the ``opentimelineio`` package, so this stays dependency-free).
  Tracks are emitted gapless: OTIO composes children back-to-back, so the space
  between clips is materialised as :class:`Gap` items. Per-clip generation
  lineage — the one thing OTIO has no home for — rides along namespaced under
  ``metadata.cutroom`` (plus a GeneratorReference-style block when the clip
  carries prompt/model/seed).

* :func:`to_edl` — a CMX3600 EDL for the first video track. Source/record
  timecodes are HH:MM:SS:FF at the timeline fps; reel names are 8-char handles
  derived from each clip's source filename.

Both are frame-accurate: nothing here ever touches float seconds.
"""
from __future__ import annotations

import re
from pathlib import Path

from . import model as m

__all__ = ["to_otio", "to_edl", "frames_to_timecode", "reel_name"]


# --- OTIO primitives ---------------------------------------------------------

def _rational_time(value: int, rate: float) -> dict:
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": float(rate), "value": int(value)}


def _time_range(start_value: int, duration_value: int, rate: float) -> dict:
    return {
        "OTIO_SCHEMA": "TimeRange.1",
        "start_time": _rational_time(start_value, rate),
        "duration": _rational_time(duration_value, rate),
    }


def _gap(duration_frames: int, fps: float) -> dict:
    return {
        "OTIO_SCHEMA": "Gap.1",
        "name": "",
        "source_range": _time_range(0, duration_frames, fps),
        "effects": [],
        "markers": [],
        "enabled": True,
        "metadata": {},
    }


_GENERATOR_KEYS = ("prompt", "model", "seed")


def _clip_metadata(clip: m.Clip) -> dict:
    """All lineage under a namespaced ``cutroom`` block, plus a
    GeneratorReference-style descriptor when the clip was machine-generated."""
    meta: dict = {"cutroom": dict(clip.cutroom)}
    lineage = clip.cutroom or {}
    if any(k in lineage for k in _GENERATOR_KEYS):
        meta["generator_reference"] = {
            "OTIO_SCHEMA": "GeneratorReference.1",
            "name": clip.label or "",
            "generator_kind": str(lineage.get("model") or "cutroom-gen"),
            "parameters": {k: lineage[k] for k in _GENERATOR_KEYS if k in lineage},
            "available_range": None,
            "metadata": {},
        }
    return meta


def _media_reference(clip: m.Clip, tl: m.Timeline, src_rate: float) -> dict:
    if clip.kind == "text":
        # A slate / title has no external media — model it as a generator.
        return {
            "OTIO_SCHEMA": "GeneratorReference.1",
            "name": clip.label or "",
            "generator_kind": "Text",
            "parameters": {"text": clip.text or "", "color": clip.color or "#ffffff"},
            "available_range": _time_range(0, clip.duration, tl.fps),
            "metadata": {},
        }
    available_range = None
    if clip.source_duration is not None:
        available_range = _time_range(0, clip.source_duration, src_rate)
    return {
        "OTIO_SCHEMA": "ExternalReference.1",
        "name": clip.label or "",
        "target_url": clip.source or "",
        "available_range": available_range,
        "metadata": {},
    }


def _clip(clip: m.Clip, tl: m.Timeline) -> dict:
    # Source-side times run at the media's own rate; fall back to the timeline.
    src_rate = float(clip.source_fps or tl.fps)
    src_start = clip.source_start
    src_frames = clip.effective_source_end - clip.source_start
    return {
        "OTIO_SCHEMA": "Clip.2",
        "name": clip.label or clip.id,
        "enabled": True,
        "source_range": _time_range(src_start, src_frames, src_rate),
        "media_references": {"DEFAULT_MEDIA": _media_reference(clip, tl, src_rate)},
        "active_media_reference_key": "DEFAULT_MEDIA",
        "effects": [],
        "markers": [],
        "metadata": _clip_metadata(clip),
    }


def _track(track: m.Track, tl: m.Timeline) -> dict:
    """One OTIO track, gapless from frame 0 — the space before/between clips is
    filled with Gap items so the composition reads back frame-accurate."""
    otio_kind = "Video" if track.kind == "video" else "Audio"
    children: list[dict] = []
    cursor = 0
    for clip in tl.clips_on(track.id):
        if clip.start > cursor:
            children.append(_gap(clip.start - cursor, tl.fps))
            cursor = clip.start
        children.append(_clip(clip, tl))
        cursor = clip.end
    return {
        "OTIO_SCHEMA": "Track.1",
        "name": track.name or otio_kind,
        "kind": otio_kind,
        "children": children,
        "markers": [],
        "effects": [],
        "enabled": True,
        "source_range": None,
        "metadata": {"cutroom": {"track_id": track.id, "order": track.order}},
    }


def to_otio(tl: m.Timeline, *, name: str | None = None) -> dict:
    """Emit an OpenTimelineIO ``Timeline.1`` structure as a plain dict.

    Frame-accurate and dependency-free. Feed the result to ``json.dumps`` and it
    is a valid ``.otio`` document; the ``opentimelineio`` package (if present)
    will read it back via the ``otio_json`` adapter.
    """
    name = name or str(tl.cutroom.get("project") or "cutroom")
    tracks = [_track(t, tl) for t in sorted(tl.tracks, key=lambda t: t.order)]
    stack = {
        "OTIO_SCHEMA": "Stack.1",
        "name": "tracks",
        "children": tracks,
        "markers": [],
        "effects": [],
        "enabled": True,
        "source_range": None,
        "metadata": {},
    }
    return {
        "OTIO_SCHEMA": "Timeline.1",
        "name": name,
        "global_start_time": _rational_time(0, tl.fps),
        "tracks": stack,
        "metadata": {"cutroom": dict(tl.cutroom)},
    }


# --- CMX3600 EDL -------------------------------------------------------------

def frames_to_timecode(frame: int, fps: float) -> str:
    """Whole-frame count -> non-drop HH:MM:SS:FF at ``fps``."""
    rate = int(round(fps))
    if rate <= 0:
        rate = 24
    frame = max(0, int(frame))
    ff = frame % rate
    total_seconds = frame // rate
    ss = total_seconds % 60
    total_minutes = total_seconds // 60
    mm = total_minutes % 60
    hh = total_minutes // 60
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def reel_name(source: str | None) -> str:
    """An 8-char reel handle derived from a source filename. ``AX`` (auxiliary)
    when there is no media — e.g. a slate/text clip."""
    if not source:
        return "AX"
    stem = Path(source).stem
    cleaned = re.sub(r"[^A-Za-z0-9]", "", stem).upper()
    return (cleaned[:8] or "AX")


def to_edl(tl: m.Timeline, *, title: str | None = None) -> str:
    """A CMX3600 EDL for the first video track.

    Each cut becomes a numbered event with source in/out (``source_start`` ..
    ``effective_source_end``) and record in/out (the clip's timeline
    ``start`` .. ``end``), all as HH:MM:SS:FF at ``tl.fps``.
    """
    title = title or str(tl.cutroom.get("project") or "CUTROOM")
    video_tracks = sorted((t for t in tl.tracks if t.kind == "video"),
                          key=lambda t: t.order)
    lines = [f"TITLE: {title}", "FCM: NON-DROP FRAME", ""]
    if not video_tracks:
        return "\n".join(lines) + "\n"

    track = video_tracks[0]
    for i, clip in enumerate(tl.clips_on(track.id), start=1):
        reel = reel_name(clip.source)
        src_in = frames_to_timecode(clip.source_start, tl.fps)
        src_out = frames_to_timecode(clip.effective_source_end, tl.fps)
        rec_in = frames_to_timecode(clip.start, tl.fps)
        rec_out = frames_to_timecode(clip.end, tl.fps)
        lines.append(
            f"{i:03d}  {reel:<8} V     C        "
            f"{src_in} {src_out} {rec_in} {rec_out}"
        )
        lines.append(f"* FROM CLIP NAME: {clip.label or clip.source or clip.id}")
    return "\n".join(lines) + "\n"

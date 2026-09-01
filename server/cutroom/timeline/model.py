"""The timeline data model.

Rational time = integer **frames** + a timeline **fps** (never float seconds —
the one NLE mistake that is brutal to retrofit; see FOUNDATION.md §4). A clip's
position on the timeline (`start`, `duration`) is independent of the slice of
source it shows (`source_start`, `source_end`) — which is what makes trims,
freeze-tail-as-an-edit, and transitions expressible instead of destructive.

**Media handles** are first-class: `source_duration` is retained even when the
clip only shows a sub-range, so a transition can borrow frames beyond the visible
out-point. A model that can't represent frames past the in/out makes transitions
unimplementable forever (FOUNDATION.md §2/§6) — so we keep them.

Field names mirror FreeCut's proven frame-based item shape where they map, so the
engine projection (`compile.to_freecut_render_input`) is near-identity; the one
thing FreeCut (and OTIO) can't hold — per-clip generation lineage — lives in the
namespaced `cutroom` block.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field, replace
from typing import Any, Literal

ClipKind = Literal["video", "image", "audio", "text"]
TrackKind = Literal["video", "audio"]

VISUAL_KINDS = {"video", "image", "text"}
MEDIA_KINDS = {"video", "image", "audio"}  # kinds that reference a source asset


def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:12]


def frames_to_seconds(frames: int, fps: float) -> float:
    return frames / fps


def seconds_to_frames(seconds: float, fps: float) -> int:
    """Round to the nearest whole frame — the timeline is frame-quantized."""
    return int(round(seconds * fps))


class TimelineError(ValueError):
    pass


@dataclass
class Clip:
    track_id: str
    kind: ClipKind
    start: int                       # timeline start frame
    duration: int                    # timeline duration in frames (>= 1)
    id: str = field(default_factory=lambda: new_id("c_"))
    # source (media kinds only) --------------------------------------------
    source: str | None = None        # project-relative asset path == mediaId
    source_start: int = 0            # in-point, source frames
    source_end: int | None = None    # out-point, source frames (None => start+duration)
    source_duration: int | None = None   # total source frames (handle bounds)
    source_fps: float | None = None
    # presentation ----------------------------------------------------------
    label: str = ""
    text: str | None = None          # text kind
    color: str | None = None         # text kind
    # lineage — the thing OTIO/FreeCut can't hold -------------------------
    cutroom: dict = field(default_factory=dict)

    @property
    def end(self) -> int:
        """Timeline end frame (exclusive)."""
        return self.start + self.duration

    @property
    def effective_source_end(self) -> int:
        return self.source_end if self.source_end is not None else self.source_start + self.duration

    @property
    def head_handle(self) -> int:
        """Source frames available before the in-point (for a transition)."""
        return self.source_start

    @property
    def tail_handle(self) -> int | None:
        """Source frames available after the out-point, or None if unknown."""
        if self.source_duration is None:
            return None
        return self.source_duration - self.effective_source_end

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "id": self.id, "track_id": self.track_id, "kind": self.kind,
            "start": self.start, "duration": self.duration,
        }
        if self.source is not None:
            d["source"] = self.source
            d["source_start"] = self.source_start
            if self.source_end is not None:
                d["source_end"] = self.source_end
            if self.source_duration is not None:
                d["source_duration"] = self.source_duration
            if self.source_fps is not None:
                d["source_fps"] = self.source_fps
        if self.label:
            d["label"] = self.label
        if self.text is not None:
            d["text"] = self.text
        if self.color is not None:
            d["color"] = self.color
        if self.cutroom:
            d["cutroom"] = self.cutroom
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Clip":
        return cls(
            id=d.get("id") or new_id("c_"),
            track_id=d["track_id"], kind=d["kind"],
            start=int(d["start"]), duration=int(d["duration"]),
            source=d.get("source"),
            source_start=int(d.get("source_start", 0)),
            source_end=None if d.get("source_end") is None else int(d["source_end"]),
            source_duration=None if d.get("source_duration") is None else int(d["source_duration"]),
            source_fps=d.get("source_fps"),
            label=d.get("label", ""), text=d.get("text"), color=d.get("color"),
            cutroom=dict(d.get("cutroom", {})),
        )


@dataclass
class Track:
    kind: TrackKind
    name: str = ""
    order: int = 0
    id: str = field(default_factory=lambda: new_id("t_"))

    def to_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "name": self.name, "order": self.order}

    @classmethod
    def from_dict(cls, d: dict) -> "Track":
        return cls(id=d.get("id") or new_id("t_"), kind=d["kind"],
                   name=d.get("name", ""), order=int(d.get("order", 0)))


@dataclass
class Marker:
    frame: int
    label: str = ""
    color: str = "#ffcc00"
    id: str = field(default_factory=lambda: new_id("m_"))

    def to_dict(self) -> dict:
        return {"id": self.id, "frame": self.frame, "label": self.label, "color": self.color}

    @classmethod
    def from_dict(cls, d: dict) -> "Marker":
        return cls(id=d.get("id") or new_id("m_"), frame=int(d["frame"]),
                   label=d.get("label", ""), color=d.get("color", "#ffcc00"))


@dataclass
class Timeline:
    fps: int = 24
    width: int = 1920
    height: int = 1080
    tracks: list[Track] = field(default_factory=list)
    clips: list[Clip] = field(default_factory=list)
    markers: list[Marker] = field(default_factory=list)
    cutroom: dict = field(default_factory=dict)

    # --- queries ---------------------------------------------------------
    def track(self, track_id: str) -> Track | None:
        return next((t for t in self.tracks if t.id == track_id), None)

    def clips_on(self, track_id: str) -> list[Clip]:
        return sorted((c for c in self.clips if c.track_id == track_id),
                      key=lambda c: c.start)

    def total_frames(self) -> int:
        return max((c.end for c in self.clips), default=0)

    def duration_seconds(self) -> float:
        return frames_to_seconds(self.total_frames(), self.fps)

    # --- validation ------------------------------------------------------
    def validate(self) -> "Timeline":
        if self.fps <= 0:
            raise TimelineError(f"fps must be > 0, got {self.fps}")
        if self.width <= 0 or self.height <= 0:
            raise TimelineError(f"bad canvas {self.width}x{self.height}")
        track_ids = {t.id for t in self.tracks}
        if len(track_ids) != len(self.tracks):
            raise TimelineError("duplicate track ids")
        track_kind = {t.id: t.kind for t in self.tracks}
        seen: set[str] = set()
        for c in self.clips:
            if c.id in seen:
                raise TimelineError(f"duplicate clip id {c.id}")
            seen.add(c.id)
            if c.track_id not in track_ids:
                raise TimelineError(f"clip {c.id} on unknown track {c.track_id}")
            if not isinstance(c.start, int) or not isinstance(c.duration, int):
                raise TimelineError(f"clip {c.id} start/duration must be int frames")
            if c.start < 0:
                raise TimelineError(f"clip {c.id} start {c.start} < 0")
            if c.duration < 1:
                raise TimelineError(f"clip {c.id} duration {c.duration} < 1")
            # clip kind must be compatible with its track kind
            tk = track_kind[c.track_id]
            if tk == "audio" and c.kind != "audio":
                raise TimelineError(f"clip {c.id} ({c.kind}) on audio track")
            if tk == "video" and c.kind == "audio":
                raise TimelineError(f"audio clip {c.id} on video track")
            # source-range + handle checks for media clips
            if c.kind in MEDIA_KINDS:
                if not c.source:
                    raise TimelineError(f"media clip {c.id} ({c.kind}) has no source")
                if c.source_start < 0:
                    raise TimelineError(f"clip {c.id} source_start < 0")
                se = c.effective_source_end
                if se <= c.source_start:
                    raise TimelineError(
                        f"clip {c.id} source range empty ({c.source_start}..{se})")
                if c.source_duration is not None and se > c.source_duration:
                    raise TimelineError(
                        f"clip {c.id} out-point {se} exceeds source_duration "
                        f"{c.source_duration} (no media handle for that)")
            if c.kind == "text" and not c.text:
                raise TimelineError(f"text clip {c.id} has no text")
        return self

    # --- json ------------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "fps": self.fps, "width": self.width, "height": self.height,
            "tracks": [t.to_dict() for t in sorted(self.tracks, key=lambda t: t.order)],
            "clips": [c.to_dict() for c in self.clips],
            "markers": [m.to_dict() for m in self.markers],
            "total_frames": self.total_frames(),
            "duration_seconds": round(self.duration_seconds(), 3),
            "cutroom": self.cutroom,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Timeline":
        return cls(
            fps=int(d.get("fps", 24)),
            width=int(d.get("width", 1920)), height=int(d.get("height", 1080)),
            tracks=[Track.from_dict(t) for t in d.get("tracks", [])],
            clips=[Clip.from_dict(c) for c in d.get("clips", [])],
            markers=[Marker.from_dict(m) for m in d.get("markers", [])],
            cutroom=dict(d.get("cutroom", {})),
        )

    def copy(self) -> "Timeline":
        return Timeline.from_dict(self.to_dict())


def clip_from_seconds(track_id: str, kind: ClipKind, start_s: float, dur_s: float,
                      fps: float, **kw) -> Clip:
    """Build a clip from second-based timing (rounding to whole frames once,
    at the boundary — never store the floats)."""
    return Clip(track_id=track_id, kind=kind,
                start=seconds_to_frames(start_s, fps),
                duration=max(1, seconds_to_frames(dur_s, fps)), **kw)


__all__ = ["Clip", "Track", "Marker", "Timeline", "TimelineError",
           "clip_from_seconds", "frames_to_seconds", "seconds_to_frames",
           "new_id", "VISUAL_KINDS", "MEDIA_KINDS", "replace"]

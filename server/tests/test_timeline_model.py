"""Timeline model: round-trip, validation, and the handle math that makes
transitions possible."""
from __future__ import annotations

import pytest

from cutroom.timeline.model import (Clip, Marker, Timeline, TimelineError, Track,
                                    clip_from_seconds, frames_to_seconds,
                                    seconds_to_frames)


def _tl() -> Timeline:
    v = Track(kind="video", name="V1", order=0)
    a = Track(kind="audio", name="A1", order=1)
    tl = Timeline(fps=24, width=1920, height=1080, tracks=[v, a])
    tl.clips.append(Clip(track_id=v.id, kind="video", start=0, duration=96,
                         source="renders/fx/a.mp4", source_start=0,
                         source_end=96, source_duration=96, source_fps=24))
    tl.clips.append(Clip(track_id=v.id, kind="video", start=96, duration=48,
                         source="renders/motion/b.webm", source_start=20,
                         source_end=68, source_duration=97, source_fps=24))
    tl.clips.append(Clip(track_id=a.id, kind="audio", start=8, duration=60,
                         source="audio/generated/l.wav", source_duration=60))
    return tl


def test_frame_second_conversions():
    assert seconds_to_frames(4.0, 24) == 96
    assert seconds_to_frames(1.0, 24) == 24
    assert seconds_to_frames(4.041667, 24) == 97   # rounds to nearest frame
    assert frames_to_seconds(144, 24) == 6.0


def test_roundtrip_preserves_everything():
    tl = _tl().validate()
    again = Timeline.from_dict(tl.to_dict()).validate()
    assert again.to_dict() == tl.to_dict()
    assert again.total_frames() == 144
    assert again.duration_seconds() == 6.0


def test_totals():
    tl = _tl()
    assert tl.total_frames() == 144          # 96 + 48 on V1
    assert tl.duration_seconds() == 6.0
    assert [c.id for c in tl.clips_on(tl.tracks[0].id)] == [tl.clips[0].id, tl.clips[1].id]


def test_handle_math():
    tl = _tl()
    trimmed = tl.clips[1]                     # source 20..68 of a 97-frame clip
    assert trimmed.head_handle == 20          # frames available before in-point
    assert trimmed.tail_handle == 97 - 68     # == 29 frames available after out
    assert trimmed.effective_source_end == 68
    # a clip with no explicit source_end infers it from duration
    c = Clip(track_id="t", kind="video", start=0, duration=30, source="x.mp4",
             source_start=5)
    assert c.effective_source_end == 35


def test_clip_from_seconds_quantizes_once():
    c = clip_from_seconds("t", "video", start_s=2.0, dur_s=4.0, fps=24,
                          source="x.mp4", source_duration=200)
    assert c.start == 48 and c.duration == 96
    assert isinstance(c.start, int) and isinstance(c.duration, int)


def test_zero_duration_clip_is_clamped_to_one_frame():
    c = clip_from_seconds("t", "video", start_s=0, dur_s=0.0, fps=24, source="x.mp4")
    assert c.duration == 1


@pytest.mark.parametrize("mutate,msg", [
    (lambda tl: setattr(tl, "fps", 0), "fps"),
    (lambda tl: setattr(tl, "width", 0), "canvas"),
    (lambda tl: tl.clips.append(Clip(track_id="ghost", kind="video", start=0,
                                     duration=10, source="x.mp4")), "unknown track"),
    (lambda tl: tl.clips.append(Clip(track_id=tl.tracks[0].id, kind="video",
                                     start=-1, duration=10, source="x.mp4")), "< 0"),
    (lambda tl: tl.clips.append(Clip(track_id=tl.tracks[0].id, kind="video",
                                     start=0, duration=0, source="x.mp4")), "duration"),
    (lambda tl: tl.clips.append(Clip(track_id=tl.tracks[1].id, kind="video",
                                     start=0, duration=10, source="x.mp4")), "audio track"),
    (lambda tl: tl.clips.append(Clip(track_id=tl.tracks[0].id, kind="video",
                                     start=0, duration=10)), "no source"),
])
def test_validation_rejects(mutate, msg):
    tl = _tl()
    mutate(tl)
    with pytest.raises(TimelineError) as ei:
        tl.validate()
    assert msg in str(ei.value)


def test_out_point_past_source_duration_is_rejected():
    """The handle-awareness guard: you can't point past media you don't have."""
    v = Track(kind="video", name="V1")
    tl = Timeline(fps=24, tracks=[v])
    tl.clips.append(Clip(track_id=v.id, kind="video", start=0, duration=50,
                         source="x.mp4", source_start=0, source_end=120,
                         source_duration=100))
    with pytest.raises(TimelineError) as ei:
        tl.validate()
    assert "exceeds source_duration" in str(ei.value)


def test_source_end_below_duration_is_allowed_that_is_the_tail_handle():
    v = Track(kind="video", name="V1")
    tl = Timeline(fps=24, tracks=[v])
    tl.clips.append(Clip(track_id=v.id, kind="video", start=0, duration=50,
                         source="x.mp4", source_start=0, source_end=50,
                         source_duration=100))
    tl.validate()                             # 50 frames of tail handle: fine
    assert tl.clips[0].tail_handle == 50


def test_duplicate_clip_id_rejected():
    tl = _tl()
    tl.clips.append(tl.clips[0])              # same object == same id
    with pytest.raises(TimelineError):
        tl.validate()


def test_markers_roundtrip():
    tl = _tl()
    tl.markers.append(Marker(frame=48, label="beat 2"))
    d = tl.to_dict()
    assert d["markers"][0]["frame"] == 48
    assert Timeline.from_dict(d).markers[0].label == "beat 2"

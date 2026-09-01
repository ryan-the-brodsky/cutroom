"""Pure unit tests for the timeline edit-operations library.

No DB, no fixtures — every op is a pure Timeline -> Timeline transform. Tests
cover happy paths, handle/boundary clamping, ripple correctness (asserting
downstream clip positions), split math, and that the input is never mutated.
"""
from __future__ import annotations

import pytest

from cutroom.timeline.edits import (freeze_tail_trim, move_clip, remove_clip,
                                     ripple_trim_end, ripple_trim_start,
                                     set_source_range, slip, split_clip)
from cutroom.timeline.model import Clip, Timeline, TimelineError, Track

# Clip ids are stable so tests can address them by name.
A, B, C, D = "cA", "cB", "cC", "cD"
V, AU = "tV", "tA"


def _tl() -> Timeline:
    """V1: A[0..48] B[48..96] C[96..120] (contiguous); A1: D[0..100].

    A: source 10..58 of 200-frame media  (head=10, tail=142, window=48)
    B: source 0..48  of 48-frame media   (head=0,  tail=0,   window=48)
    C: source 5..29  of 100-frame media  (head=5,  tail=71,  window=24)
    D: audio, source 0..100 of 100-frame media
    """
    tl = Timeline(
        fps=24, width=1920, height=1080,
        tracks=[Track(kind="video", name="V1", order=0, id=V),
                Track(kind="audio", name="A1", order=1, id=AU)],
        clips=[
            Clip(id=A, track_id=V, kind="video", start=0, duration=48,
                 source="a.mp4", source_start=10, source_end=58,
                 source_duration=200, source_fps=24),
            Clip(id=B, track_id=V, kind="video", start=48, duration=48,
                 source="b.mp4", source_start=0, source_end=48,
                 source_duration=48, source_fps=24),
            Clip(id=C, track_id=V, kind="video", start=96, duration=24,
                 source="c.mp4", source_start=5, source_end=29,
                 source_duration=100, source_fps=24),
            Clip(id=D, track_id=AU, kind="audio", start=0, duration=100,
                 source="d.wav", source_start=0, source_end=100,
                 source_duration=100),
        ],
    ).validate()
    return tl


def _clip(tl: Timeline, cid: str) -> Clip:
    return next(c for c in tl.clips if c.id == cid)


# --- purity ---------------------------------------------------------------


def test_no_mutation_of_input():
    tl = _tl()
    before = tl.to_dict()
    slip(tl, A, 20)
    set_source_range(tl, A, 20, 40)
    ripple_trim_start(tl, A, -10)
    ripple_trim_end(tl, B, -10)
    split_clip(tl, B, 72)
    move_clip(tl, C, 200)
    remove_clip(tl, B, ripple=True)
    freeze_tail_trim(tl, A, 12)
    assert tl.to_dict() == before, "input timeline must never be mutated"


def test_every_op_returns_a_validated_timeline():
    tl = _tl()
    # a returned timeline is, by construction, one .validate() accepted
    for result in (
        slip(tl, A, 5),
        set_source_range(tl, A, 12, 60),
        ripple_trim_start(tl, A, 4),
        ripple_trim_end(tl, A, 4),
        split_clip(tl, A, 24),
        move_clip(tl, A, 300),
        remove_clip(tl, A),
        freeze_tail_trim(tl, A, 24),
    ):
        assert isinstance(result, Timeline)
        result.validate()


# --- slip -----------------------------------------------------------------


def test_slip_shifts_window_keeps_position():
    out = slip(_tl(), A, 20)
    a = _clip(out, A)
    assert (a.source_start, a.source_end) == (30, 78)
    assert (a.start, a.duration) == (0, 48)          # position/length untouched


def test_slip_clamps_at_head():
    out = slip(_tl(), A, -100)                        # head_handle == 10
    a = _clip(out, A)
    assert (a.source_start, a.source_end) == (0, 48)  # clamped, not raised


def test_slip_clamps_at_tail():
    out = slip(_tl(), A, 1000)                         # tail_handle == 142
    a = _clip(out, A)
    assert (a.source_start, a.source_end) == (152, 200)


def test_slip_unknown_clip_is_noop():
    out = slip(_tl(), "nope", 20)
    assert out.to_dict() == _tl().to_dict()


def test_slip_non_media_is_noop():
    tl = _tl()
    tl.clips.append(Clip(id="txt", track_id=V, kind="text", start=0,
                         duration=10, text="hi"))
    out = slip(tl, "txt", 5)
    assert _clip(out, "txt").start == 0


# --- set_source_range -----------------------------------------------------


def test_set_source_range_equal_length_is_a_slip():
    out = set_source_range(_tl(), A, 20, 68)           # length 48 == duration
    a = _clip(out, A)
    assert (a.source_start, a.source_end, a.duration, a.start) == (20, 68, 48, 0)


def test_set_source_range_different_length_retimes_duration():
    out = set_source_range(_tl(), A, 10, 30)           # length 20 != 48
    a = _clip(out, A)
    assert (a.source_start, a.source_end, a.duration, a.start) == (10, 30, 20, 0)


def test_set_source_range_clamps_negative_in_point():
    out = set_source_range(_tl(), A, -5, 20)
    a = _clip(out, A)
    assert a.source_start == 0 and a.source_end == 20 and a.duration == 20


def test_set_source_range_out_of_media_raises():
    with pytest.raises(TimelineError):
        set_source_range(_tl(), A, 10, 300)            # 300 > source_duration 200


def test_set_source_range_empty_range_raises():
    with pytest.raises(TimelineError):
        set_source_range(_tl(), A, 40, 40)


# --- ripple_trim_start ----------------------------------------------------


def test_ripple_trim_start_extend_ripples_downstream():
    out = ripple_trim_start(_tl(), A, 5)               # head_handle 10 -> applied 5
    a = _clip(out, A)
    assert (a.source_start, a.duration, a.start) == (5, 53, 0)
    assert a.effective_source_end == 58                # out-point fixed
    assert _clip(out, B).start == 53                    # rippled +5
    assert _clip(out, C).start == 101
    assert a.end == _clip(out, B).start                 # still contiguous


def test_ripple_trim_start_shorten_ripples_downstream():
    out = ripple_trim_start(_tl(), A, -10)
    a = _clip(out, A)
    assert (a.source_start, a.duration, a.start) == (20, 38, 0)
    assert a.effective_source_end == 58                 # out-point fixed
    assert _clip(out, B).start == 38                     # rippled -10
    assert _clip(out, C).start == 86


def test_ripple_trim_start_extend_clamped_to_head_handle():
    out = ripple_trim_start(_tl(), A, 50)               # only 10 of head available
    a = _clip(out, A)
    assert (a.source_start, a.duration) == (0, 58)
    assert _clip(out, B).start == 58                     # rippled by clamped +10


def test_ripple_trim_start_shorten_clamped_to_one_frame():
    out = ripple_trim_start(_tl(), A, -1000)
    a = _clip(out, A)
    assert a.duration == 1
    assert _clip(out, B).start == 1                      # rippled by -47


# --- ripple_trim_end ------------------------------------------------------


def test_ripple_trim_end_extend_ripples_downstream():
    out = ripple_trim_end(_tl(), A, 10)                 # tail_handle 142
    a = _clip(out, A)
    assert (a.source_end, a.duration, a.start) == (68, 58, 0)
    assert a.source_start == 10                          # in-point fixed
    assert _clip(out, B).start == 58
    assert _clip(out, C).start == 106


def test_ripple_trim_end_shorten_ripples_only_later_clips():
    out = ripple_trim_end(_tl(), B, -10)
    b = _clip(out, B)
    assert (b.source_end, b.duration) == (38, 38)
    assert _clip(out, A).start == 0                      # earlier clip untouched
    assert _clip(out, C).start == 86                     # later clip rippled -10
    assert b.end == _clip(out, C).start                  # contiguous


def test_ripple_trim_end_extend_clamped_to_tail_handle():
    out = ripple_trim_end(_tl(), C, 1000)               # tail_handle 71
    c = _clip(out, C)
    assert (c.source_end, c.duration) == (100, 95)


def test_ripple_trim_end_shorten_clamped_to_one_frame():
    out = ripple_trim_end(_tl(), C, -1000)              # window 24 -> min dur 1
    c = _clip(out, C)
    assert c.duration == 1 and c.source_end == 6


def test_ripple_trim_end_on_last_clip_has_no_downstream():
    out = ripple_trim_end(_tl(), C, -4)
    assert _clip(out, C).duration == 20
    assert _clip(out, A).start == 0 and _clip(out, B).start == 48


# --- split_clip -----------------------------------------------------------


def test_split_math_and_shared_origin():
    out = split_clip(_tl(), B, 72)                      # B is [48..96], source 0..48
    left = _clip(out, B)
    assert (left.start, left.duration, left.source_start, left.source_end) == (48, 24, 0, 24)
    # the new right half sits right after B in the list
    right = out.clips[out.clips.index(left) + 1]
    assert (right.start, right.duration) == (72, 24)
    assert (right.source_start, right.source_end) == (24, 48)
    assert right.track_id == V and right.kind == "video" and right.source == "b.mp4"
    # shared lineage
    assert left.cutroom["origin_id"] == right.cutroom["origin_id"] == B
    assert right.id != left.id
    assert len(out.clips) == len(_tl().clips) + 1


def test_split_infers_out_point_when_source_end_is_none():
    tl = _tl()
    _clip(tl, A).source_end = None                      # effective end = 10 + 48 = 58
    out = split_clip(tl, A, 20)                          # offset 20
    left = _clip(out, A)
    right = out.clips[out.clips.index(left) + 1]
    assert (left.source_start, left.source_end) == (10, 30)
    assert (right.source_start, right.source_end) == (30, 58)


def test_split_outside_bounds_is_noop():
    base = _tl().to_dict()
    for at in (48, 96, 0, 200):                          # on-edge or outside B
        out = split_clip(_tl(), B, at)
        assert out.to_dict() == base


def test_split_unknown_clip_is_noop():
    out = split_clip(_tl(), "nope", 24)
    assert out.to_dict() == _tl().to_dict()


# --- move_clip ------------------------------------------------------------


def test_move_repositions_without_ripple():
    out = move_clip(_tl(), C, 200)
    assert _clip(out, C).start == 200
    assert _clip(out, A).start == 0 and _clip(out, B).start == 48  # no ripple


def test_move_clamps_start_to_zero():
    out = move_clip(_tl(), C, -50)
    assert _clip(out, C).start == 0


# --- remove_clip ----------------------------------------------------------


def test_remove_without_ripple_leaves_gap():
    out = remove_clip(_tl(), B)
    assert {c.id for c in out.clips} == {A, C, D}
    assert _clip(out, C).start == 96                     # gap remains


def test_remove_with_ripple_closes_gap():
    out = remove_clip(_tl(), B, ripple=True)
    assert {c.id for c in out.clips} == {A, C, D}
    assert _clip(out, C).start == 48                     # shifted left by B's 48
    assert _clip(out, A).end == _clip(out, C).start      # now contiguous


def test_remove_ripple_only_affects_same_track():
    out = remove_clip(_tl(), B, ripple=True)
    assert _clip(out, D).start == 0                       # audio clip untouched


def test_remove_unknown_clip_is_noop():
    out = remove_clip(_tl(), "nope", ripple=True)
    assert out.to_dict() == _tl().to_dict()


# --- freeze_tail_trim -----------------------------------------------------


def test_freeze_tail_trim_keeps_first_live_frames():
    out = freeze_tail_trim(_tl(), A, 24)                 # keep first second @24fps
    a = _clip(out, A)
    assert (a.source_start, a.source_end, a.duration) == (10, 34, 24)
    # no ripple: downstream clips stay put (held tail is a future concern)
    assert _clip(out, B).start == 48


def test_freeze_tail_trim_on_non_video_is_noop():
    out = freeze_tail_trim(_tl(), D, 24)                 # D is audio
    assert _clip(out, D).duration == 100


def test_freeze_tail_trim_live_frames_beyond_duration_is_noop():
    out = freeze_tail_trim(_tl(), A, 500)                # can't keep more than exist
    assert _clip(out, A).duration == 48


def test_freeze_tail_trim_zero_is_noop():
    out = freeze_tail_trim(_tl(), A, 0)
    assert _clip(out, A).duration == 48

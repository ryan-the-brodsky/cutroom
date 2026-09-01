"""Interchange exporters: OTIO (.otio JSON) + CMX3600 EDL.

Pure tests — no DB, no ffmpeg. A small hand-built Timeline (two trimmed video
clips + a still + a VO) is exported both ways and inspected for structural
fidelity, frame accuracy, gaplessness, and lineage survival.
"""
from __future__ import annotations

import importlib.util
import json
import re

import pytest

_HAS_OTIO = importlib.util.find_spec("opentimelineio") is not None

from cutroom.timeline.interchange import (frames_to_timecode, reel_name,
                                          to_edl, to_otio)
from cutroom.timeline.model import Clip, Timeline, Track

TC_RE = re.compile(r"^\d{2}:\d{2}:\d{2}:\d{2}$")
EVENT_RE = re.compile(
    r"^(\d{3})\s+(\S+)\s+(\w+)\s+(\w+)\s+"
    r"(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+"
    r"(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})\s*$"
)


def _timeline() -> Timeline:
    """V1: a full clip, a *trimmed* clip, then a still. A1: a VO that starts
    late (frame 8), which forces a leading Gap on the audio track."""
    v = Track(kind="video", name="V1", order=0)
    a = Track(kind="audio", name="A1", order=1)
    tl = Timeline(fps=24, width=1920, height=1080, tracks=[v, a],
                  cutroom={"project": "next-year", "source": "test"})

    # 0..96 — full clip, machine-generated (prompt/model/seed present)
    tl.clips.append(Clip(
        track_id=v.id, kind="video", start=0, duration=96,
        source="renders/a.mp4", source_start=0, source_end=96,
        source_duration=96, source_fps=24, label="B01-S1",
        cutroom={"shot": "B01-S1", "beat": "open", "prompt": "a lone runner",
                 "model": "ltx-2b", "seed": 42}))

    # 96..144 — TRIMMED clip: shows source frames 20..68 of a 200-frame source
    tl.clips.append(Clip(
        track_id=v.id, kind="video", start=96, duration=48,
        source="renders/b_take3.webm", source_start=20, source_end=68,
        source_duration=200, source_fps=24, label="B01-S2",
        cutroom={"shot": "B01-S2", "beat": "turn"}))

    # 144..216 — a still (true hold)
    tl.clips.append(Clip(
        track_id=v.id, kind="image", start=144, duration=72,
        source="stills/c.png", label="B02-S1",
        cutroom={"shot": "B02-S1", "beat": "land"}))

    # A1 VO starting at frame 8 -> leading gap of 8 frames
    tl.clips.append(Clip(
        track_id=a.id, kind="audio", start=8, duration=180,
        source="audio/vo_line.wav", source_start=0, source_end=180,
        source_duration=180, source_fps=24, label="B01 vo",
        cutroom={"shot": "B01-S1", "role": "vo"}))
    return tl.validate()


# --- OTIO --------------------------------------------------------------------

def _tracks(otio: dict) -> list[dict]:
    return otio["tracks"]["children"]


def _clips(track: dict) -> list[dict]:
    return [c for c in track["children"] if c["OTIO_SCHEMA"] == "Clip.2"]


def test_otio_schema_tags_and_shape():
    otio = to_otio(_timeline())
    assert otio["OTIO_SCHEMA"] == "Timeline.1"
    assert otio["global_start_time"] == {
        "OTIO_SCHEMA": "RationalTime.1", "rate": 24.0, "value": 0}
    assert otio["tracks"]["OTIO_SCHEMA"] == "Stack.1"

    tracks = _tracks(otio)
    assert len(tracks) == 2
    assert [t["kind"] for t in tracks] == ["Video", "Audio"]

    video, audio = tracks
    assert len(_clips(video)) == 3      # two videos + a still
    assert len(_clips(audio)) == 1      # the VO


def test_otio_trimmed_clip_source_range_is_frame_accurate():
    otio = to_otio(_timeline())
    video = _tracks(otio)[0]
    trimmed = _clips(video)[1]          # B01-S2, source 20..68
    assert trimmed["name"] == "B01-S2"
    sr = trimmed["source_range"]
    assert sr["OTIO_SCHEMA"] == "TimeRange.1"
    assert sr["start_time"]["value"] == 20      # == source_start
    assert sr["duration"]["value"] == 48        # == 68 - 20


def test_otio_lineage_survives_under_metadata_cutroom():
    otio = to_otio(_timeline())
    first = _clips(_tracks(otio)[0])[0]
    cutroom = first["metadata"]["cutroom"]
    assert cutroom["shot"] == "B01-S1"
    assert cutroom["beat"] == "open"
    # generated clip -> a GeneratorReference-style block appears in metadata
    gen = first["metadata"]["generator_reference"]
    assert gen["OTIO_SCHEMA"] == "GeneratorReference.1"
    assert gen["parameters"]["seed"] == 42
    assert gen["parameters"]["prompt"] == "a lone runner"
    # a non-generated clip has no generator block
    still = _clips(_tracks(otio)[0])[2]
    assert "generator_reference" not in still["metadata"]


def test_otio_media_reference_carries_source_url():
    otio = to_otio(_timeline())
    first = _clips(_tracks(otio)[0])[0]
    assert first["active_media_reference_key"] == "DEFAULT_MEDIA"
    ref = first["media_references"]["DEFAULT_MEDIA"]
    assert ref["OTIO_SCHEMA"] == "ExternalReference.1"
    assert ref["target_url"] == "renders/a.mp4"
    assert ref["available_range"]["duration"]["value"] == 96


def test_otio_tracks_are_gapless_and_contiguous():
    otio = to_otio(_timeline())
    tl = _timeline()

    # Audio track: VO starts at frame 8 -> a Gap must lead the track.
    audio = _tracks(otio)[1]
    assert audio["children"][0]["OTIO_SCHEMA"] == "Gap.1"
    assert audio["children"][0]["source_range"]["duration"]["value"] == 8

    # Every track: walking children, each item's duration tiles the track with
    # no holes, and each clip lands exactly at its Cutroom start frame.
    starts = {c.label: c.start for c in tl.clips}
    for track in _tracks(otio):
        cursor = 0
        for child in track["children"]:
            dur = child["source_range"]["duration"]["value"]
            if child["OTIO_SCHEMA"] == "Clip.2":
                assert starts[child["name"]] == cursor   # frame-accurate, gapless
            cursor += dur
        assert cursor > 0


def test_otio_serializes_to_json():
    otio = to_otio(_timeline())
    text = json.dumps(otio)          # must be plain-JSON serializable
    assert '"OTIO_SCHEMA": "Timeline.1"' in text


@pytest.mark.skipif(not _HAS_OTIO,
                    reason="opentimelineio not installed; skip package round-trip")
def test_otio_roundtrips_through_package():
    import opentimelineio as otio_pkg

    tl = _timeline()
    doc = otio_pkg.adapters.read_from_string(json.dumps(to_otio(tl)), "otio_json")
    assert len(doc.tracks) == 2
    video = doc.tracks[0]
    clips = [c for c in video if isinstance(c, otio_pkg.schema.Clip)]
    assert len(clips) == 3
    # the trimmed clip keeps its in-point through a real OTIO parse
    assert clips[1].source_range.start_time.value == 20


# --- EDL ---------------------------------------------------------------------

def _events(edl: str) -> list[re.Match]:
    return [m for m in (EVENT_RE.match(ln) for ln in edl.splitlines()) if m]


def test_edl_has_title_and_event_per_video_clip():
    edl = to_edl(_timeline())
    assert edl.splitlines()[0].startswith("TITLE:")
    assert "FCM: NON-DROP FRAME" in edl
    events = _events(edl)
    assert len(events) == 3          # 3 video clips (VO is not in the video EDL)


def test_edl_timecodes_are_well_formed():
    edl = to_edl(_timeline())
    for ev in _events(edl):
        for tc in ev.groups()[4:8]:
            assert TC_RE.match(tc)
    # first event: full clip 0..96 @24fps -> src/rec 00:00:00:00 .. 00:00:04:00
    first = _events(edl)[0]
    assert first.group(5) == "00:00:00:00"   # src_in
    assert first.group(6) == "00:00:04:00"   # src_out
    assert first.group(7) == "00:00:00:00"   # rec_in
    assert first.group(8) == "00:00:04:00"   # rec_out


def test_edl_trimmed_source_in_out():
    edl = to_edl(_timeline())
    trimmed = _events(edl)[1]        # B01-S2: source 20..68 @24fps
    assert trimmed.group(5) == "00:00:00:20"   # src_in  (frame 20)
    assert trimmed.group(6) == "00:00:02:20"   # src_out (frame 68)


def test_edl_record_times_are_contiguous():
    edl = to_edl(_timeline())
    events = _events(edl)
    for prev, cur in zip(events, events[1:]):
        assert cur.group(7) == prev.group(8)   # rec_in == previous rec_out


def test_edl_reel_names_present_and_derived():
    edl = to_edl(_timeline())
    reels = [ev.group(2) for ev in _events(edl)]
    assert all(reels)                # every event names a reel
    assert reels[0] == "A"           # renders/a.mp4 -> stem "a" -> "A"
    assert reels[1] == "BTAKE3"      # renders/b_take3.webm -> "BTAKE3"
    assert "* FROM CLIP NAME:" in edl


def test_frames_to_timecode_and_reel_helpers():
    assert frames_to_timecode(0, 24) == "00:00:00:00"
    assert frames_to_timecode(24, 24) == "00:00:01:00"
    assert frames_to_timecode(3661 * 24 + 5, 24) == "01:01:01:05"
    assert reel_name("path/to/My_Clip-07.mp4") == "MYCLIP07"
    assert reel_name(None) == "AX"
    assert reel_name("stills/a_very_long_source_name.png") == "AVERYLON"

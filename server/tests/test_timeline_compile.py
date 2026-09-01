"""Compiler: film (shots/takes/overrides) → Timeline, and the FreeCut
projection + endpoints."""
from __future__ import annotations

from cutroom.db import init_db, session_scope
from cutroom.models import Project, Shot
from cutroom.storage import get_storage
from cutroom.timeline import compile as tc

from conftest import make_clip, make_image, make_wav


def _setup(pid: str) -> object:
    """A 3-shot film: a 2s clip (48f), a still (held 3s), a 1s clip (24f) under
    a 5s shot, and a 1.5s VO on shot 1. (Unique pid per test.)"""
    init_db()  # tests that don't build the app must create tables themselves
    store = get_storage().create_project(pid)
    make_clip(store.resolve("renders/motion/B01-S1.webm"), seconds=2.0, fps=24)
    make_image(store.resolve("renders/stills/B02-S1_0.png"))
    make_clip(store.resolve("renders/motion/B03-S1.webm"), seconds=1.0, fps=24)
    make_wav(store.resolve("audio/generated/B01-S1_0.wav"), seconds=1.5)
    with session_scope() as s:
        s.add(Project(id=pid, label="t"))
        s.add(Shot(project_id=pid, sid="B01-S1", type="HERO", seconds=4.0,
                   order_idx=0, act=1))
        s.add(Shot(project_id=pid, sid="B02-S1", type="STILL", seconds=3.0,
                   order_idx=1, act=1, keeper="renders/stills/B02-S1_0.png"))
        s.add(Shot(project_id=pid, sid="B03-S1", type="HERO", seconds=5.0,
                   order_idx=2, act=1))
    return store


def test_compile_produces_clip_model(data_dir):
    store = _setup("tl_a")
    with session_scope() as s:
        tl = tc.compile_film(store, s, "tl_a")
    tl.validate()

    vclips = tl.clips_on(tl.tracks[0].id)
    aclips = tl.clips_on(tl.tracks[1].id)
    assert len(vclips) == 3 and len(aclips) == 1

    c1, c2, c3 = vclips
    # shot 1: a 2s (48f) clip under a 4s shot — plays its length (v1: no hold)
    assert c1.kind == "video" and c1.duration == 48
    assert c1.source == "renders/motion/B01-S1.webm"
    assert c1.source_start == 0 and c1.source_end == 48 and c1.source_duration == 48
    assert c1.cutroom["shot"] == "B01-S1"          # lineage rode along
    # shot 2: a still → TRUE hold for the full 3s (72f), image kind
    assert c2.kind == "image" and c2.duration == 72
    # shot 3: a 1s (24f) clip under a 5s shot — clamped to source length
    assert c3.kind == "video" and c3.duration == 24
    # clips are laid end to end: 48 + 72 + 24
    assert [c.start for c in vclips] == [0, 48, 120]
    assert tl.total_frames() == 144

    # VO placed head_pad (0.3s → 7f) after shot 1's start, ~1.5s long (36f)
    vo = aclips[0]
    assert vo.start == 7 and vo.duration == 36
    assert vo.cutroom["role"] == "vo"


def test_override_source_and_seconds_and_mute(data_dir):
    store = _setup("tl_b")
    make_clip(store.resolve("renders/fx/hero.mp4"), seconds=3.0, fps=24)
    with session_scope() as s:
        shot = s.query(Shot).filter_by(project_id="tl_b", sid="B01-S1").one()
        shot.override = {"source": "renders/fx/hero.mp4", "seconds": 2.0,
                         "mute_vo": True}
    with session_scope() as s:
        tl = tc.compile_film(store, s, "tl_b")
    c1 = tl.clips_on(tl.tracks[0].id)[0]
    assert c1.source == "renders/fx/hero.mp4"      # override source wins
    assert c1.duration == 48                        # min(2s=48, clip 72)
    assert not [c for c in tl.clips if c.kind == "audio"]  # VO muted → no A1 clip


def test_freecut_projection_shape(data_dir):
    store = _setup("tl_c")
    with session_scope() as s:
        tl = tc.compile_film(store, s, "tl_c")
    fc = tc.to_freecut_render_input(tl, container="mp4")

    assert fc["fps"] == 24 and fc["width"] == 1920 and fc["height"] == 1080
    assert fc["settings"]["codec"] == "avc" and fc["settings"]["container"] == "mp4"
    types = [i["type"] for i in fc["items"]]
    assert types.count("video") == 2 and types.count("image") == 1 and types.count("audio") == 1
    # every media item carries mediaId + project-relative rel (url filled by harness)
    assert fc["media"] and all(set(m) == {"mediaId", "rel"} for m in fc["media"])
    # a video item exposes source in/out (the thing that makes trims real)
    vid = next(i for i in fc["items"] if i["type"] == "video")
    assert vid["sourceStart"] == 0 and vid["sourceEnd"] == vid["durationInFrames"]
    assert vid["from"] == 0 and vid["trackId"]


def test_multi_vo_lines_lay_sequentially(data_dir):
    """Two VO lines on one shot → two A1 clips, laid in order and never
    overlapping (the first at head_pad, the second butted against it)."""
    store = _setup("tl_mvo")
    # _setup already made B01-S1_0.wav (1.5s → 36f); add a second line.
    make_wav(store.resolve("audio/generated/B01-S1_1.wav"), seconds=1.0)  # 24f
    # multi-VO is driven by the shot's SCRIPTED dialogue-line count (not take
    # variants on disk) — give B01-S1 two lines.
    with session_scope() as s:
        shot = s.query(Shot).filter_by(project_id="tl_mvo", sid="B01-S1").one()
        shot.dialogue = [{"text": "line one"}, {"text": "line two"}]
    with session_scope() as s:
        tl = tc.compile_film(store, s, "tl_mvo")
    tl.validate()

    aclips = tl.clips_on(tl.tracks[1].id)          # A1
    assert len(aclips) == 2
    first, second = aclips                          # clips_on sorts by start
    assert first.start == 7 and first.duration == 36
    assert second.start == 43 and second.duration == 24   # butts against first
    assert first.end <= second.start                # no overlap on A1
    assert [c.cutroom["line"] for c in aclips] == [0, 1]
    assert all(c.cutroom["role"] == "vo" for c in aclips)


def test_music_and_sfx_cues_become_tracks(data_dir):
    """music_cues / sfx_cues in Project.settings compile onto MUSIC / SFX
    audio tracks (order after A1), anchored to their shot/beat span."""
    store = _setup("tl_cues")
    make_wav(store.resolve("audio/music/theme.mp3"), seconds=2.0)
    make_wav(store.resolve("audio/sfx/hit.wav"), seconds=0.5)             # 12f
    with session_scope() as s:
        proj = s.get(Project, "tl_cues")
        proj.settings = {
            # music: real shape — anchored to a shot span, explicit duration
            "music_cues": [{"music-file": "audio/music/theme.mp3",
                            "shots": ["B02-S1"], "duration_s": 2.0,
                            "gain-hint": "-16dB under narration"}],
            # sfx: real shape — shot + offset, duration probed from the file
            "sfx_cues": [{"shot": "B01-S1", "sfx-file": "audio/sfx/hit.wav",
                          "offset": 0.5, "gain-hint": "-8dB accent"}],
        }
    with session_scope() as s:
        tl = tc.compile_film(store, s, "tl_cues")
    tl.validate()

    mt = next(t for t in tl.tracks if t.name == "MUSIC")
    st = next(t for t in tl.tracks if t.name == "SFX")
    assert mt.kind == "audio" and st.kind == "audio"
    assert mt.order == 2 and st.order == 3          # after A1 (order 1)

    # music anchored to B02-S1, which starts at frame 48 (after shot 1's 48f)
    mclips = tl.clips_on(mt.id)
    assert len(mclips) == 1
    assert mclips[0].start == 48 and mclips[0].duration == 48   # 2.0s provided
    assert mclips[0].cutroom["role"] == "music"
    assert mclips[0].cutroom["gain"] == "-16dB under narration"

    # sfx anchored to B01-S1 (starts at 0) + 0.5s offset → frame 12; 0.5s probed
    sclips = tl.clips_on(st.id)
    assert len(sclips) == 1
    assert sclips[0].start == 12 and sclips[0].duration == 12
    assert sclips[0].cutroom["role"] == "sfx"
    assert sclips[0].cutroom["shot"] == "B01-S1"

    # and the projection still holds these as audio items
    fc = tc.to_freecut_render_input(tl)
    assert [i["type"] for i in fc["items"]].count("audio") == 3   # 1 VO + music + sfx


def test_scope_act_filter_rebases_to_zero(data_dir):
    """scope='actN' compiles only that act's shots, re-based to frame 0."""
    pid = "tl_scope"
    init_db()
    store = get_storage().create_project(pid)
    make_clip(store.resolve("renders/motion/B01-S1.webm"), seconds=1.0, fps=24)  # 24f
    make_image(store.resolve("renders/stills/B02-S1_0.png"))
    make_clip(store.resolve("renders/motion/B10-S1.webm"), seconds=1.0, fps=24)  # act2
    with session_scope() as s:
        s.add(Project(id=pid, label="t"))
        s.add(Shot(project_id=pid, sid="B01-S1", type="HERO", seconds=2.0,
                   order_idx=0, act=1))
        s.add(Shot(project_id=pid, sid="B02-S1", type="STILL", seconds=2.0,
                   order_idx=1, act=1, keeper="renders/stills/B02-S1_0.png"))
        s.add(Shot(project_id=pid, sid="B10-S1", type="HERO", seconds=2.0,
                   order_idx=2, act=2))
    with session_scope() as s:
        whole = tc.compile_film(store, s, pid)
        act1 = tc.compile_film(store, s, pid, scope="act1")
        act2 = tc.compile_film(store, s, pid, scope="act2")

    assert len(whole.clips_on(whole.tracks[0].id)) == 3       # unscoped → all 3

    a1v = act1.clips_on(act1.tracks[0].id)
    assert [c.label for c in a1v] == ["B01-S1", "B02-S1"]      # only act-1 shots
    assert a1v[0].start == 0                                    # re-based to 0
    assert all(c.cutroom["act"] == 1 for c in a1v)
    assert act1.cutroom["scope"] == "act1"

    a2v = act2.clips_on(act2.tracks[0].id)
    assert len(a2v) == 1 and a2v[0].label == "B10-S1"
    assert a2v[0].start == 0                                    # act-2 re-based too


def test_timeline_endpoints(client, data_dir):
    _setup("tl_d")
    r = client.get("/api/projects/tl_d/timeline")
    assert r.status_code == 200
    body = r.json()
    assert body["total_frames"] == 144 and body["duration_seconds"] == 6.0
    assert len(body["tracks"]) == 2 and len(body["clips"]) == 4

    r2 = client.get("/api/projects/tl_d/timeline/freecut")
    assert r2.status_code == 200
    assert r2.json()["outputFileName"] == "tl_d.mp4"

    assert client.get("/api/projects/does-not-exist/timeline").status_code == 404

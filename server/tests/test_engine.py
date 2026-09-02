"""Engine tests on synthetic media — no models, no network."""
import json

import numpy as np
import pytest

from conftest import make_clip, make_image, make_wav

from cutroom.engine import assemble, audio, cels, ffmpeg, images, motion


def test_snap_region_expands_to_32():
    # 100x100 region on a 768x448 plate → expanded to /32 on both axes
    reg = images.snap_region([100, 100, 200, 200], 768, 448)
    l, t, r, b = reg
    assert (r - l) % 32 == 0 and (b - t) % 32 == 0
    assert l <= 100 and r >= 200 and t <= 100 and b >= 200


def test_snap_region_pins_plate_edges():
    reg = images.snap_region([0, 0, 100, 100], 768, 448)
    assert reg[0] == 0 and reg[1] == 0
    assert images.pinned_edges(reg, 768, 448) == ["L", "T"]


def test_snap_region_normalized_input():
    reg = images.snap_region([0.0, 0.0, 1.0, 1.0], 768, 448)
    assert reg == [0, 0, 768, 448]


def test_window_alpha_feathers_interior_only():
    win = cels.window_alpha(64, 64, 0, 100, 64, 164, 768, 448, feather=16)
    assert win[32, 0] == 1.0          # left edge on plate edge → hard
    assert win[32, 63] < 0.1          # right edge interior → feathered
    assert win[0, 32] < 0.1           # top interior → feathered


def test_freeze_tail_true_freeze(tmp_path):
    clip = make_clip(tmp_path / "in.mp4", seconds=2.0)
    out = tmp_path / "out.mp4"
    info = motion.freeze_tail(clip, out, live=0.5, total=2.0)
    assert out.exists()
    assert abs(ffmpeg.probe_duration(out) - 2.0) < 0.15
    # frames in the held tail must be IDENTICAL (true freeze, no drift)
    f1 = ffmpeg.extract_frame(out, 1.0, tmp_path / "f1.png")
    f2 = ffmpeg.extract_frame(out, 1.8, tmp_path / "f2.png")
    from PIL import Image
    a = np.asarray(Image.open(f1)).astype(int)
    b = np.asarray(Image.open(f2)).astype(int)
    assert np.abs(a - b).mean() < 2.0
    assert info["hold"] == pytest.approx(1.5, abs=0.01)


def test_composite_single_leaves_plate_untouched(tmp_path):
    plate = make_image(tmp_path / "plate.png", 768, 448)
    clip = make_clip(tmp_path / "cel.webm", seconds=1.0, size="128x96")
    out = tmp_path / "comp.mp4"
    region = [320, 96, 448, 192]     # interior region, /32 already
    cels.composite_single(plate, clip, region, out, feather=0,
                          webm_sibling=False)
    assert out.exists()
    frame = ffmpeg.extract_frame(out, 0.5, tmp_path / "chk.png")
    from PIL import Image
    got = np.asarray(Image.open(frame)).astype(int)
    want = np.asarray(Image.open(plate)).astype(int)
    # far corner (outside the region) must match the plate (codec tolerance)
    assert np.abs(got[400:440, 600:760] - want[400:440, 600:760]).mean() < 6.0
    # inside the region the cel plays (testsrc2 ≠ gradient plate)
    assert np.abs(got[100:190, 330:440] - want[100:190, 330:440]).mean() > 12.0


def test_render_comp_over_a_moving_video_background(tmp_path):
    """A comp background may be a CLIP: the background moves under the cels,
    and both stream frame by frame instead of being decoded into RAM."""
    from pathlib import Path as P
    bg = make_clip(tmp_path / "bg.mp4", seconds=2.0, size="640x384")
    cel = make_clip(tmp_path / "cel.mp4", seconds=1.0, size="128x96")
    out = tmp_path / "comp.mp4"
    comp = {
        "background": str(bg), "duration": 1.5, "width": 640, "height": 384,
        "layers": [{"id": "cel", "clip": str(cel), "region": [128, 96, 256, 192],
                    "feather": 0, "matte": "window",
                    "media": {"loop": "hold"}, "opacity": 1.0, "z": 1}],
    }
    info = cels.render_comp(comp, lambda rel: P(rel), out, webm_sibling=False)
    assert out.exists()
    assert info["background_kind"] == "video"
    assert info["frames"] == 36 and info["layers"] == 1

    from PIL import Image
    first = np.asarray(Image.open(
        ffmpeg.extract_frame(out, 0.05, tmp_path / "a.png"))).astype(int)
    last = np.asarray(Image.open(
        ffmpeg.extract_frame(out, 1.4, tmp_path / "b.png"))).astype(int)
    # the BACKGROUND itself moves (a region no layer covers)
    assert np.abs(first[260:380, 380:620] - last[260:380, 380:620]).mean() > 8.0
    # and so does the cel region
    assert np.abs(first[100:190, 130:250] - last[100:190, 130:250]).mean() > 8.0


def test_probe_dims_and_frame_count_read_clips(tmp_path):
    clip = make_clip(tmp_path / "c.mp4", seconds=1.0, size="320x224")
    assert ffmpeg.probe_dims(clip) == (320, 224)
    assert abs(ffmpeg.probe_frame_count(clip) - 24) <= 1
    still = make_image(tmp_path / "s.png", 640, 384)
    assert ffmpeg.probe_dims(still) == (640, 384)
    assert ffmpeg.is_video(clip) and not ffmpeg.is_video(still)


def test_raw_frame_reader_streams_and_rewinds(tmp_path):
    clip = make_clip(tmp_path / "c.mp4", seconds=1.0, size="64x48")
    with ffmpeg.RawFrameReader(clip, 32, 24) as r:
        a = r.get(0).copy()
        b = r.get(10).copy()
        assert a.shape == (24, 32, 3)
        assert np.abs(a.astype(int) - b.astype(int)).mean() > 1.0
        # seeking backwards restarts the decoder and lands on the same frame
        assert np.array_equal(r.get(0), a)
        # past the end holds the last frame rather than exploding
        assert r.get(10_000).shape == (24, 32, 3)


def test_chain_assembler(tmp_path):
    plate = make_image(tmp_path / "anchor.png", 320, 224)
    seg = make_clip(tmp_path / "seg.mp4", seconds=1.5, size="320x224")
    asm = motion.ChainAssembler(320, 224, 24, tmp_path / "chain")
    asm.prepare_anchor(plate)
    assert asm.gen_frames_for(1.0) == 41    # 24f live + 16 margin → 8k+1
    a1 = asm.add_segment(seg, live=0.5, breath=0.25)
    assert a1.exists()
    asm.add_segment(seg, live=0.5, breath=0.0)
    info = asm.finalize(tmp_path / "chain.mp4", webm_sibling=False)
    assert info["segments"] == 2
    # 12 + 6 breath + 12 = 30 frames
    assert info["frames"] == 30
    assert abs(ffmpeg.probe_duration(tmp_path / "chain.mp4") - 30 / 24) < 0.1


def test_radio_futz_bandlimits(tmp_path):
    src = make_wav(tmp_path / "vo.wav", seconds=1.0, freq=200.0)
    out = tmp_path / "futz.wav"
    audio.futz_file(src, out)
    assert out.exists()
    x = ffmpeg.decode_audio(out)
    # 200 Hz fundamental sits below the 300 Hz corner: energy must drop hard
    src_x = ffmpeg.decode_audio(src)
    assert audio.rms(x) < audio.rms(src_x)
    spec = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(len(x), 1 / 44100)
    low_band = spec[(freqs > 50) & (freqs < 150)].mean()
    voice_band = spec[(freqs > 500) & (freqs < 3000)].mean()
    assert voice_band > low_band


def test_assembler_builds_edl(tmp_path):
    still = make_image(tmp_path / "s1.png", 640, 360)
    clip = make_clip(tmp_path / "m1.mp4", seconds=1.0, size="320x180")
    vo = make_wav(tmp_path / "line.wav", seconds=2.0)
    shots = [
        assemble.TimelineShot("B01-S1", 2.0, still, []),
        # 1s clip in a 3s slot → tail must hold; VO 2s fits with audio_fit
        assemble.TimelineShot("B01-S2", 3.0, clip,
                              [assemble.VOItem(path=vo, offset=0.2)]),
        assemble.TimelineShot("B01-S3", 1.0, None, []),   # slate
    ]
    out = tmp_path / "cut.mp4"
    info = assemble.build_animatic(shots, out, res=(640, 360))
    assert out.exists()
    assert info["shots"] == 3
    assert info["edl"][0]["seconds"] == 2.0
    assert abs(ffmpeg.probe_duration(out) - info["total"]) < 0.25
    streams = ffmpeg.probe_streams(out)
    kinds = {s["codec_type"] for s in streams["streams"]}
    assert kinds == {"video", "audio"}


def test_panel_engine_renders(tmp_path):
    src = make_image(tmp_path / "panelsrc.png", 640, 360)
    spec = {"shot": "t", "duration": 1.0, "fps": 12,
            "layers": [{"fx": "panel_screen", "base": "black",
                        "panels": [{"id": "p1", "source": str(src),
                                    "rect": [200, 100, 600, 400], "angle": 10,
                                    "entry": {"frame": 0, "dur": 4,
                                              "style": "slide",
                                              "from": "left"}}]}]}
    from cutroom.engine import panels
    out = tmp_path / "panel.mp4"
    info = panels.render_panel_script(spec, out, webm_sibling=False)
    assert out.exists()
    assert info["cues"] and info["cues"][0]["id"] == "p1"
    data = json.loads((tmp_path / "panel.cues.json").read_text())
    assert data["cues"][0]["t"] == 0.0

"""Test-mode adapter: real project footage flows through every lane."""
import asyncio

from conftest import make_clip, make_image, make_wav

from cutroom.adapters.base import BackendConfig, GenRequest
from cutroom.adapters.mock import MockAdapter
from cutroom.engine import ffmpeg as e_ff


def _seeded_project(data_dir, pid="src"):
    from cutroom.storage import get_storage
    store = get_storage().create_project(pid)
    make_image(store.resolve("renders/stills/A_s1.png"), 640, 360)
    make_image(store.resolve("renders/stills/B_s2.png"), 640, 360)
    make_clip(store.resolve("renders/motion/M1.webm"), 1.5, "320x224")
    make_wav(store.resolve("audio/generated/B01_x_1.wav"), 1.0)
    return store


def test_mock_still_uses_project_footage(data_dir, tmp_path):
    _seeded_project(data_dir)
    a = MockAdapter(BackendConfig(id="mock", type="mock",
                                  options={"source_project": "src"}))
    req = GenRequest(lane="still", workdir=tmp_path, prompt="x",
                     width=768, height=432, seed=7)
    res = asyncio.run(a.generate(req))
    from PIL import Image
    assert Image.open(res.files[0]).size == (768, 432)
    assert res.meta["mock"] is True


def test_mock_motion_matches_dims_and_frames(data_dir, tmp_path):
    _seeded_project(data_dir)
    a = MockAdapter(BackendConfig(id="mock", type="mock",
                                  options={"source_project": "src"}))
    src = make_image(tmp_path / "crop.png", 128, 96)
    req = GenRequest(lane="motion", workdir=tmp_path, prompt="x", source=src,
                     width=128, height=96, frames=49, seed=3)
    res = asyncio.run(a.generate(req))
    clip = res.files[0]
    assert e_ff.probe_dims(clip) == (128, 96)
    assert abs(e_ff.probe_duration(clip) - 49 / 24) < 0.2


def test_mock_i2i_keeps_layout(data_dir, tmp_path):
    a = MockAdapter(BackendConfig(id="mock", type="mock"))
    src = make_image(tmp_path / "s.png", 320, 224)
    req = GenRequest(lane="i2i", workdir=tmp_path, prompt="x", source=src,
                     denoise=0.85, seed=1)
    res = asyncio.run(a.generate(req))
    from PIL import Image
    import numpy as np
    out = np.asarray(Image.open(res.files[0]))
    orig = np.asarray(Image.open(src))
    assert out.shape == orig.shape
    assert np.abs(out.astype(int) - orig.astype(int)).mean() > 5  # restyled


def test_mock_vo_synthesizes_without_project(data_dir, tmp_path):
    a = MockAdapter(BackendConfig(id="mock", type="mock"))
    req = GenRequest(lane="vo", workdir=tmp_path,
                     prompt="a fifteen character line", seed=1)
    res = asyncio.run(a.generate(req))
    assert e_ff.probe_duration(res.files[0]) > 0.5

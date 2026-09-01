import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "cutroom-data"
    monkeypatch.setenv("CUTROOM_DATA", str(d))
    monkeypatch.delenv("CUTROOM_AUTH_TOKEN", raising=False)
    from cutroom import config, db
    config.reset_settings()
    db.reset_db()
    yield d
    db.reset_db()
    config.reset_settings()


@pytest.fixture()
def client(data_dir):
    from fastapi.testclient import TestClient
    from cutroom.main import create_app
    with TestClient(create_app()) as c:
        yield c


def make_clip(path: Path, seconds: float = 2.0, size: str = "320x224",
              fps: int = 24, color: str = "red") -> Path:
    """A synthetic moving clip (color + timecode-ish noise via hue rotation)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", f"testsrc2=size={size}:rate={fps}:duration={seconds}",
         "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


def make_image(path: Path, w: int = 768, h: int = 448) -> Path:
    from PIL import Image
    path.parent.mkdir(parents=True, exist_ok=True)
    arr = np.zeros((h, w, 3), np.uint8)
    arr[:, :, 0] = np.linspace(0, 255, w, dtype=np.uint8)[None, :]
    arr[:, :, 1] = np.linspace(0, 255, h, dtype=np.uint8)[:, None]
    Image.fromarray(arr).save(path)
    return path


def make_wav(path: Path, seconds: float = 1.0, freq: float = 440.0,
             sr: int = 44100) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(seconds * sr)) / sr
    x = (0.4 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "1",
         "-ar", str(sr), "-i", "-", str(path)],
        input=x.tobytes(), check=True)
    return path

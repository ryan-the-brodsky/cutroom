"""ffmpeg/ffprobe plumbing shared by every engine module."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

H264_ARGS = ["-c:v", "libx264", "-preset", "medium", "-crf", "17",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
VP9_ARGS = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "24", "-pix_fmt", "yuv420p"]


class FFmpegError(RuntimeError):
    pass


def run(cmd: list[str], input_bytes: bytes | None = None) -> bytes:
    r = subprocess.run(cmd, input=input_bytes, capture_output=True)
    if r.returncode != 0:
        tail = r.stderr.decode(errors="replace")[-2000:]
        raise FFmpegError(f"{' '.join(str(c) for c in cmd[:6])}… failed: {tail}")
    return r.stdout


def probe_duration(path: str | Path) -> float:
    out = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
               "-of", "csv=p=0", str(path)])
    return round(float(out.decode().strip()), 3)


def probe_dims(path: str | Path) -> tuple[int, int]:
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)])
    w, h = out.decode().strip().split(",")[:2]
    return int(w), int(h)


def probe_streams(path: str | Path) -> dict:
    out = run([FFPROBE, "-v", "error", "-show_streams", "-show_format",
               "-of", "json", str(path)])
    return json.loads(out.decode())


def extract_frame(src: str | Path, t: float, out: str | Path) -> Path:
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    run([FFMPEG, "-v", "error", "-y", "-ss", str(t), "-i", str(src),
         "-vframes", "1", str(out)])
    return Path(out)


def extract_all_frames(src: str | Path, outdir: str | Path | None = None) -> list[Path]:
    d = Path(outdir) if outdir else Path(tempfile.mkdtemp(prefix="cutroom_frames_"))
    d.mkdir(parents=True, exist_ok=True)
    run([FFMPEG, "-v", "error", "-y", "-i", str(src), str(d / "f%05d.png")])
    return sorted(d.glob("f*.png"))


def encode_frames_dir(frames_pattern: str | Path, out: str | Path, fps: int = 24,
                      webm_sibling: bool = False) -> Path:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    run([FFMPEG, "-v", "error", "-y", "-framerate", str(fps),
         "-i", str(frames_pattern), *H264_ARGS, str(out)])
    if webm_sibling:
        run([FFMPEG, "-v", "error", "-y", "-framerate", str(fps),
             "-i", str(frames_pattern), *VP9_ARGS, str(out.with_suffix(".webm"))])
    return out


def transcode(src: str | Path, out: str | Path, extra: list[str] | None = None) -> Path:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    args = VP9_ARGS if out.suffix == ".webm" else H264_ARGS
    run([FFMPEG, "-v", "error", "-y", "-i", str(src), *(extra or []), *args, str(out)])
    return out


def make_thumb(src: str | Path, out: str | Path, t: float = 0.3, width: int = 320) -> Path:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    src = Path(src)
    if src.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
        run([FFMPEG, "-v", "error", "-y", "-i", str(src),
             "-vf", f"scale={width}:-2", str(out)])
    else:
        run([FFMPEG, "-v", "error", "-y", "-ss", str(t), "-i", str(src),
             "-vframes", "1", "-vf", f"scale={width}:-2", str(out)])
    return out


class RawFrameEncoder:
    """Stream raw rgb24 frames to ffmpeg; h264 out (+optional vp9 sibling)."""

    def __init__(self, out: str | Path, width: int, height: int, fps: int = 24):
        self.out = Path(out)
        self.out.parent.mkdir(parents=True, exist_ok=True)
        self.size = (width, height)
        self.proc = subprocess.Popen(
            [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
             "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
             *H264_ARGS, str(self.out)],
            stdin=subprocess.PIPE)

    def write(self, frame: np.ndarray) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(np.ascontiguousarray(frame, np.uint8).tobytes())

    def close(self, webm_sibling: bool = False) -> Path:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        if self.proc.wait() != 0:
            raise FFmpegError(f"raw encode failed for {self.out}")
        if webm_sibling:
            run([FFMPEG, "-v", "error", "-y", "-i", str(self.out), *VP9_ARGS,
                 str(self.out.with_suffix(".webm"))])
        return self.out


# ---------------------------------------------------------------- audio i/o

def decode_audio(path: str | Path, sr: int = 44100) -> np.ndarray:
    """Any audio container → mono float64 at sr."""
    raw = run([FFMPEG, "-v", "error", "-i", str(path),
               "-f", "f32le", "-ac", "1", "-ar", str(sr), "-"])
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def encode_audio(x: np.ndarray, path: str | Path, sr: int = 44100) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.clip(x, -1.0, 1.0).astype(np.float32).tobytes()
    run([FFMPEG, "-v", "error", "-y", "-f", "f32le", "-ac", "1",
         "-ar", str(sr), "-i", "-", str(path)], input_bytes=data)
    return path

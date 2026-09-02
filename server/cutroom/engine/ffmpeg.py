"""ffmpeg/ffprobe plumbing shared by every engine module."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
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


VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi", ".gif"}


def is_video(path: str | Path) -> bool:
    """Cheap, extension-based: is this a clip rather than a still?"""
    return Path(path).suffix.lower() in VIDEO_SUFFIXES


def probe_dims(path: str | Path) -> tuple[int, int]:
    """Pixel dimensions of the first video stream. Works for stills too
    (ffprobe reads png/jpg/webp as one-frame video streams)."""
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)])
    line = next((ln for ln in out.decode().splitlines() if ln.strip()), "")
    parts = [p for p in line.strip().split(",") if p.strip().isdigit()]
    if len(parts) < 2:
        raise FFmpegError(f"could not read dimensions of {path}")
    return int(parts[0]), int(parts[1])


def probe_frame_count(path: str | Path) -> int:
    """How many frames a clip has. `nb_frames` when the container carries it
    (mp4), a counted decode otherwise (webm rarely does)."""
    try:
        info = probe_streams(path)
        for st in info.get("streams", []):
            if st.get("codec_type") != "video":
                continue
            n = st.get("nb_frames")
            if n is not None and str(n).isdigit() and int(n) > 0:
                return int(n)
    except FFmpegError:
        pass
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_frames",
               "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path)])
    digits = "".join(c for c in out.decode() if c.isdigit())
    return max(1, int(digits or 1))


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


#: x264 holds a frame buffer per thread plus its lookahead, which is the
#: largest single allocation in a comp render. Capping threads keeps a 1 GB
#: container alive; override with CUTROOM_ENCODER_THREADS=0 for "all cores".
ENCODER_THREADS = int(os.environ.get("CUTROOM_ENCODER_THREADS", "4"))


class RawFrameEncoder:
    """Stream raw rgb24 frames to ffmpeg; h264 out (+optional vp9 sibling).

    Captures the encoder's stderr, so when it dies mid-stream you get its own
    last words instead of a bare `BrokenPipeError` from the write. A process
    killed by a signal (SIGKILL on a memory-capped box) is reported as such.
    """

    def __init__(self, out: str | Path, width: int, height: int, fps: int = 24):
        self.out = Path(out)
        self.out.parent.mkdir(parents=True, exist_ok=True)
        if width % 2 or height % 2 or width < 2 or height < 2:
            raise FFmpegError(
                f"h264/yuv420p needs even dimensions of at least 2px; "
                f"got {width}x{height} for {self.out}")
        self.size = (width, height)
        self.frames_written = 0
        self._err: list[str] = []
        threads = ["-threads", str(ENCODER_THREADS)] if ENCODER_THREADS else []
        self.cmd = [FFMPEG, "-v", "error", "-y", "-f", "rawvideo",
                    "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
                    "-r", str(fps), "-i", "-", *threads, *H264_ARGS, str(self.out)]
        self.proc = subprocess.Popen(self.cmd, stdin=subprocess.PIPE,
                                     stderr=subprocess.PIPE)
        self._drain = threading.Thread(target=self._read_stderr, daemon=True)
        self._drain.start()

    def _read_stderr(self) -> None:
        stream = self.proc.stderr
        if stream is None:
            return
        for line in stream:
            text = line.decode(errors="replace").rstrip()
            if text:
                self._err.append(text)
            del self._err[:-40]          # only the tail is ever useful

    def _die(self, why: str) -> "FFmpegError":
        self.proc.wait()
        self._drain.join(timeout=2)
        rc = self.proc.returncode
        note = ""
        if rc is not None and rc < 0:
            note = (f" — killed by signal {-rc}; on a memory-capped box that is "
                    "usually the OOM killer, so lower the comp's width/height or "
                    "CUTROOM_ENCODER_THREADS")
        tail = "\n".join(self._err[-12:]) or "(ffmpeg wrote nothing to stderr)"
        return FFmpegError(
            f"{why} after {self.frames_written} frame(s) at "
            f"{self.size[0]}x{self.size[1]} -> {self.out}: exit {rc}{note}\n{tail}")

    def write(self, frame: np.ndarray) -> None:
        assert self.proc.stdin is not None
        arr = np.ascontiguousarray(frame, np.uint8)
        want = (self.size[1], self.size[0], 3)
        if arr.shape != want:
            raise FFmpegError(
                f"frame {self.frames_written} is {arr.shape}, but the encoder was "
                f"opened for {want} ({self.out}). Resize before writing.")
        try:
            self.proc.stdin.write(arr.tobytes())
        except (BrokenPipeError, OSError) as e:
            raise self._die(f"the encoder exited mid-stream ({type(e).__name__})") from None
        self.frames_written += 1

    def close(self, webm_sibling: bool = False) -> Path:
        assert self.proc.stdin is not None
        try:
            self.proc.stdin.close()
        except (BrokenPipeError, OSError):
            raise self._die("the encoder exited before the stream was closed") from None
        if self.proc.wait() != 0:
            raise self._die("raw encode failed")
        self._drain.join(timeout=2)
        if webm_sibling:
            run([FFMPEG, "-v", "error", "-y", "-i", str(self.out), *VP9_ARGS,
                 str(self.out.with_suffix(".webm"))])
        return self.out


class RawFrameReader:
    """Stream one video's frames as rgb24 numpy arrays, optionally rescaled by
    ffmpeg on the way out. Holds ONE frame in memory, not the whole clip —
    this is what keeps the cel compositor inside a 1 GB box.

    `get(i)` is random access over a forward-only pipe: seeking backwards
    restarts the decoder. Cel clips are tens of frames, so that is cheap.
    """

    def __init__(self, src: str | Path, width: int | None = None,
                 height: int | None = None):
        self.src = str(src)
        sw, sh = probe_dims(src)
        self.width = int(width or sw)
        self.height = int(height or sh)
        # An explicit size always scales: rotation metadata, a non-square SAR or
        # a container that lies about its coded size would otherwise hand back
        # frames of a different geometry than the caller sized its buffers for.
        self._scale = (width is not None or height is not None
                       or (self.width, self.height) != (sw, sh))
        self._frame_bytes = self.width * self.height * 3
        self.proc: subprocess.Popen | None = None
        self._next = 0          # index the pipe will hand back next
        self._cur: np.ndarray | None = None
        self._cur_index = -1

    def _open(self) -> None:
        self.close()
        cmd = [FFMPEG, "-v", "error", "-i", self.src]
        if self._scale:
            cmd += ["-vf", f"scale={self.width}:{self.height}:flags=lanczos"]
        cmd += ["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL)
        self._next = 0

    def _read_one(self) -> np.ndarray | None:
        if self.proc is None or self.proc.stdout is None:
            return None
        buf = self.proc.stdout.read(self._frame_bytes)
        if not buf or len(buf) < self._frame_bytes:
            return None
        self._next += 1
        return np.frombuffer(buf, np.uint8).reshape(self.height, self.width, 3)

    def get(self, index: int) -> np.ndarray:
        """The frame at `index`, clamped to the last decoded frame."""
        if index == self._cur_index and self._cur is not None:
            return self._cur
        if self.proc is None or index < self._next - 1:
            self._open()
        frame = self._cur
        while self._next <= index:
            nxt = self._read_one()
            if nxt is None:
                break                      # past the end: hold the last frame
            frame = nxt
        if frame is None:
            raise FFmpegError(f"no frames decoded from {self.src}")
        self._cur, self._cur_index = frame, index
        return frame

    def close(self) -> None:
        if self.proc is not None:
            try:
                if self.proc.stdout:
                    self.proc.stdout.close()
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except Exception:
                pass
            self.proc = None

    def __enter__(self): return self

    def __exit__(self, *exc): self.close()


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

"""Motion edits under the FIRST-SECOND LAW.

LTX-class i2v models produce their cleanest anime in the first ~1s (closest to
the clamped first frame); photoreal drift accumulates with motion and time.
The limited-animation answer: a burst of motion, then the held cel. These are
the mechanical edits behind the director grammar ("keep the first second",
"freeze from the 1.5s mark", "stitch these with a breath between").

Holds are TRUE freezes — no zoom, no drift (director ruling: zoompan-style
slow pushes read choppy/nauseating; the effect is banned platform-wide).
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Callable

from PIL import Image

from . import ffmpeg
from .images import cover


def freeze_tail(inp: str | Path, out: str | Path, live: float = 1.0,
                total: float | None = None, fps: int = 24,
                log: Callable[[str], None] = lambda s: None) -> dict:
    """Keep the first `live` seconds, hold the last live frame to `total`."""
    src_dur = ffmpeg.probe_duration(inp)
    total = total or src_dur
    live = min(live, src_dur)
    hold = max(0.0, total - live)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="cutroom_ft_") as td:
        td = Path(td)
        head = td / "head.mp4"
        ffmpeg.run([ffmpeg.FFMPEG, "-v", "error", "-y", "-i", str(inp),
                    "-t", f"{live}", *ffmpeg.H264_ARGS, str(head)])
        frame_t = max(0.0, live - 1.0 / fps)
        frame = td / "frame.png"
        ffmpeg.extract_frame(inp, frame_t, frame)
        vw, vh = ffmpeg.probe_dims(head)
        tail = td / "tail.mp4"
        ffmpeg.run([ffmpeg.FFMPEG, "-v", "error", "-y", "-loop", "1",
                    "-i", str(frame), "-t", f"{hold}",
                    "-vf", f"scale={vw}:{vh}", "-r", str(fps),
                    *ffmpeg.H264_ARGS, str(tail)])
        lst = td / "list.txt"
        lst.write_text(f"file '{head}'\nfile '{tail}'\n")
        ffmpeg.run([ffmpeg.FFMPEG, "-v", "error", "-y", "-f", "concat",
                    "-safe", "0", "-i", str(lst), *ffmpeg.H264_ARGS, str(out)])
    log(f"freeze-tail: {live}s live + {hold:.2f}s held -> {out}")
    return {"live": live, "hold": round(hold, 3), "total": total,
            "out": str(out)}


def trim(inp: str | Path, out: str | Path, start: float = 0.0,
         end: float | None = None) -> dict:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg.FFMPEG, "-v", "error", "-y", "-ss", str(start), "-i", str(inp)]
    if end is not None:
        cmd += ["-t", str(max(0.0, end - start))]
    ffmpeg.run(cmd + [*ffmpeg.H264_ARGS, str(out)])
    return {"start": start, "end": end, "out": str(out)}


class ChainAssembler:
    """Breath-stitching (chain-gen's assembly half, generation-agnostic).

    anchor still → generated segment (keep the first `live` s) → freeze the
    last kept frame for `breath` s (an anime hold) → that frame is the next
    anchor → repeat. Every segment starts from an anime-clean anchor so style
    never decays; breaths land on motion-stop points.

    The caller owns generation: prepare_anchor() → [generate clip from
    current_anchor] → add_segment(clip, live, breath) → … → finalize(out).
    """

    def __init__(self, width: int = 768, height: int = 448, fps: int = 24,
                 workdir: str | Path | None = None):
        self.width, self.height, self.fps = width, height, fps
        self.dir = Path(workdir) if workdir else Path(
            tempfile.mkdtemp(prefix="cutroom_chain_"))
        self.dir.mkdir(parents=True, exist_ok=True)
        self.frames_dir = self.dir / "frames"
        self.frames_dir.mkdir(exist_ok=True)
        self.anchors_dir = self.dir / "anchors"
        self.anchors_dir.mkdir(exist_ok=True)
        self.idx = 0
        self.seg = 0
        self.current_anchor: Path | None = None

    def prepare_anchor(self, plate: str | Path) -> Path:
        img = cover(Image.open(plate).convert("RGB"), (self.width, self.height))
        p = self.anchors_dir / "anchor00.png"
        img.save(p)
        self.current_anchor = p
        return p

    def _emit(self, src: Path) -> None:
        shutil.copy(src, self.frames_dir / f"o{self.idx:06d}.png")
        self.idx += 1

    def add_segment(self, clip: str | Path, live: float, breath: float) -> Path:
        """Keep `live` seconds of the clip, then `breath` seconds of held frame.
        Returns the new anchor (the last kept frame)."""
        live_n = max(1, round(live * self.fps))
        breath_n = max(0, round(breath * self.fps))
        with tempfile.TemporaryDirectory(prefix="cutroom_seg_") as td:
            frames = ffmpeg.extract_all_frames(clip, td)
            kept = frames[:live_n]
            if not kept:
                raise ValueError(f"segment produced no frames: {clip}")
            for f in kept:
                self._emit(f)
            self.seg += 1
            anchor = self.anchors_dir / f"anchor{self.seg:02d}.png"
            shutil.copy(kept[-1], anchor)
        for _ in range(breath_n):
            self._emit(anchor)
        self.current_anchor = anchor
        return anchor

    def gen_frames_for(self, live: float, cap: int = 97) -> int:
        """Generation length: live window + continuation margin, 8k+1."""
        live_n = max(1, round(live * self.fps))
        return min(cap, max(33, ((live_n + 16) // 8) * 8 + 1))

    def finalize(self, out: str | Path, webm_sibling: bool = True) -> dict:
        out = ffmpeg.encode_frames_dir(self.frames_dir / "o%06d.png", out,
                                       self.fps, webm_sibling=webm_sibling)
        return {"frames": self.idx, "segments": self.seg, "out": str(out),
                "anchors_dir": str(self.anchors_dir)}

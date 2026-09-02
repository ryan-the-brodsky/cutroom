"""The animatic assembler, re-grounded on ffmpeg.

Replaces the film's PyAV assembler (which was welded to the ComfyUI venv and
the game7 repo layout) with a portable implementation of the same contract:

- V track: ordered shots; each plays its source for its (overridden) seconds.
  Stills hold TRUE still. Motion sources that run short hold their last frame
  (tpad clone — a freeze, not a loop). Missing sources cut to black slate.
- A track: per-shot VO placed at shot_start + head_pad + vo_offset, plus
  absolute-time music/SFX cues. VO is king at 0 dB; cue gains ride under it.
- audio-fit: a shot stretches so its line finishes before the cut
  (max(scripted, vo_end + 0.4s tail) — the J-cut discipline).

Buildable at any completion percentage; the EDL comes back with the result.
"""
from __future__ import annotations

import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import ffmpeg

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


@dataclass
class VOItem:
    path: Path
    offset: float = 0.0        # seconds after the shot's head pad
    gain_db: float = 0.0


@dataclass
class AudioCue:
    """A music or SFX cue on the A track.

    Anchored either absolutely (`start`, timeline seconds) or to a shot
    (`shot`, resolved against the finished EDL so audio-fit stretching moves
    the cue with its picture). `offset` adds to whichever anchor won.
    `gain_db` is decibels — 0 is unity, negative rides under the VO.
    """
    path: Path
    start: float = 0.0         # absolute timeline seconds
    gain_db: float = 0.0
    duration: float | None = None  # optional trim
    shot: str | None = None    # sid (or beat) anchor; wins over `start`
    offset: float = 0.0        # seconds added to the anchor
    fade_in: float = 0.0
    fade_out: float = 0.0
    loop: bool = False         # repeat the file to fill `duration`


@dataclass
class TimelineShot:
    sid: str
    seconds: float
    source: Path | None        # image or video; None → black slate
    vo: list[VOItem] = field(default_factory=list)
    audio_fit: bool = True


def _cover_vf(w: int, h: int) -> str:
    return (f"scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h},setsar=1")


def _render_segment(shot: TimelineShot, seconds: float, out: Path,
                    w: int, h: int, fps: int) -> None:
    common = ["-r", str(fps), "-t", f"{seconds:.3f}", "-an", *ffmpeg.H264_ARGS]
    if shot.source is None:
        ffmpeg.run([ffmpeg.FFMPEG, "-v", "error", "-y", "-f", "lavfi",
                    "-i", f"color=black:s={w}x{h}:r={fps}", *common, str(out)])
        return
    src = Path(shot.source)
    if src.suffix.lower() in IMAGE_EXTS:
        # TRUE still hold — a looped frame, zero motion.
        ffmpeg.run([ffmpeg.FFMPEG, "-v", "error", "-y", "-loop", "1",
                    "-i", str(src), "-vf", _cover_vf(w, h), *common, str(out)])
        return
    src_dur = ffmpeg.probe_duration(src)
    vf = _cover_vf(w, h)
    if src_dur < seconds - 1.0 / fps:
        # hold the last frame to fill the shot (a freeze, never a loop)
        vf += f",tpad=stop_mode=clone:stop_duration={seconds - src_dur + 0.5:.3f}"
    ffmpeg.run([ffmpeg.FFMPEG, "-v", "error", "-y", "-i", str(src),
                "-vf", vf, *common, str(out)])


@dataclass
class _MixItem:
    """One input on the A-track mix: where it lands and how it is shaped."""
    path: Path
    start: float
    gain_db: float = 0.0
    trim: float | None = None
    fade_in: float = 0.0
    fade_out: float = 0.0
    loop: bool = False


def _mix_audio(items: list[_MixItem], total: float, out: Path) -> None:
    """One ffmpeg pass: gain, optional loop/trim, fades, delay, amix."""
    if not items:
        ffmpeg.run([ffmpeg.FFMPEG, "-v", "error", "-y", "-f", "lavfi",
                    "-i", "anullsrc=r=44100:cl=stereo",
                    "-t", f"{total:.3f}", str(out)])
        return
    cmd = [ffmpeg.FFMPEG, "-v", "error", "-y"]
    filters = []
    labels = []
    for i, it in enumerate(items):
        # A looping cue must be trimmed or it runs forever; the mix's own
        # atrim would still bound it, but -stream_loop wants a stop.
        if it.loop and it.trim:
            cmd += ["-stream_loop", "-1"]
        cmd += ["-i", str(it.path)]
        ms = max(0, int(round(it.start * 1000)))
        chain = (f"[{i}:a]aresample=44100,"
                 f"aformat=channel_layouts=stereo,volume={it.gain_db}dB")
        span = it.trim
        if span:
            chain += f",atrim=duration={span:.3f},asetpts=PTS-STARTPTS"
        if it.fade_in > 0:
            chain += f",afade=t=in:st=0:d={it.fade_in:.3f}"
        if it.fade_out > 0:
            if span is None:
                try:
                    span = ffmpeg.probe_duration(it.path)
                except Exception:
                    span = None
            if span and span > it.fade_out:
                chain += (f",afade=t=out:st={span - it.fade_out:.3f}"
                          f":d={it.fade_out:.3f}")
        chain += f",adelay={ms}|{ms}[a{i}]"
        filters.append(chain)
        labels.append(f"[a{i}]")
    filters.append(f"{''.join(labels)}amix=inputs={len(items)}:"
                   f"duration=longest:normalize=0,"
                   f"apad,atrim=duration={total:.3f}[aout]")
    cmd += ["-filter_complex", ";".join(filters), "-map", "[aout]", str(out)]
    ffmpeg.run(cmd)


def _cue_start(cue: AudioCue, anchors: dict[str, float]) -> float | None:
    """Absolute seconds for a cue, or None when its shot is out of scope."""
    if cue.shot:
        base = anchors.get(cue.shot)
        if base is None:
            return None
        return max(0.0, base + cue.offset)
    return max(0.0, float(cue.start or 0.0) + cue.offset)


def build_animatic(shots: list[TimelineShot], out: str | Path,
                   res: tuple[int, int] = (1280, 720), fps: int = 24,
                   head_pad: float = 0.3, cues: list[AudioCue] | None = None,
                   audio_fit_pad: float = 0.4,
                   log: Callable[[str], None] = lambda s: None) -> dict:
    w, h = res
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cues = cues or []

    # --- timing pass (audio-fit) ------------------------------------------
    edl = []
    t = 0.0
    for shot in shots:
        seconds = float(shot.seconds)
        vo_entries = []
        for vo in shot.vo:
            try:
                dur = ffmpeg.probe_duration(vo.path)
            except Exception:
                log(f"[warn] unreadable VO skipped: {vo.path}")
                continue
            vo_entries.append((vo, dur))
        if shot.audio_fit and vo_entries:
            need = max(head_pad + vo.offset + dur + audio_fit_pad
                       for vo, dur in vo_entries)
            if need > seconds:
                seconds = need
        edl.append({"sid": shot.sid, "start": round(t, 3),
                    "seconds": round(seconds, 3),
                    "source": str(shot.source) if shot.source else None,
                    "shot": shot, "vo_entries": vo_entries})
        t += seconds
    total = round(t, 3)

    # Shot-anchored cues resolve against the FINISHED edl, so a cue placed on
    # a shot moves with it when audio-fit stretches the shot. Beats resolve to
    # their first shot ("B10" → the start of B10-S1).
    anchors: dict[str, float] = {}
    for e in edl:
        anchors[e["sid"]] = e["start"]
        beat = str(e["sid"]).split("-")[0]
        if beat and beat not in anchors:
            anchors[beat] = e["start"]

    with tempfile.TemporaryDirectory(prefix="cutroom_asm_") as td:
        td = Path(td)
        # --- V track ------------------------------------------------------
        seg_paths = []
        for i, e in enumerate(edl):
            seg = td / f"seg{i:04d}.mp4"
            _render_segment(e["shot"], e["seconds"], seg, w, h, fps)
            seg_paths.append(seg)
            log(f"[{e['sid']}] segment {e['seconds']}s "
                f"({'slate' if not e['source'] else Path(e['source']).name})")
        lst = td / "concat.txt"
        lst.write_text("".join(f"file '{p}'\n" for p in seg_paths))
        vtrack = td / "vtrack.mp4"
        try:
            ffmpeg.run([ffmpeg.FFMPEG, "-v", "error", "-y", "-f", "concat",
                        "-safe", "0", "-i", str(lst), "-c", "copy", str(vtrack)])
        except ffmpeg.FFmpegError:
            log("[warn] stream-copy concat failed; re-encoding")
            ffmpeg.run([ffmpeg.FFMPEG, "-v", "error", "-y", "-f", "concat",
                        "-safe", "0", "-i", str(lst), *ffmpeg.H264_ARGS,
                        str(vtrack)])

        # --- A track ------------------------------------------------------
        items: list[_MixItem] = []
        for e in edl:
            for vo, _dur in e["vo_entries"]:
                items.append(_MixItem(Path(vo.path),
                                      e["start"] + head_pad + vo.offset,
                                      vo.gain_db))
        for cue in cues:
            if not Path(cue.path).exists():
                log(f"[warn] missing cue skipped: {cue.path}")
                continue
            at = _cue_start(cue, anchors)
            if at is None:
                log(f"[warn] cue anchored to {cue.shot} (not in this cut) "
                    f"skipped: {Path(cue.path).name}")
                continue
            items.append(_MixItem(Path(cue.path), at, cue.gain_db,
                                  cue.duration, cue.fade_in, cue.fade_out,
                                  bool(cue.loop)))
        atrack = td / "mix.wav"
        _mix_audio(items, total, atrack)

        # --- mux ----------------------------------------------------------
        ffmpeg.run([ffmpeg.FFMPEG, "-v", "error", "-y", "-i", str(vtrack),
                    "-i", str(atrack), "-map", "0:v", "-map", "1:a",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-t", f"{total:.3f}", str(out)])

    result_edl = [{k: e[k] for k in ("sid", "start", "seconds", "source")}
                  for e in edl]
    log(f"animatic: {len(edl)} shots, {total}s -> {out}")
    return {"out": str(out), "total": total, "shots": len(edl),
            "audio_items": len(items), "edl": result_edl}

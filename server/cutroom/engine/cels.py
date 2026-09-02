"""The cel system — a background plate that video models never touch, plus
z-ordered animated layers merged through feathered windows or figure mattes.

Generalized from game7's comp_render.py / anime-fx.py cel_composite. The
comp dict is the same data model the dashboard used:

The background may be a still plate OR a clip: a still is the classic cel
grammar (the plate never shimmers, video models never touch it), a clip lets
a moving background carry moving cels. Both stream frame by frame.

comp = {
  "background": "renders/stills/B04-S3_s870934406.png",   # still OR clip
  "background_media": {"loop": "hold", "speed": 1.0},      # clip backgrounds
  "width": 1920, "height": 1080, "duration": 4.0,          # omit → longest layer
  "layers": [
    {"id": "hand", "clip": "renders/motion/tests/B04-S3-dial-crop.webm",
     "region": [384, 96, 960, 416],       # px on the SOURCE plate (or 0..1)
     "feather": 24, "matte": "window",    # window | figure
     "media": {"loop": "hold", "speed": 1.0, "start": 0},
     "opacity": 1.0, "z": 1}
  ]
}
"""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image

from . import ffmpeg
from .images import cover, to_pixels

Resolver = Callable[[str], Path]


def _even(n: int) -> int:
    """h264 + yuv420p cannot encode an odd dimension."""
    return max(2, int(n) - (int(n) % 2))


def window_alpha(rw: int, rh: int, l: int, t: int, r: int, b: int,
                 pw: int, ph: int, feather: int) -> np.ndarray:
    """Feather interior seams only; plate-edge-coincident edges stay hard
    (entrances come through those)."""
    win = np.ones((rh, rw), np.float32)
    if feather > 0:
        ramp = np.linspace(0.0, 1.0, feather, endpoint=False, dtype=np.float32)
        if l > 0:
            win[:, :feather] = np.minimum(win[:, :feather], ramp[None, :])
        if r < pw:
            win[:, rw - feather:] = np.minimum(win[:, rw - feather:],
                                               ramp[::-1][None, :])
        if t > 0:
            win[:feather, :] = np.minimum(win[:feather, :], ramp[:, None])
        if b < ph:
            win[rh - feather:, :] = np.minimum(win[rh - feather:, :],
                                               ramp[::-1][:, None])
    return win


def media_index(f: int, n: int, media: dict) -> int:
    speed = float(media.get("speed", 1.0))
    start = int(media.get("start", 0))
    mi = start + int(f * speed)
    mode = media.get("loop", "hold")
    if mode == "loop":
        return mi % n
    if mode == "pingpong":
        cyc = mi % (2 * n - 2) if n > 1 else 0
        return cyc if cyc < n else 2 * n - 2 - cyc
    return min(mi, n - 1)


def decode_video_frames(path: str | Path) -> list[Image.Image]:
    """Every frame of a clip, in memory. Kept for callers that genuinely want
    the whole thing; the compositor streams instead (see ffmpeg.RawFrameReader)."""
    with tempfile.TemporaryDirectory(prefix="cutroom_cel_") as d:
        return [Image.open(p).convert("RGB").copy()
                for p in ffmpeg.extract_all_frames(path, d)]


_MATTE_SESSION = None


def _matte_session():
    """One isnet-anime session for the life of the process — building it per
    frame would dominate the render."""
    global _MATTE_SESSION
    if _MATTE_SESSION is None:
        from rembg import new_session  # type: ignore
        _MATTE_SESSION = new_session("isnet-anime")
    return _MATTE_SESSION


def try_figure_mattes(frames: list[Image.Image]) -> list[np.ndarray] | None:
    """rembg isnet-anime figure mattes; returns None when rembg is absent
    (the layer degrades to its feathered window). Called one frame at a time
    by the streaming compositor."""
    try:
        from rembg import remove  # type: ignore
        session = _matte_session()
    except Exception:
        return None
    out = []
    for f in frames:
        rgba = remove(f, session=session)
        out.append(np.asarray(rgba.split()[-1], np.float32) / 255.0)
    return out


def render_comp(comp: dict, resolve: Resolver, out: str | Path, fps: int = 24,
                webm_sibling: bool = True,
                log: Callable[[str], None] = lambda s: None) -> dict:
    """Deterministically re-render a composition from its data model.

    Streams: the background and every layer are decoded one frame at a time
    through ffmpeg pipes, composited with numpy, and piped straight into an
    encoder. Peak memory is a handful of frames regardless of clip length,
    which is what lets a 1 GB demo box render a moving background under
    moving cels.
    """
    bg_rel = comp["background"]
    bg_path = resolve(bg_rel)
    bg_video = ffmpeg.is_video(bg_path)

    plate_np = None
    bg_reader = None
    bg_frames = 1
    bg_media = comp.get("background_media") or {"loop": "hold"}
    if bg_video:
        pw, ph = ffmpeg.probe_dims(bg_path)
        bg_frames = max(1, ffmpeg.probe_frame_count(bg_path))
        bg_reader = ffmpeg.RawFrameReader(bg_path)
    else:
        plate = Image.open(bg_path).convert("RGB")
        pw, ph = plate.size
        plate_np = np.asarray(plate).astype(np.float32)

    layers = sorted(comp.get("layers", []), key=lambda L: L.get("z", 0))
    live: list[dict] = []
    try:
        for L in layers:
            if not L.get("clip"):
                continue
            clip_path = resolve(L["clip"])
            l, t, r, b = to_pixels(L["region"], pw, ph)
            rw, rh = r - l, b - t
            if rw <= 0 or rh <= 0:
                log(f"[warn] layer {L.get('id')} has an empty region — skipped")
                continue
            n = max(1, ffmpeg.probe_frame_count(clip_path))
            win = window_alpha(rw, rh, l, t, r, b, pw, ph, int(L.get("feather", 24)))
            figure = L.get("matte") == "figure"
            live.append(dict(id=L.get("id", "?"),
                             reader=ffmpeg.RawFrameReader(clip_path, rw, rh),
                             n=n, box=(l, t, r, b), win=win, figure=figure,
                             warned=False, media=L.get("media", {}),
                             opacity=float(L.get("opacity", 1.0))))

        dur = comp.get("duration")
        if not dur:
            longest = max((d["n"] for d in live), default=0) or (
                bg_frames if bg_video else fps * 3)
            dur = longest / fps
        n_out = max(1, round(dur * fps))

        want_w = int(comp.get("width") or pw)
        want_h = int(comp.get("height") or ph)
        W, H = _even(want_w), _even(want_h)
        if (W, H) != (want_w, want_h):
            log(f"[warn] output rounded to {W}x{H}: h264 cannot encode an odd "
                f"dimension (asked for {want_w}x{want_h})")
        if (W, H) != (pw, ph):
            log(f"background is {pw}x{ph}, output is {W}x{H} — every frame is "
                "scaled to cover")

        enc = ffmpeg.RawFrameEncoder(out, W, H, fps)
        for f in range(n_out):
            if bg_video:
                bi = media_index(f, bg_frames, bg_media)
                frame = bg_reader.get(bi).astype(np.float32)
            else:
                frame = plate_np.copy()
            for d in live:
                l, t, r, b = d["box"]
                vi = media_index(f, d["n"], d["media"])
                cel = d["reader"].get(vi)
                if cel.shape[:2] != (b - t, r - l):
                    raise ffmpeg.FFmpegError(
                        f"layer {d['id']} decoded {cel.shape[1]}x{cel.shape[0]} "
                        f"but its region is {r - l}x{b - t}")
                a = d["win"]
                if d["figure"]:
                    mattes = try_figure_mattes([Image.fromarray(cel)])
                    if mattes:
                        a = np.minimum(a, mattes[0])
                    elif not d["warned"]:
                        d["warned"] = True
                        log("[warn] rembg unavailable — a figure layer falls "
                            "back to its window matte")
                a = a * d["opacity"]
                reg = frame[t:b, l:r]
                frame[t:b, l:r] = reg * (1 - a[..., None]) + \
                    cel.astype(np.float32) * a[..., None]
            rgb = np.clip(frame, 0, 255).astype(np.uint8)
            # Only pay for a resize when the background is not already the
            # output size — which is the common case once a comp is stamped
            # with its background's true dimensions.
            if rgb.shape[:2] != (H, W):
                rgb = np.asarray(cover(Image.fromarray(rgb), (W, H)))
            enc.write(rgb)
        enc.close(webm_sibling=webm_sibling)
    finally:
        for d in live:
            d["reader"].close()
        if bg_reader is not None:
            bg_reader.close()

    log(f"comp rendered: {n_out} frames, {len(live)} live layer(s), "
        f"{'clip' if bg_video else 'still'} background -> {out}")
    return {"frames": n_out, "layers": len(live), "duration": dur,
            "background_kind": "video" if bg_video else "still",
            "out": str(out)}


def composite_single(plate: str | Path, clip: str | Path, region: list[float],
                     out: str | Path, feather: int = 24, matte: str = "window",
                     duration: float | None = None, fps: int = 24,
                     webm_sibling: bool = True,
                     log: Callable[[str], None] = lambda s: None) -> dict:
    """The classic single-cel composite (cel-composite.py's CPU half)."""
    if duration is None:
        duration = ffmpeg.probe_duration(clip)
    comp = {"background": str(plate), "duration": duration,
            "layers": [{"id": "cel", "clip": str(clip), "region": region,
                        "feather": feather, "matte": matte,
                        "media": {"loop": "hold"}, "opacity": 1.0, "z": 1}]}
    if ffmpeg.is_video(plate):
        comp["width"], comp["height"] = ffmpeg.probe_dims(plate)
    else:
        with Image.open(plate) as plate_img:
            comp["width"], comp["height"] = plate_img.size
    return render_comp(comp, lambda rel: Path(rel), out, fps=fps,
                       webm_sibling=webm_sibling, log=log)

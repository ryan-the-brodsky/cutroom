"""The cel system — a background plate that video models never touch, plus
z-ordered animated layers merged through feathered windows or figure mattes.

Generalized from game7's comp_render.py / anime-fx.py cel_composite. The
comp dict is the same data model the dashboard used:

comp = {
  "background": "renders/stills/B04-S3_s870934406.png",   # resolver-relative
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
    with tempfile.TemporaryDirectory(prefix="cutroom_cel_") as d:
        return [Image.open(p).convert("RGB").copy()
                for p in ffmpeg.extract_all_frames(path, d)]


def try_figure_mattes(frames: list[Image.Image]) -> list[np.ndarray] | None:
    """rembg isnet-anime figure mattes; returns None when rembg is absent
    (the layer degrades to its feathered window)."""
    try:
        from rembg import new_session, remove  # type: ignore
    except Exception:
        return None
    session = new_session("isnet-anime")
    out = []
    for f in frames:
        rgba = remove(f, session=session)
        out.append(np.asarray(rgba.split()[-1], np.float32) / 255.0)
    return out


def render_comp(comp: dict, resolve: Resolver, out: str | Path, fps: int = 24,
                webm_sibling: bool = True,
                log: Callable[[str], None] = lambda s: None) -> dict:
    """Deterministically re-render a composition from its data model."""
    plate = Image.open(resolve(comp["background"])).convert("RGB")
    pw, ph = plate.size

    layers = sorted(comp.get("layers", []), key=lambda L: L.get("z", 0))
    decoded = []
    for L in layers:
        if not L.get("clip"):
            continue
        frames = decode_video_frames(resolve(L["clip"]))
        l, t, r, b = to_pixels(L["region"], pw, ph)
        rw, rh = r - l, b - t
        frames = [f if f.size == (rw, rh) else f.resize((rw, rh), Image.LANCZOS)
                  for f in frames]
        win = window_alpha(rw, rh, l, t, r, b, pw, ph, int(L.get("feather", 24)))
        figs = None
        if L.get("matte") == "figure":
            figs = try_figure_mattes(frames)
            if figs is None:
                log(f"[warn] rembg unavailable — layer {L.get('id')} falls back "
                    "to window matte")
        decoded.append(dict(frames=frames, box=(l, t, r, b), win=win, figs=figs,
                            media=L.get("media", {}),
                            opacity=float(L.get("opacity", 1.0))))

    dur = comp.get("duration")
    if not dur:
        longest = max((len(d["frames"]) for d in decoded), default=fps * 3)
        dur = longest / fps
    n_out = max(1, round(dur * fps))

    W = int(comp.get("width", 1920))
    H = int(comp.get("height", 1080))
    plate_np = np.asarray(plate).astype(np.float32)

    enc = ffmpeg.RawFrameEncoder(out, W, H, fps)
    for f in range(n_out):
        frame = plate_np.copy()
        for d in decoded:
            l, t, r, b = d["box"]
            vi = media_index(f, len(d["frames"]), d["media"])
            vf = np.asarray(d["frames"][vi]).astype(np.float32)
            a = d["win"]
            if d["figs"] is not None:
                a = np.minimum(a, d["figs"][vi])
            a = a * d["opacity"]
            reg = frame[t:b, l:r]
            frame[t:b, l:r] = reg * (1 - a[..., None]) + vf * a[..., None]
        img = cover(Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8)),
                    (W, H))
        enc.write(np.asarray(img))
    enc.close(webm_sibling=webm_sibling)
    log(f"comp rendered: {n_out} frames, {len(decoded)} live layer(s) -> {out}")
    return {"frames": n_out, "layers": len(decoded), "duration": dur,
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
    plate_img = Image.open(plate)
    comp["width"], comp["height"] = plate_img.size
    return render_comp(comp, lambda rel: Path(rel), out, fps=fps,
                       webm_sibling=webm_sibling, log=log)

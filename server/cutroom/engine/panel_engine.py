#!/usr/bin/env python3
"""panel_engine.py — standalone Ping Pong / manga-screen panel composition engine.

A self-contained, project-independent extraction of the `panel_screen` engine
from the limited-animation FX toolkit Cutroom grew out of. Composes
limited-animation "panel group shots": polygonal manga panels (trapezoids,
wedges, slivers) that enter over a base in a designed rhythm, hold, and
de-layer — with z-order, drop shadows, video-in-panel, border-break figures,
a directional speed-line field between panels, and a slow composed-screen push.

CPU only: numpy + Pillow for pixels, ffmpeg for encode/decode. Optional rembg
for border-break figure matting (degrades gracefully if absent).

Output: 1920x1080 h264 mp4 (yuv420p) at 24fps + a .cues.json sidecar listing
every panel entry time (the audio contract: one SFX tick per cue).

Drive it with a spec JSON:

    python3 panel_engine.py my_shot.json --out clip.mp4 [--assets DIR] [--webm]

Spec (fx-script form, same as the film's):
    {"shot": "name", "duration": 4.0, "fps": 24,
     "layers": [{"fx": "panel_screen", "panels": [...], "speedlines": {...},
                 "drift": {...}},
                {"fx": "impact_frame", "at": 3.6, "kind": "white",
                 "frames_len": 3}]}
A bare panel_screen spec ({"panels": [...], "duration": ...}) also works.

panel spec (each dict in panels[]):
  id            cue id (emitted on entry)
  source        image path OR a video path (.webm/.mp4/.mov)
  crop_box      [l,t,r,b] source px or normalised 0..1
  poly          [[x,y] x4+] final window polygon on the 1920x1080 canvas  (or:)
  rect + angle  [x,y,w,h] + degrees -> rotated-rect polygon convenience
  z             stacking order (default: list index)
  border        px stroke (default 6; 0 = borderless / full-bleed)
  border_color  RGB (default off-white ink)
  shadow        0..1 shadow opacity (default 0.55; 0 = off)
  entry         {frame, dur, style: slide|pop|cut, from: left|right|top|bottom|
                 tl|tr|bl|br or from_vec:[dx,dy] (fractions of panel size),
                 dist, rot (deg overshoot rotation), ease (default out_back)}
  exit_frame    panel vanishes at this frame (hard cut — stage your exits so
                 every surviving layout reads as a designed page)
  pan           {start_box, end_box, ease} inner slow drift within the window
  media         {speed: media-frames per output frame, loop: hold|loop|pingpong,
                 start: first media frame}   (video sources)
  sharpen       true -> unsharp-mask the window content (small-crop blow-ups)
  stylize       posterize|mono|invert -> graphic tone-bands for extreme macros
  break_fg      {model, scale, offset:[dx,dy], overflow: px} rembg-matted figure
                 composited ABOVE the border so it overflows the panel window
                 (requires rembg — in-process import, or a python with rembg
                 installed pointed to by $PANEL_FX_PYTHON)

panel_screen extras:
  base          'black' | 'white' | 'still' (with base_image, dimmed base_dim)
  speedlines    {angle, color, density, speed, ramp: [[t_sec, intensity], ...]}
  drift         {push: 0.022, ease: 'in_out'}  — NEVER a shake; a slow zoom.

Asset resolution: absolute paths, paths relative to cwd, then relative to any
--assets dir(s), then $PANEL_ASSETS.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------
W, H = 1920, 1080
FPS = 24
OFFWHITE = (238, 235, 226)   # comic-panel stroke colour
INK = (18, 18, 22)

# extra dirs (CLI --assets / $PANEL_ASSETS) searched for image/video refs
ASSET_DIRS = []
if os.environ.get("PANEL_ASSETS"):
    ASSET_DIRS.append(os.environ["PANEL_ASSETS"])


# ----------------------------------------------------------------------------
# Asset resolution + image helpers
# ----------------------------------------------------------------------------

def _resolve(ref):
    """Resolve an image/video reference: as-given, then against ASSET_DIRS."""
    if os.path.isfile(ref):
        return os.path.abspath(ref)
    for d in ASSET_DIRS:
        cand = os.path.join(d, ref)
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    raise FileNotFoundError(f"asset not found: {ref} (searched cwd + {ASSET_DIRS})")


def load_image(ref, size=None):
    """Load a still as RGB PIL image, optionally cover-scaled to `size`."""
    img = Image.open(_resolve(ref)).convert("RGB")
    if size:
        img = cover(img, size)
    return img


def cover(img, size):
    """Scale-to-cover then center-crop to exactly `size` (like CSS cover)."""
    tw, th = size
    iw, ih = img.size
    scale = max(tw / iw, th / ih)
    nw, nh = round(iw * scale), round(ih * scale)
    img = img.resize((nw, nh), Image.LANCZOS)
    left = (nw - tw) // 2
    top = (nh - th) // 2
    return img.crop((left, top, left + tw, top + th))


def to_canvas(img):
    """Cover-scale any still onto the 1920x1080 delivery canvas."""
    return cover(img, (W, H))


# ----------------------------------------------------------------------------
# Easing
# ----------------------------------------------------------------------------

def ease_out_cubic(t):
    return 1 - (1 - t) ** 3


def ease_out_back(t, s=1.70158):
    """Overshoot ease — the little 'pop' past the target then settle."""
    t = t - 1
    return t * t * ((s + 1) * t + s) + 1


def ease_in_out(t):
    return 0.5 - 0.5 * math.cos(math.pi * t)


def linear_then_snap(t, snap=0.72):
    """Slow linear drift, then a fast snap into the final hold (anime timing)."""
    if t < snap:
        return (t / snap) * 0.55
    u = (t - snap) / (1 - snap)
    return 0.55 + 0.45 * ease_out_cubic(u)


EASES = {
    "out_cubic": ease_out_cubic,
    "out_back": ease_out_back,
    "in_out": ease_in_out,
    "linear": lambda t: t,
    "snap": linear_then_snap,
}


# ----------------------------------------------------------------------------
# ClipCtx — a frame accumulator that knows the timeline
# ----------------------------------------------------------------------------

class ClipCtx:
    """Holds render config and the growing list of RGB frames.

    Each fx function either (a) generates a fresh list of frames for its span,
    or (b) mutates ctx.frames in place. The script runner composites layers in
    order onto one shared frame stack."""

    def __init__(self, duration, fps=FPS, name="clip"):
        self.fps = fps
        self.duration = duration
        self.nframes = max(1, round(duration * fps))
        self.name = name
        self.frames = None          # list[np.uint8 HxWx3] once initialised
        self.cues = []              # audio cue list: {"id":..., "t":...}

    def blank(self, color=(0, 0, 0)):
        self.frames = [np.full((H, W, 3), color, np.uint8)
                       for _ in range(self.nframes)]
        return self

    def ensure(self):
        if self.frames is None:
            self.blank()
        return self

    def add_cue(self, cue_id, t):
        self.cues.append({"id": cue_id, "t": round(t, 3)})


# ----------------------------------------------------------------------------
# Geometry / decode / matte helpers
# ----------------------------------------------------------------------------

_SS = 2  # sprite supersample factor for anti-aliased diagonal borders


def _rot_rect_poly(rect, angle_deg=0.0):
    """[x,y,w,h] + angle -> 4-corner polygon rotated about the rect centre."""
    x, y, w, h = rect
    cx, cy = x + w / 2.0, y + h / 2.0
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    pts = []
    for px, py in ((x, y), (x + w, y), (x + w, y + h), (x, y + h)):
        dx, dy = px - cx, py - cy
        pts.append([cx + dx * ca - dy * sa, cy + dx * sa + dy * ca])
    return pts


def _poly_bounds(poly):
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def _decode_video(path, crop_box=None):
    """Decode a video to a list of RGB PIL frames via ffmpeg rawvideo pipe."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True)
    vw, vh = [int(v) for v in probe.stdout.strip().split(",")[:2]]
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo",
         "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True)
    raw = np.frombuffer(p.stdout, np.uint8)
    nf = len(raw) // (vw * vh * 3)
    frames = raw[:nf * vw * vh * 3].reshape(nf, vh, vw, 3)
    out = []
    for fr in frames:
        img = Image.fromarray(fr)
        if crop_box:
            b = list(crop_box)
            if max(b) <= 1.0:
                b = [b[0] * vw, b[1] * vh, b[2] * vw, b[3] * vh]
            img = img.crop(tuple(int(round(v)) for v in b))
        out.append(img)
    return out


def _rembg_alpha(still_path, model="isnet-anime"):
    """Full-resolution rembg alpha for a still. None on any failure.

    Tries: (1) in-process rembg import; (2) a python interpreter with rembg
    installed, pointed to by $PANEL_FX_PYTHON. Degrades to None (the panel
    simply renders without its border-break figure)."""
    try:
        from rembg import remove, new_session  # noqa
        s = new_session(model)
        im = Image.open(still_path).convert("RGBA")
        r = remove(im, session=s)
        return Image.fromarray(np.array(r)[..., 3]).convert("L")
    except Exception:
        pass
    fxpy = os.environ.get("PANEL_FX_PYTHON")
    if not fxpy or not os.path.isfile(fxpy):
        return None
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
    code = (
        "import sys;from rembg import remove,new_session;from PIL import Image;"
        "import numpy as np;"
        f"s=new_session('{model}');"
        f"im=Image.open(r'{still_path}').convert('RGBA');"
        "r=remove(im,session=s);"
        f"Image.fromarray(np.array(r)[...,3]).save(r'{tmp}')"
    )
    try:
        subprocess.run([fxpy, "-c", code], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return Image.open(tmp).convert("L")
    except Exception:
        return None


def _dir_lines_field(f, angle_deg=-12.0, color=OFFWHITE, density=9.0,
                     speed=1.6, intensity=1.0, seed=11):
    """Directional speed-line field (nagasen) at an arbitrary angle.

    Returns float alpha HxW 0..1 — thin streaks scrolling along their own axis.
    `intensity` scales BOTH how many line-rows are live and their opacity, so a
    ramp reads as the field waking up, thickening, then (post-impact) dying."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    a = math.radians(angle_deg)
    u = xx * math.cos(a) + yy * math.sin(a)           # along-stroke axis
    v = -xx * math.sin(a) + yy * math.cos(a)          # across strokes
    band = max(4.0, H / (density * 14.0))
    row = np.floor(v / band)
    h1 = np.sin(row * 12.9898 + seed) * 43758.5453
    h1 = h1 - np.floor(h1)                            # 0..1 per-row hash
    h2 = np.sin(row * 78.233 + seed * 3) * 12543.21
    h2 = h2 - np.floor(h2)
    live = (h1 < np.clip(0.12 + 0.55 * intensity, 0, 0.9)).astype(np.float32)
    scroll = f * speed * 55.0
    dash = np.sin((u + h2 * W * 2.0 + scroll) * 0.012)
    streak = np.clip((dash - 0.2) / 0.8, 0, 1) ** 3   # long tapered dashes
    a_field = live * streak * np.clip(intensity * 1.15, 0, 1) * 0.85
    return a_field


def _ramp_value(ramp, t):
    """Piecewise-linear [[t, value], ...] evaluated at time t (seconds)."""
    if not ramp:
        return 0.0
    pts = sorted(ramp)
    if t <= pts[0][0]:
        return pts[0][1]
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if t <= t1:
            return v0 + (v1 - v0) * (t - t0) / max(1e-6, t1 - t0)
    return pts[-1][1]


_ENTRY_VECS = {"left": (-1.3, 0), "right": (1.3, 0), "top": (0, -1.3),
               "bottom": (0, 1.3), "tl": (-1.0, -1.0), "tr": (1.0, -1.0),
               "bl": (-1.0, 1.0), "br": (1.0, 1.0)}


def _safe_composite(canvas, spr, px, py):
    """alpha_composite that tolerates sprites hanging off any canvas edge."""
    cw, ch = canvas.size
    sx, sy = max(0, -px), max(0, -py)
    dx, dy = max(0, px), max(0, py)
    w = min(spr.size[0] - sx, cw - dx)
    h = min(spr.size[1] - sy, ch - dy)
    if w <= 0 or h <= 0:
        return
    canvas.alpha_composite(spr.crop((sx, sy, sx + w, sy + h)), (dx, dy))


# ----------------------------------------------------------------------------
# _PanelSprite — one panel, pre-rendered
# ----------------------------------------------------------------------------

class _PanelSprite:
    """Pre-renders one panel (content, border, shadow, break-figure) as RGBA
    sprites at supersample, then serves per-frame transformed 1x sprites."""

    def __init__(self, spec, i, fps, nframes):
        self.spec = spec
        self.id = spec.get("id", f"panel{i+1}")
        self.z = spec.get("z", i)
        self.fps = fps
        self.nframes = nframes
        e = spec.get("entry", {})
        self.entry = int(e.get("frame", 0))
        self.entry_dur = int(e.get("dur", 5))
        self.style = e.get("style", "slide")
        self.ease = EASES.get(e.get("ease", "out_back"), ease_out_back)
        self.rot0 = float(e.get("rot", 0.0))
        self.dist = float(e.get("dist", 1.0))
        self.exit = int(spec.get("exit_frame", nframes + 1))
        # window polygon
        if "poly" in spec:
            self.poly = [list(p) for p in spec["poly"]]
        else:
            self.poly = _rot_rect_poly(spec["rect"], spec.get("angle", 0.0))
        vec = e.get("from_vec")
        if vec is None:
            vec = _ENTRY_VECS.get(e.get("from", "left"), (-1.3, 0))
        l, t, r, b = _poly_bounds(self.poly)
        self.off_vec = (vec[0] * (r - l) * self.dist, vec[1] * (b - t) * self.dist)
        self.border = int(spec.get("border", 6))
        self.border_color = tuple(spec.get("border_color", OFFWHITE))
        self.shadow = float(spec.get("shadow", 0.55))
        self.pan = spec.get("pan")
        self.media = spec.get("media", {})
        self.break_fg = spec.get("break_fg")
        self._settled = None       # cached 1x RGBA for static settled panels
        self._media_cache = {}     # media frame idx -> 1x RGBA
        self._build_static()

    # ---- content sourcing ------------------------------------------------
    def _build_static(self):
        spec = self.spec
        src = spec["source"]
        self.is_video = isinstance(src, str) and src.lower().endswith((".webm", ".mp4", ".mov"))
        ov = int(self.break_fg.get("overflow", 90)) if self.break_fg else 0
        sh_m = int(14 + self.border) if self.shadow > 0 else self.border + 2
        self.margin = max(ov, sh_m) + 4
        l, t, r, b = _poly_bounds(self.poly)
        self.bx, self.by = int(math.floor(l)) - self.margin, int(math.floor(t)) - self.margin
        self.bw = int(math.ceil(r - l)) + 2 * self.margin
        self.bh = int(math.ceil(b - t)) + 2 * self.margin
        # window size (content covers the polygon bounds, level, un-warped)
        self.ww, self.wh = int(math.ceil(r - l)), int(math.ceil(b - t))
        if self.is_video:
            self.vframes = _decode_video(_resolve(src), spec.get("crop_box"))
        else:
            img = load_image(src)
            box = spec.get("crop_box", [0, 0, 1, 1])
            iw, ih = img.size
            bb = list(box)
            if max(bb) <= 1.0:
                bb = [bb[0] * iw, bb[1] * ih, bb[2] * iw, bb[3] * ih]
            self.src_img = img
            self.crop_px = [int(round(v)) for v in bb]
        # supersampled window mask + border, shared by every content frame
        S = _SS
        self.local_poly = [((p[0] - self.bx) * S, (p[1] - self.by) * S) for p in self.poly]
        self.mask_ss = Image.new("L", (self.bw * S, self.bh * S), 0)
        ImageDraw.Draw(self.mask_ss).polygon(self.local_poly, fill=255)
        # shadow (baked, blurred, offset)
        self.shadow_im = None
        if self.shadow > 0:
            sh = Image.new("RGBA", (self.bw * S, self.bh * S), (0, 0, 0, 0))
            ImageDraw.Draw(sh).polygon(
                [(x + 9 * S, y + 12 * S) for x, y in self.local_poly],
                fill=(0, 0, 0, int(255 * self.shadow)))
            self.shadow_im = sh.filter(ImageFilter.GaussianBlur(7 * S))
        # break figure alpha (full-source-res), computed once
        self.fg_alpha = None
        if self.break_fg and not self.is_video:
            a = _rembg_alpha(_resolve(spec["source"]),
                             self.break_fg.get("model", "isnet-anime"))
            if a is not None and a.size != self.src_img.size:
                a = a.resize(self.src_img.size, Image.LANCZOS)
            self.fg_alpha = a

    def _media_index(self, f):
        m = self.media
        speed = float(m.get("speed", 1.0))
        start = int(m.get("start", 0))
        mi = start + int((f - self.entry) * speed)
        n = len(self.vframes)
        mode = m.get("loop", "hold")
        if mode == "loop":
            mi %= n
        elif mode == "pingpong":
            cyc = mi % (2 * n - 2) if n > 1 else 0
            mi = cyc if cyc < n else 2 * n - 2 - cyc
        else:
            mi = min(mi, n - 1)
        return mi

    def _content_window(self, f):
        """The level content image covering the window bbox for frame f,
        rendered at supersample, PLUS (optionally) the aligned break-figure."""
        S = _SS
        if self.is_video:
            mi = self._media_index(f)
            content = cover(self.vframes[mi], (self.ww * S, self.wh * S))
            return content, None, mi
        # ---- still ----
        box = list(self.crop_px)
        if self.pan:
            sub = self.pan
            ef = EASES.get(sub.get("ease", "in_out"), ease_in_out)
            tt = ef(min(1.0, f / max(1, self.nframes - 1)))
            sb, eb = sub["start_box"], sub["end_box"]
            iw, ih = self.src_img.size
            def npx(bx):
                return [bx[0] * iw, bx[1] * ih, bx[2] * iw, bx[3] * ih] if max(bx) <= 1.0 else list(bx)
            sbp, ebp = npx(sb), npx(eb)
            box = [sbp[i] + (ebp[i] - sbp[i]) * tt for i in range(4)]
            box = [int(round(v)) for v in box]
        # expand the crop by the overflow margin so the break-figure has pixels
        # beyond the window; content stays aligned because we render the
        # expanded crop onto the expanded bbox at the same scale.
        cw, chh = box[2] - box[0], box[3] - box[1]
        scale = max(self.ww / max(1, cw), self.wh / max(1, chh))
        mexp = self.margin / scale
        ebox = [box[0] - mexp, box[1] - mexp, box[2] + mexp, box[3] + mexp]
        iw, ih = self.src_img.size
        S = _SS
        # render expanded crop (padded where it leaves the source)
        exw = int(round((ebox[2] - ebox[0]) * scale)) * S
        exh = int(round((ebox[3] - ebox[1]) * scale)) * S
        pad = Image.new("RGB", (exw, exh), (10, 10, 12))
        cl = [max(0, int(ebox[0])), max(0, int(ebox[1])),
              min(iw, int(ebox[2])), min(ih, int(ebox[3]))]
        if cl[2] > cl[0] and cl[3] > cl[1]:
            piece = self.src_img.crop(tuple(cl))
            pw = int(round((cl[2] - cl[0]) * scale)) * S
            ph = int(round((cl[3] - cl[1]) * scale)) * S
            piece = piece.resize((max(1, pw), max(1, ph)), Image.LANCZOS)
            ox = int(round((cl[0] - ebox[0]) * scale)) * S
            oy = int(round((cl[1] - ebox[1]) * scale)) * S
            pad.paste(piece, (ox, oy))
        if self.spec.get("sharpen"):
            pad = pad.filter(ImageFilter.UnsharpMask(radius=3, percent=160, threshold=2))
        sty = self.spec.get("stylize")
        if sty == "posterize":
            # heavy blow-up macros go GRAPHIC: hard tone bands read as drawn,
            # not blurred (the Ping Pong macro trick)
            pad = ImageOps.posterize(ImageOps.autocontrast(pad, cutoff=1), 3)
        elif sty == "mono":
            g = ImageOps.autocontrast(pad.convert("L"), cutoff=1)
            pad = ImageOps.posterize(g, 2).convert("RGB")
        elif sty == "invert":
            pad = ImageOps.invert(pad)
        fg = None
        if self.fg_alpha is not None:
            am = Image.new("L", (exw, exh), 0)
            if cl[2] > cl[0] and cl[3] > cl[1]:
                ap = self.fg_alpha.crop(tuple(cl)).resize(
                    (max(1, pw), max(1, ph)), Image.LANCZOS)
                am.paste(ap, (ox, oy))
            fg = (pad, am)
        return pad, fg, None

    def _bake(self, f):
        """Full RGBA sprite (shadow + windowed content + border + break-figure)
        at supersample, then downscaled to 1x for AA edges."""
        S = _SS
        content, fg, mkey = self._content_window(f)
        canvas = Image.new("RGBA", (self.bw * S, self.bh * S), (0, 0, 0, 0))
        if self.shadow_im is not None:
            canvas = Image.alpha_composite(canvas, self.shadow_im)
        # windowed content: content covers window bbox; window bbox sits at
        # margin offset inside the sprite bbox.
        layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        if self.is_video:
            cw = Image.new("RGB", canvas.size, (0, 0, 0))
            cw.paste(content, (self.margin * S, self.margin * S))
        else:
            # expanded content already includes the margin band
            cw = content.resize(canvas.size, Image.LANCZOS) \
                if content.size != canvas.size else content
        layer.paste(cw, (0, 0))
        layer.putalpha(self.mask_ss)
        canvas = Image.alpha_composite(canvas, layer)
        if self.border > 0:
            d = ImageDraw.Draw(canvas)
            d.line(self.local_poly + [self.local_poly[0]],
                   fill=self.border_color + (255,), width=self.border * S,
                   joint="curve")
        if fg is not None:
            bfg = self.break_fg or {}
            fim, fal = fg
            if fim.size != canvas.size:
                fim = fim.resize(canvas.size, Image.LANCZOS)
                fal = fal.resize(canvas.size, Image.LANCZOS)
            fsc = float(bfg.get("scale", 1.0))
            offx, offy = [int(v) for v in bfg.get("offset", [0, 0])]
            if abs(fsc - 1.0) > 1e-3:
                nw = int(fim.size[0] * fsc); nh = int(fim.size[1] * fsc)
                fim = fim.resize((nw, nh), Image.LANCZOS)
                fal = fal.resize((nw, nh), Image.LANCZOS)
            fl = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
            px = (canvas.size[0] - fim.size[0]) // 2 + offx * S
            py = (canvas.size[1] - fim.size[1]) // 2 + offy * S
            frgba = fim.convert("RGBA"); frgba.putalpha(fal)
            fl.alpha_composite(frgba, (px, py))
            canvas = Image.alpha_composite(canvas, fl)
        out = canvas.resize((self.bw, self.bh), Image.LANCZOS)
        return out, mkey

    def sprite_at(self, f):
        """(RGBA 1x sprite, paste_x, paste_y) for global frame f, or None."""
        if f < self.entry or f >= self.exit:
            return None
        # settled + static content -> cached
        t = min(1.0, (f - self.entry) / max(1, self.entry_dur))
        settled = t >= 1.0 and self.style != "cut" or self.style == "cut"
        animated_content = self.is_video or self.pan
        if settled and not animated_content:
            if self._settled is None:
                self._settled = self._bake(f)[0]
            return self._settled, self.bx, self.by
        if settled and self.is_video:
            mi = self._media_index(f)
            spr = self._media_cache.get(mi)
            if spr is None:
                spr = self._bake(f)[0]
                self._media_cache[mi] = spr
            return spr, self.bx, self.by
        # entering: transform
        base, _ = self._bake(f)
        e = self.ease(t)
        dx = self.off_vec[0] * (1 - e)
        dy = self.off_vec[1] * (1 - e)
        spr = base
        if self.style == "pop":
            s = 0.68 + 0.32 * e
            ns = (max(1, int(spr.size[0] * s)), max(1, int(spr.size[1] * s)))
            spr2 = spr.resize(ns, Image.LANCZOS)
            px = self.bx + (spr.size[0] - ns[0]) // 2
            py = self.by + (spr.size[1] - ns[1]) // 2
            return spr2, px, py
        ang = self.rot0 * (1 - e)
        if abs(ang) > 0.05:
            spr = spr.rotate(ang, resample=Image.BICUBIC, expand=True)
            dx -= (spr.size[0] - base.size[0]) / 2
            dy -= (spr.size[1] - base.size[1]) / 2
        return spr, int(self.bx + dx), int(self.by + dy)


# ----------------------------------------------------------------------------
# panel_screen — the composition engine
# ----------------------------------------------------------------------------

def panel_screen(ctx, panels, base="black", base_image=None, base_dim=0.3,
                 speedlines=None, drift=None, **_):
    """Compose a full Ping Pong-grammar screen: polygonal panels with z-order,
    shadows, video-in-panel, border-breaks, overshoot entries, an intensity-
    ramped speed-line field between panels, and a slow composed-screen push.

    speedlines: {angle, color, density, speed, ramp: [[t_sec, intensity], ...]}
    drift:      {push: 0.025, ease: 'in_out'}  — NEVER a shake; a slow zoom.
    """
    ctx.ensure()
    n = ctx.nframes
    # base plate
    if base == "white":
        bg0 = np.full((H, W, 3), 255, np.uint8)
    elif base == "still" and base_image:
        s = np.asarray(to_canvas(load_image(base_image))).astype(np.float32)
        bg0 = (s * base_dim).astype(np.uint8)
    else:
        bg0 = np.zeros((H, W, 3), np.uint8)

    sprites = sorted((_PanelSprite(p, i, ctx.fps, n) for i, p in enumerate(panels)),
                     key=lambda s: s.z)
    for sp in sprites:
        ctx.add_cue(sp.id, sp.entry / ctx.fps)

    sl = speedlines or {}
    sl_col = np.array(sl.get("color", OFFWHITE), np.float32)

    dr = drift or {}
    push = float(dr.get("push", 0.0))
    dease = EASES.get(dr.get("ease", "in_out"), ease_in_out)

    frames = []
    for f in range(n):
        bg = bg0.astype(np.float32)
        if speedlines:
            inten = _ramp_value(sl.get("ramp", [[0, 1.0]]), f / ctx.fps)
            if inten > 0.003:
                a = _dir_lines_field(f, angle_deg=sl.get("angle", -12.0),
                                     density=sl.get("density", 9.0),
                                     speed=sl.get("speed", 1.6),
                                     intensity=inten)[..., None]
                bg = bg * (1 - a) + sl_col * a
        canvas = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8)).convert("RGBA")
        for sp in sprites:
            got = sp.sprite_at(f)
            if got is None:
                continue
            spr, px, py = got
            _safe_composite(canvas, spr, int(px), int(py))
        frame = canvas.convert("RGB")
        if push > 0:
            s = 1.0 + push * dease(f / max(1, n - 1))
            nw, nh = int(W * s), int(H * s)
            zi = frame.resize((nw, nh), Image.BILINEAR)
            frame = zi.crop(((nw - W) // 2, (nh - H) // 2,
                             (nw - W) // 2 + W, (nh - H) // 2 + H))
        frames.append(np.asarray(frame))
    ctx.frames = frames
    return ctx


def speedline_field(ctx, angle=-12.0, color=None, density=9.0, speed=1.6,
                    ramp=None, base_color=(0, 0, 0), **_):
    """Standalone directional speed-line field clip (usable as a layer/base)."""
    ctx.ensure()
    col = np.array(color or OFFWHITE, np.float32)
    bc = np.array(base_color, np.float32)
    frames = []
    for f in range(ctx.nframes):
        inten = _ramp_value(ramp or [[0, 1.0]], f / ctx.fps)
        a = _dir_lines_field(f, angle_deg=angle, density=density,
                             speed=speed, intensity=inten)[..., None]
        out = bc * (1 - a) + col * a
        frames.append(np.clip(out, 0, 255).astype(np.uint8))
    ctx.frames = frames
    return ctx


# ----------------------------------------------------------------------------
# impact_frame — the contact flash (mutates existing frames)
# ----------------------------------------------------------------------------

def impact_frame(ctx, at=None, at_frame=None, frames_len=3, kind="white",
                 image=None, posterize_bits=2, **_):
    """Insert a 2-4 frame full-screen flash at a moment.

    kind: 'white' | 'black' | 'invert' | 'posterize'
    'invert'/'posterize' derive from `image` (or the current frame if present)."""
    if ctx.frames is None:
        if image:
            base = np.asarray(to_canvas(load_image(image)))
            ctx.frames = [base.copy() for _ in range(ctx.nframes)]
        else:
            ctx.blank()
    n = ctx.nframes
    if at_frame is not None:
        start = int(at_frame)
    else:
        start = int(round((at if at is not None else 0) * ctx.fps))
    for k in range(frames_len):
        idx = start + k
        if 0 <= idx < n:
            src = np.asarray(to_canvas(load_image(image))) if image else ctx.frames[idx]
            ctx.frames[idx] = _make_flash(src, kind, posterize_bits)
    ctx.add_cue("impact", start / ctx.fps)
    return ctx


def _make_flash(src, kind, bits):
    if kind == "white":
        return np.full((H, W, 3), 255, np.uint8)
    if kind == "black":
        return np.zeros((H, W, 3), np.uint8)
    if kind == "invert":
        return (255 - src).astype(np.uint8)
    if kind == "posterize":
        levels = 2 ** bits
        q = (src.astype(np.float32) / 255 * (levels - 1)).round() / (levels - 1)
        return np.clip(q * 255, 0, 255).astype(np.uint8)
    return src


# ----------------------------------------------------------------------------
# Encoding
# ----------------------------------------------------------------------------

def encode(ctx, out_path, webm=False, cues_path=None):
    """Write ctx.frames to mp4 (h264 yuv420p) via ffmpeg rawvideo pipe.
    Optionally also a vp9 webm sibling, and a cue-list JSON."""
    ctx.ensure()
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    _pipe_encode(ctx.frames, out_path, ctx.fps, webm=False)
    if webm:
        wp = os.path.splitext(out_path)[0] + ".webm"
        _pipe_encode(ctx.frames, wp, ctx.fps, webm=True)
    if cues_path is None:
        cues_path = os.path.splitext(out_path)[0] + ".cues.json"
    if ctx.cues:
        with open(cues_path, "w") as fh:
            json.dump({"name": ctx.name, "fps": ctx.fps,
                       "duration": ctx.duration, "cues": ctx.cues}, fh, indent=2)
    return out_path


def _pipe_encode(frames, out_path, fps, webm=False):
    if webm:
        vargs = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "24",
                 "-pix_fmt", "yuv420p", "-row-mt", "1"]
    else:
        vargs = ["-c:v", "libx264", "-preset", "medium", "-crf", "17",
                 "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(fps), "-i", "-", *vargs, out_path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for fr in frames:
        p.stdin.write(np.ascontiguousarray(fr, np.uint8).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError(f"ffmpeg failed for {out_path}")


# ----------------------------------------------------------------------------
# Script runner + CLI
# ----------------------------------------------------------------------------

FX = {
    "panel_screen": panel_screen,
    "speedline_field": speedline_field,
    "impact_frame": impact_frame,
}


def run_script(spec, out_path, webm=False):
    """Execute an fx-script: a base generator layer then overlay layers.

    spec = {"shot","duration","fps"?,"layers":[{fx,...}, ...]}. A bare
    panel_screen spec ({"panels": [...]}) is auto-wrapped."""
    if "layers" not in spec:
        spec = {"shot": spec.get("shot", spec.get("name", "panel-shot")),
                "duration": spec.get("duration", 3.0),
                "fps": spec.get("fps", FPS),
                "layers": [dict(spec, fx="panel_screen")]}
    dur = spec["duration"]
    fps = spec.get("fps", FPS)
    name = spec.get("shot", spec.get("name", "clip"))
    ctx = ClipCtx(dur, fps, name=name)
    for layer in spec["layers"]:
        fx = layer["fx"]
        fn = FX[fx]
        kwargs = {k: v for k, v in layer.items() if k not in ("fx", "z")}
        fn(ctx, **kwargs)
    encode(ctx, out_path, webm=webm)
    return out_path


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Standalone manga-panel composition engine (1080p/24fps).")
    ap.add_argument("spec", help="spec JSON (fx-script or bare panel_screen)")
    ap.add_argument("--out", required=True, help="output .mp4 path")
    ap.add_argument("--assets", action="append", default=[],
                    help="extra dir(s) to resolve image/video refs against")
    ap.add_argument("--webm", action="store_true", help="also write a vp9 webm")
    args = ap.parse_args(argv)
    ASSET_DIRS[:0] = args.assets
    with open(args.spec) as fh:
        spec = json.load(fh)
    p = run_script(spec, out_path=args.out, webm=args.webm)
    print("wrote", p)


if __name__ == "__main__":
    main()

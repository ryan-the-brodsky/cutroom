"""Clean-plate synthesis — fill the hole a separated figure leaves behind.

Primary: LaMa (ONNX, CPU). The hole's square neighborhood is cropped,
resized to the model's expected resolution, inpainted, and blended back —
only pixels inside the (dilated) hole are ever replaced, so the rest of the
plate stays byte-identical. Fallback when the model is missing: nearest-
background fill + blur, which reads as soft bokeh behind a re-composited
figure and is fine as a degraded mode.

Masks follow engine.matte's convention: float32 HxW in [0,1], 1 = hole.
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageFilter

from ..config import get_settings

LAMA_URL = ("https://huggingface.co/Carve/LaMa-ONNX/resolve/main/"
            "lama_fp32.onnx")
_LAMA = {"sess": None}
Log = Callable[[str], None]


def lama_path() -> Path:
    return get_settings().data_dir / "models" / "lama_fp32.onnx"


def ensure_lama(log: Log = lambda s: None) -> Path | None:
    """Download the model once (~200MB). Returns None on any failure —
    callers degrade to the classical fill rather than dying."""
    p = lama_path()
    if p.exists():
        return p
    try:
        import urllib.request
        p.parent.mkdir(parents=True, exist_ok=True)
        log(f"downloading LaMa ONNX -> {p}")
        tmp = p.with_suffix(".part")
        urllib.request.urlretrieve(LAMA_URL, tmp)
        tmp.rename(p)
        return p
    except Exception as e:
        log(f"[warn] LaMa download failed ({e}) — classical fill only")
        return None


def _lama_session(log: Log):
    if _LAMA["sess"] is None:
        p = ensure_lama(log)
        if p is None:
            return None
        import onnxruntime as ort
        _LAMA["sess"] = ort.InferenceSession(
            str(p), providers=["CPUExecutionProvider"])
    return _LAMA["sess"]


def _model_hw(sess) -> tuple[int, int]:
    """The export's expected input size; dynamic dims default to 512."""
    shape = sess.get_inputs()[0].shape        # [1, 3, H, W]
    h = shape[2] if isinstance(shape[2], int) else 512
    w = shape[3] if isinstance(shape[3], int) else 512
    return int(h), int(w)


def _square_around(mask: np.ndarray,
                   margin: float = 0.35) -> tuple[int, int, int, int]:
    """A square window around the hole with breathing room for context,
    clamped to the frame (shifted, not shrunk, when it fits)."""
    h, w = mask.shape
    ys, xs = np.where(mask > 0.5)
    if not len(xs):
        return 0, 0, w, h
    l, t, r, b = int(xs.min()), int(ys.min()), int(xs.max()) + 1, \
        int(ys.max()) + 1
    side = int(max(r - l, b - t) * (1 + 2 * margin))
    side = min(side, min(w, h))
    cx, cy = (l + r) // 2, (t + b) // 2
    x0 = int(np.clip(cx - side // 2, 0, w - side))
    y0 = int(np.clip(cy - side // 2, 0, h - side))
    return x0, y0, x0 + side, y0 + side


def classical_fill(img: Image.Image, mask: np.ndarray) -> Image.Image:
    """Nearest-background fill + heavy blur inside the hole. Reads as
    out-of-focus background — the honest degraded mode for a bokeh plate."""
    from scipy.ndimage import distance_transform_edt
    arr = np.asarray(img.convert("RGB"), np.float32)
    hole = mask > 0.5
    if not hole.any():
        return img.convert("RGB")
    _, idx = distance_transform_edt(hole, return_indices=True)
    filled = arr[idx[0], idx[1]]
    soft = Image.fromarray(filled.astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(18))
    a = mask[..., None]
    out = arr * (1 - a) + np.asarray(soft, np.float32) * a
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def lama_fill(img: Image.Image, mask: np.ndarray,
              log: Log = lambda s: None) -> Image.Image | None:
    """One LaMa pass over the hole's square neighborhood. None → no model."""
    sess = _lama_session(log)
    if sess is None:
        return None
    arr = np.asarray(img.convert("RGB"), np.float32)
    x0, y0, x1, y1 = _square_around(mask)
    crop = arr[y0:y1, x0:x1]
    mcrop = mask[y0:y1, x0:x1]
    mh, mw = _model_hw(sess)

    ci = Image.fromarray(crop.astype(np.uint8)).resize((mw, mh),
                                                       Image.LANCZOS)
    # binarize AFTER resize: LaMa wants a hard {0,1} hole
    mi = Image.fromarray((np.clip(mcrop, 0, 1) * 255).astype(np.uint8),
                         "L").resize((mw, mh), Image.BILINEAR)
    m = (np.asarray(mi, np.float32) / 255.0 > 0.35).astype(np.float32)

    inputs = sess.get_inputs()
    feed = {inputs[0].name:
            (np.asarray(ci, np.float32) / 255.0)
            .transpose(2, 0, 1)[None],
            inputs[1].name: m[None, None]}
    out = sess.run(None, feed)[0][0]                  # [3,H,W] or [H,W,3]
    if out.shape[0] == 3:
        out = out.transpose(1, 2, 0)
    if out.max() <= 1.5:                              # 0..1 exports exist
        out = out * 255.0
    patch = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).resize(
        (x1 - x0, y1 - y0), Image.LANCZOS)

    # paste back through the soft mask — untouched pixels stay untouched
    a = np.clip(mcrop, 0, 1)[..., None]
    blended = crop * (1 - a) + np.asarray(patch, np.float32) * a
    full = arr.copy()
    full[y0:y1, x0:x1] = blended
    return Image.fromarray(np.clip(full, 0, 255).astype(np.uint8))


def clean_plate(img: Image.Image, figure_mask: np.ndarray, dilate_px: int = 12,
                feather_px: int = 4,
                log: Log = lambda s: None) -> tuple[Image.Image, str]:
    """Figure mask → plate with the figure gone. Returns (image, method)."""
    from . import matte
    hole = matte.feather(matte.dilate(figure_mask, dilate_px), feather_px)
    out = None
    try:
        out = lama_fill(img, hole, log)
    except Exception as e:
        log(f"[warn] LaMa inpaint failed ({e}) — classical fill")
    if out is not None:
        return out, "lama"
    return classical_fill(img, hole), "classical"

"""Figure separation — prompted (SAM) and automatic (isnet-anime) mattes.

The cel pipeline's "pull this character" gesture: SAM turns director clicks
into a subject mask; isnet-anime remains the automatic per-frame matte used
at composite time (cels.try_figure_mattes). Everything here is single-image
and CPU (onnxruntime via rembg) — no torch, no GPU contention with renders.

Mask convention throughout: float32 HxW in [0, 1], 1.0 = figure.
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

_SESSIONS: dict = {}


def _session(name: str):
    """Cached rembg session; the model files land in ~/.u2net once."""
    if name not in _SESSIONS:
        from rembg import new_session
        _SESSIONS[name] = new_session(name)
    return _SESSIONS[name]


def normalize_prompts(prompts: list[dict]) -> list[dict]:
    """Accept UI-friendly point dicts and rembg's native marks alike.

    {"x":.., "y":.., "label":0|1}       → {"type":"point","data":[x,y],...}
    {"type":"point"|"rectangle", ...}   → passed through (ints coerced)
    """
    out = []
    for p in prompts or []:
        if "type" in p:
            out.append({"type": p["type"],
                        "data": [int(round(v)) for v in p["data"]],
                        "label": int(p.get("label", 1))})
        else:
            out.append({"type": "point",
                        "data": [int(round(p["x"])), int(round(p["y"]))],
                        "label": int(p.get("label", 1))})
    return out


def sam_mask(img: Image.Image, prompts: list[dict]) -> np.ndarray:
    """Subject mask from director clicks (SAM, point/rectangle prompted)."""
    from rembg import remove
    marks = normalize_prompts(prompts)
    if not marks:
        raise ValueError("sam_mask needs at least one point/rectangle prompt")
    rgba = remove(img.convert("RGB"), session=_session("sam"),
                  sam_prompt=marks)
    return np.asarray(rgba.split()[-1], np.float32) / 255.0


def anime_mask(img: Image.Image) -> np.ndarray:
    """Automatic anime-figure matte (isnet-anime) — no prompt, best subject."""
    from rembg import remove
    rgba = remove(img.convert("RGB"), session=_session("isnet-anime"))
    return np.asarray(rgba.split()[-1], np.float32) / 255.0


def refined_mask(img: Image.Image, prompts: list[dict],
                 pad: int = 24) -> np.ndarray:
    """The hybrid gesture: SAM decides WHICH figure (clicks), isnet-anime
    decides its EDGE (anime line art is its home turf; SAM's vit_b edges are
    ragged on cels). isnet-anime runs on the SAM bbox crop, and the result is
    gated by the dilated SAM mask so a second figure sharing the crop can't
    bleed in."""
    sam = sam_mask(img, prompts)
    box = bbox(sam, pad=pad)
    if box is None:
        return sam
    l, t, r, b = box
    crop_alpha = anime_mask(img.crop((l, t, r, b)))
    full = np.zeros_like(sam)
    full[t:b, l:r] = crop_alpha
    gate = dilate(sam, 24)
    refined = np.minimum(full, gate)
    # isnet found nothing in the crop (rare) → SAM alone beats nothing
    return refined if (refined > 0.5).sum() >= 0.25 * (sam > 0.5).sum() \
        else sam


# ------------------------------------------------------------- mask algebra

def _to_l(mask: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8), "L")


def dilate(mask: np.ndarray, px: int) -> np.ndarray:
    """Grow the mask — inpaint holes must swallow the figure's halo pixels
    (anime line art bleeds a few px past any segmenter's edge)."""
    if px <= 0:
        return mask
    size = 2 * int(px) + 1
    grown = _to_l(mask).filter(ImageFilter.MaxFilter(size))
    return np.asarray(grown, np.float32) / 255.0


def feather(mask: np.ndarray, px: int) -> np.ndarray:
    if px <= 0:
        return mask
    soft = _to_l(mask).filter(ImageFilter.GaussianBlur(px))
    return np.asarray(soft, np.float32) / 255.0


def bbox(mask: np.ndarray, thresh: float = 0.5,
         pad: int = 0) -> tuple[int, int, int, int] | None:
    """Tight [l, t, r, b] around mask>thresh, padded and clamped."""
    ys, xs = np.where(mask > thresh)
    if not len(xs):
        return None
    h, w = mask.shape
    return (max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad),
            min(w, int(xs.max()) + 1 + pad), min(h, int(ys.max()) + 1 + pad))


def cutout_rgba(img: Image.Image, mask: np.ndarray) -> Image.Image:
    """The figure on transparency — the layer's identity card."""
    rgba = img.convert("RGBA")
    rgba.putalpha(_to_l(mask))
    return rgba


def mask_png_bytes(mask: np.ndarray) -> bytes:
    import io
    buf = io.BytesIO()
    _to_l(mask).save(buf, "PNG")
    return buf.getvalue()

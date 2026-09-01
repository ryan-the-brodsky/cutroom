"""Still-image geometry helpers (ported from cel-composite.py / anime-fx.py)."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

Region = list[float]  # [l, t, r, b] in px, or all values <= 1.0 → normalized


def cover(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Scale to cover + center-crop (the film's standard fit)."""
    w, h = size
    s = max(w / img.size[0], h / img.size[1])
    img = img.resize((round(img.size[0] * s), round(img.size[1] * s)),
                     Image.LANCZOS)
    left = (img.size[0] - w) // 2
    top = (img.size[1] - h) // 2
    return img.crop((left, top, left + w, top + h))


def to_pixels(region: Region, pw: int, ph: int) -> list[int]:
    b = list(region)
    if max(b) <= 1.0:
        b = [b[0] * pw, b[1] * ph, b[2] * pw, b[3] * ph]
    l, t, r, bt = [int(round(v)) for v in b]
    l, t = max(0, l), max(0, t)
    r, bt = min(pw, r), min(ph, bt)
    return [l, t, r, bt]


def snap_region(region: Region, pw: int, ph: int, multiple: int = 32) -> list[int]:
    """Normalize + snap a region so W/H are divisible by `multiple` (LTX needs
    /32). Expands first (never crops requested content away); pinned edges (on
    the plate edge) stay pinned; shrinks only if the plate itself is too small."""
    l, t, r, bt = to_pixels(region, pw, ph)

    def snap_axis(lo: int, hi: int, limit: int) -> tuple[int, int]:
        need = (multiple - (hi - lo) % multiple) % multiple
        if need:
            grow_hi = min(need, limit - hi)
            hi += grow_hi
            grow_lo = min(need - grow_hi, lo)
            lo -= grow_lo
            if (hi - lo) % multiple:
                hi = lo + ((hi - lo) // multiple) * multiple
        return lo, hi

    l, r = snap_axis(l, r, pw)
    t, bt = snap_axis(t, bt, ph)
    return [l, t, r, bt]


def pinned_edges(region: list[int], pw: int, ph: int) -> list[str]:
    """Edges coincident with the plate edge — entrances cross these unfeathered."""
    l, t, r, b = region
    return [e for e, on in (("L", l == 0), ("T", t == 0),
                            ("R", r == pw), ("B", b == ph)) if on]


SUPPORTED_ASPECTS = (16 / 9, 9 / 16, 1.0)


def grow_to_aspect(region: list[int] | tuple[int, ...], pw: int, ph: int,
                   aspects: tuple[float, ...] = SUPPORTED_ASPECTS
                   ) -> list[int]:
    """Grow a region (never shrink) toward the nearest supported aspect,
    centered, clamped to the plate. Hosted i2v endpoints accept only a few
    aspect ratios; matching one here means the cel round-trips 1:1 instead
    of being squashed back into the region at composite time. If the plate
    can't contain the exact aspect the result is best-effort (the adapter
    still resolves a legal aspect_ratio param)."""
    l, t, r, b = [int(v) for v in region]
    w, h = r - l, b - t
    if w <= 0 or h <= 0:
        return [l, t, r, b]
    ratio = w / h
    target = min(aspects, key=lambda a: abs(a - ratio))
    if ratio < target:                      # too narrow → widen
        w = min(pw, int(round(h * target)))
    else:                                   # too wide → heighten
        h = min(ph, int(round(w / target)))
    cx, cy = (l + r) // 2, (t + b) // 2
    nl = max(0, min(pw - w, cx - w // 2))
    nt = max(0, min(ph - h, cy - h // 2))
    return [nl, nt, nl + w, nt + h]


def crop_region(plate: str | Path, region: Region, out: str | Path,
                snap: int | None = 32) -> tuple[Path, list[int]]:
    """Crop a (snapped) region from a plate → PNG. Returns (path, snapped px)."""
    im = Image.open(plate)
    pw, ph = im.size
    reg = snap_region(region, pw, ph, snap) if snap else to_pixels(region, pw, ph)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.convert("RGB").crop(tuple(reg)).save(out)
    return out, reg

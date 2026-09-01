from __future__ import annotations

import re
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from ..engine import ffmpeg as e_ff
from ..models import Take
from ..db import session_scope
from ..storage import StorageError
from .deps import store_for

router = APIRouter()


def _resolve(pid: str, rel: str):
    store = store_for(pid)
    try:
        p = store.resolve(rel)
    except StorageError as e:
        raise HTTPException(403, str(e))
    if not p.exists() or not p.is_file():
        raise HTTPException(404, rel)
    return store, p


@router.get("/projects/{pid}/media/{rel:path}")
def media(pid: str, rel: str):
    _, p = _resolve(pid, rel)
    return FileResponse(p)


@router.get("/projects/{pid}/thumb/{rel:path}")
def thumb(pid: str, rel: str, t: float = 0.3, w: int = 320):
    store, p = _resolve(pid, rel)
    key = re.sub(r"[^A-Za-z0-9]", "_", rel) + f"_{t}_{w}.jpg"
    out = store.resolve(f".cache/thumbs/{key}")
    if not out.exists():
        try:
            e_ff.make_thumb(p, out, t, w)
        except e_ff.FFmpegError as e:
            raise HTTPException(500, f"thumb failed: {e}")
    return FileResponse(out)


@router.get("/projects/{pid}/frames/{rel:path}")
def frames(pid: str, rel: str, times: str = "0.5,1.0,2.0,3.5"):
    """Drift-atlas frames: extract (cached) stills from a clip."""
    store, p = _resolve(pid, rel)
    out = []
    for ts in times.split(","):
        ts = float(ts)
        key = re.sub(r"[^A-Za-z0-9]", "_", rel) + f"_f{ts}.png"
        frel = f".cache/frames/{key}"
        fpath = store.resolve(frel)
        if not fpath.exists():
            try:
                e_ff.extract_frame(p, ts, fpath)
            except e_ff.FFmpegError:
                continue
        out.append({"t": ts, "rel": frel})
    return out


@router.get("/projects/{pid}/duration/{rel:path}")
def duration(pid: str, rel: str):
    _, p = _resolve(pid, rel)
    try:
        return {"seconds": e_ff.probe_duration(p)}
    except e_ff.FFmpegError:
        return {"seconds": None}


@router.get("/projects/{pid}/dims/{rel:path}")
def dims(pid: str, rel: str):
    """Pixel dimensions of an image or video (region editors need the true
    plate size — plates are 960x544/768x432, not the 1080p canvas)."""
    _, p = _resolve(pid, rel)
    try:
        if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
            from PIL import Image
            with Image.open(p) as im:
                w, h = im.size
        else:
            w, h = e_ff.probe_dims(p)
        return {"width": w, "height": h}
    except Exception as e:
        raise HTTPException(500, f"dims failed: {e}")


@router.post("/projects/{pid}/upload")
async def upload(pid: str, req: Request, filename: str = "upload.png",
                 dir: str = "uploads", shot: str | None = None,
                 kind: str = "ref", note: str = ""):
    """Raw-body upload (reference photos, guide images, audio)."""
    store = store_for(pid)
    body = await req.body()
    if len(body) < 100:
        raise HTTPException(400, "empty upload")
    if dir not in ("uploads", "renders/refs", "audio/sfx", "audio/music"):
        raise HTTPException(400, f"dir must not be {dir}")
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", filename) or \
        f"upload-{int(time.time())}"
    rel = store.unique_rel(f"{dir}/{safe}")
    store.write_bytes(rel, body)
    with session_scope() as s:
        s.add(Take(project_id=pid, shot_sid=shot, kind=kind, path=rel,
                   meta={"uploaded": True, "note": note, "bytes": len(body)}))
    return {"ok": True, "rel": rel}

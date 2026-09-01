"""Figure separation — the "pull this character off the plate" gesture.

POST /projects/{pid}/segment   sync mask preview for director clicks
POST /projects/{pid}/separate  the full job: mask → clean plate → comp
"""
from __future__ import annotations

import base64

from fastapi import APIRouter, HTTPException, Request

from ..db import session_scope
from ..jobs.queue import submit_job
from ..storage import get_storage
from .deps import store_for

router = APIRouter()


@router.post("/projects/{pid}/segment")
def segment_preview(pid: str, body: dict):
    """Synchronous SAM preview: clicks in, mask out. Nothing is stored —
    this feeds the on-plate overlay while the director refines points.
    (def, not async def: FastAPI runs it in the threadpool, so the ~2s of
    CPU inference never blocks the event loop.)"""
    from PIL import Image

    from ..engine import matte

    store = store_for(pid)
    rel = body.get("image")
    if not rel or not store.exists(rel):
        raise HTTPException(400, f"no such image: {rel}")
    prompts = body.get("prompts") or []
    img = Image.open(store.resolve(rel)).convert("RGB")
    try:
        mask = matte.refined_mask(img, prompts) if prompts \
            else matte.anime_mask(img)
    except ValueError as e:
        raise HTTPException(400, str(e))
    box = matte.bbox(mask, pad=int(body.get("pad", 16)))
    return {"mask": "data:image/png;base64," +
            base64.b64encode(matte.mask_png_bytes(mask)).decode(),
            "bbox": list(box) if box else None,
            "coverage": round(float((mask > 0.5).mean()), 4)}


@router.post("/projects/{pid}/separate")
async def separate(pid: str, req: Request):
    """Submit the separation job (cpu pool): SAM mask → LaMa clean plate →
    a staged comp whose figure layer is ready to animate."""
    body = await req.json()
    store_for(pid)
    if not body.get("plate"):
        raise HTTPException(400, "need plate")
    payload = {"project": pid,
               **{k: body[k] for k in
                  ("shot", "plate", "prompts", "mask", "name", "prompt",
                   "dilate", "feather", "pad", "duration")
                  if body.get(k) is not None}}
    title = f"separate figure: {body.get('shot') or body['plate']}"
    with session_scope() as s:
        job = submit_job(s, "gen.separate", payload, pid, "cpu", title)
        return {"job": job.id}

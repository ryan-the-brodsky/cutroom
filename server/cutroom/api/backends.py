from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select

from ..adapters import build_adapter
from ..adapters import image_models as im
from ..adapters import motion_models as mm
from ..adapters.motion_profiles import describe, profile_for
from ..adapters.registry import ADAPTER_TYPES
from ..db import session_scope
from ..models import Backend
from .deps import require_admin

router = APIRouter()

DIRECTION_TYPES = ("anthropic", "openai-chat", "claude-cli")
ALL_TYPES = tuple(ADAPTER_TYPES) + DIRECTION_TYPES


@router.get("/backends")
def list_backends(request: Request):
    from ..demo import is_admin
    from ..config import get_settings
    # Viewers on a hosted demo only see what can actually serve them: disabled
    # templates (and the local test lane) stay out of their picture entirely.
    viewer_only_enabled = get_settings().demo and not is_admin(request)
    with session_scope() as s:
        rows = s.execute(select(Backend).order_by(Backend.created_at)).scalars()
        out = []
        for b in rows:
            if viewer_only_enabled and not b.enabled:
                continue
            d = b.masked()
            cls = ADAPTER_TYPES.get(b.type)
            d["lanes"] = sorted(getattr(cls, "lanes", set())) if cls else \
                (["direction"] if b.type in DIRECTION_TYPES else [])
            if "motion" in d["lanes"]:
                # The live window is a backend property, not a global law.
                prof = profile_for(b.options or {}, b.type,
                                   (b.options or {}).get("model"))
                if b.type == "fal":
                    # A fal row can serve any registry model, so the choice
                    # travels with the profile — an agent picking a model per
                    # shot needs the price and the use cases in one place.
                    prof = dict(prof, models=[mm.public(m)
                                              for m in mm.all_models()],
                                model=(b.options or {}).get("model"))
                d["motion_profile"] = prof
                d["motion_profile_summary"] = describe(prof)
            if b.type == "openrouter-image":
                # An openrouter-image row serves any registry model, and they
                # differ in price and in whether text comes out readable, so
                # the choice travels with the backend, as it does for fal.
                d["image_models"] = [im.public(m) for m in im.all_models()]
                d["image_model"] = (b.options or {}).get(
                    "model") or im.resolve_id(im.DEFAULT_MODEL_KEY)
            out.append(d)
        return out


@router.get("/motion-models")
def motion_models():
    """The registry an agent picks from: price, ceiling, what each model is
    good at, what it does when it fails, and what to rerun on instead."""
    return {"models": [mm.public(m) for m in mm.all_models()],
            "registers": list(mm.REGISTERS),
            "default": mm.DEFAULT_MODEL_KEY,
            "doctrine": mm.UNFAITHFUL_DOCTRINE,
            # The clause a motion prompt needs when the plate's own prompt
            # never says it is drawn. Served here so the tools relay one
            # wording, not two.
            "anime_clause": mm.ANIME_CLAUSE}


@router.get("/image-models")
def image_models():
    """The still registry an agent picks from: measured price per still, what
    each model is good at, what it does when it fails, and the fallback. The
    motion lane's twin, for the still and i2i lanes."""
    return {"models": [im.public(m) for m in im.all_models()],
            "registers": list(im.REGISTERS),
            "default": im.DEFAULT_MODEL_KEY,
            "text_model": im.TEXT_MODEL_KEY,
            "doctrine": im.TEXT_DOCTRINE}


@router.get("/backends/types")
def backend_types():
    out = []
    for t, cls in ADAPTER_TYPES.items():
        out.append({"type": t, "lanes": sorted(cls.lanes), "kind": cls.kind})
    for t in DIRECTION_TYPES:
        out.append({"type": t, "lanes": ["direction"], "kind": "api"})
    return out


@router.post("/backends",
             dependencies=[Depends(require_admin("editing backends"))])
async def upsert_backend(req: Request):
    body = await req.json()
    bid = re.sub(r"[^a-z0-9-]+", "-", str(body.get("id", "")).lower()).strip("-")
    btype = body.get("type", "")
    if not bid:
        raise HTTPException(400, "need id")
    if btype not in ALL_TYPES:
        raise HTTPException(400, f"type must be one of {sorted(ALL_TYPES)}")
    with session_scope() as s:
        b = s.get(Backend, bid)
        if not b:
            b = Backend(id=bid, type=btype)
            s.add(b)
        b.type = btype
        for k in ("label", "base_url"):
            if k in body:
                setattr(b, k, body[k] or "")
        if "enabled" in body:
            b.enabled = bool(body["enabled"])
        if "options" in body and isinstance(body["options"], dict):
            b.options = body["options"]
        # an empty api_key in the payload means "keep the stored one"
        if body.get("api_key"):
            b.api_key = body["api_key"]
        if body.get("clear_api_key"):
            b.api_key = ""
        s.flush()
        return b.masked()


@router.post("/backends/{bid}/delete",
             dependencies=[Depends(require_admin("deleting backends"))])
def delete_backend(bid: str):
    with session_scope() as s:
        b = s.get(Backend, bid)
        if not b:
            raise HTTPException(404, bid)
        s.delete(b)
    return {"ok": True}


@router.get("/backends/{bid}/health")
async def backend_health(bid: str):
    with session_scope() as s:
        b = s.get(Backend, bid)
        if not b:
            raise HTTPException(404, bid)
        if b.type in DIRECTION_TYPES:
            return {"up": bool(b.api_key or b.type != "anthropic"),
                    "note": "direction provider"}
        adapter = build_adapter(b)
    return await adapter.health()

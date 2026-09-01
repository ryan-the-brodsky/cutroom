from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

from ..adapters import build_adapter
from ..adapters.registry import ADAPTER_TYPES
from ..db import session_scope
from ..models import Backend

router = APIRouter()

DIRECTION_TYPES = ("anthropic", "openai-chat", "claude-cli")
ALL_TYPES = tuple(ADAPTER_TYPES) + DIRECTION_TYPES


@router.get("/backends")
def list_backends():
    with session_scope() as s:
        rows = s.execute(select(Backend).order_by(Backend.created_at)).scalars()
        out = []
        for b in rows:
            d = b.masked()
            cls = ADAPTER_TYPES.get(b.type)
            d["lanes"] = sorted(getattr(cls, "lanes", set())) if cls else \
                (["direction"] if b.type in DIRECTION_TYPES else [])
            out.append(d)
        return out


@router.get("/backends/types")
def backend_types():
    out = []
    for t, cls in ADAPTER_TYPES.items():
        out.append({"type": t, "lanes": sorted(cls.lanes), "kind": cls.kind})
    for t in DIRECTION_TYPES:
        out.append({"type": t, "lanes": ["direction"], "kind": "api"})
    return out


@router.post("/backends")
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


@router.post("/backends/{bid}/delete")
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

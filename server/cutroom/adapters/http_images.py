"""Hosted image backends: OpenAI-compatible /images and OpenRouter-style
chat-completions with image output. These generalize the two adapters that
lived inline in the old dashboard's remote_image_job_code()."""
from __future__ import annotations

import base64
import uuid
from pathlib import Path

import httpx

from .base import Adapter, AdapterError, GenRequest, GenResult


def _data_uri(path: Path) -> str:
    b64 = base64.b64encode(path.read_bytes()).decode()
    ext = path.suffix.lstrip(".").lower().replace("jpg", "jpeg") or "png"
    return f"data:image/{ext};base64,{b64}"


class OpenAIImagesAdapter(Adapter):
    """Any OpenAI-compatible /v1/images/generations endpoint."""
    type_name = "openai-images"
    lanes = {"still"}

    async def health(self) -> dict:
        return {"up": bool(self.cfg.base_url and self.cfg.api_key),
                "note": "configured" if self.cfg.api_key else "missing base/key"}

    async def list_models(self, lane: str) -> list[dict]:
        model = self.opt("model")
        return [{"id": model, "label": model}] if model else []

    async def generate(self, req: GenRequest) -> GenResult:
        if not self.cfg.base_url:
            raise AdapterError("openai-images backend has no base_url")
        model = req.model or self.opt("model")
        payload = {"model": model, "prompt": req.prompt, "n": 1,
                   "size": self.opt("size", default="1536x1024"),
                   "response_format": "b64_json"}
        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.post(self.cfg.base_url.rstrip("/") + "/images/generations",
                             json=payload,
                             headers={"Authorization": f"Bearer {self.cfg.api_key}"})
        if r.status_code != 200:
            raise AdapterError(f"images/generations [{r.status_code}]: {r.text[:400]}")
        data = r.json()["data"][0]
        raw = base64.b64decode(data["b64_json"])
        out = req.workdir / f"openai_{uuid.uuid4().hex[:8]}.png"
        out.write_bytes(raw)
        return GenResult(files=[out], meta={"backend": self.cfg.id, "model": model})


class OpenRouterImageAdapter(Adapter):
    """chat/completions with image output modality (Gemini-image class models).
    Supports i2i by attaching the source image to the message."""
    type_name = "openrouter-image"
    lanes = {"still", "i2i"}

    async def health(self) -> dict:
        return {"up": bool(self.cfg.api_key),
                "note": "configured" if self.cfg.api_key else "missing key"}

    async def list_models(self, lane: str) -> list[dict]:
        model = self.opt("model", default="google/gemini-2.5-flash-image")
        return [{"id": model, "label": model}]

    async def generate(self, req: GenRequest) -> GenResult:
        base = (self.cfg.base_url or "https://openrouter.ai/api/v1").rstrip("/")
        model = req.model or self.opt("model", default="google/gemini-2.5-flash-image")
        content: list[dict] = [{"type": "text", "text": req.prompt}]
        if req.source:
            content.append({"type": "image_url",
                            "image_url": {"url": _data_uri(Path(req.source))}})
        payload = {"model": model,
                   "messages": [{"role": "user", "content": content}],
                   "modalities": ["image", "text"]}
        # Film frames are widescreen: ask for it (OpenRouter forwards image_config to
        # Gemini-class models; verified 2026-09-01 → 1344x768 for "16:9"). Per-request
        # params win, then the backend option, then 16:9.
        aspect = (getattr(req, "params", None) or {}).get("aspect_ratio") \
            or self.opt("aspect_ratio", default="16:9")
        if aspect:
            payload["image_config"] = {"aspect_ratio": str(aspect)}
        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.post(base + "/chat/completions", json=payload,
                             headers={"Authorization": f"Bearer {self.cfg.api_key}"})
        if r.status_code != 200:
            raise AdapterError(f"chat/completions [{r.status_code}]: {r.text[:400]}")
        msg = r.json()["choices"][0]["message"]
        images = msg.get("images") or []
        if not images:
            raise AdapterError("backend returned no image: "
                               + str(msg.get("content", ""))[:300])
        url = images[0]["image_url"]["url"]
        if not url.startswith("data:"):
            async with httpx.AsyncClient(timeout=120) as c:
                raw = (await c.get(url)).content
        else:
            raw = base64.b64decode(url.split(",", 1)[1])
        out = req.workdir / f"openrouter_{uuid.uuid4().hex[:8]}.png"
        out.write_bytes(raw)
        return GenResult(files=[out], meta={"backend": self.cfg.id, "model": model})

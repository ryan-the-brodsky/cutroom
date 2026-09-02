"""Hosted image backends: OpenAI-compatible /images and OpenRouter-style
chat-completions with image output. These generalize the two adapters that
lived inline in the original pipeline's remote image job."""
from __future__ import annotations

import base64
import uuid
from pathlib import Path

import httpx

from .. import style as style_mod
from .base import Adapter, AdapterError, GenRequest, GenResult


def _data_uri(path: Path) -> str:
    b64 = base64.b64encode(path.read_bytes()).decode()
    ext = path.suffix.lstrip(".").lower().replace("jpg", "jpeg") or "png"
    return f"data:image/{ext};base64,{b64}"


def prompt_with_negative(req: GenRequest) -> str:
    """Neither endpoint in this module has a negative field. Rather than drop
    the negative — which is what happened until 2026-09-02, so "text,
    watermark, photorealistic" never reached Gemini at all — say it in the
    prompt as a closing "Avoid: …" sentence. Adapters that DO have a real
    negative field (ComfyUI) keep using it."""
    return style_mod.fold_avoid(req.prompt, req.negative)


class OpenAIImagesAdapter(Adapter):
    """Any OpenAI-compatible /v1/images/generations endpoint."""
    type_name = "openai-images"
    lanes = {"still"}
    #: /images/generations takes no image input, so style references cannot be
    #: attached here even when the project has them.
    accepts_style_refs = False

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
        payload = {"model": model, "prompt": prompt_with_negative(req), "n": 1,
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
    #: Content parts carry images, so the project's style-reference frames can
    #: ride along. Turn it off per backend with options.style_refs = false.
    accepts_style_refs = True

    async def health(self) -> dict:
        return {"up": bool(self.cfg.api_key),
                "note": "configured" if self.cfg.api_key else "missing key"}

    async def list_models(self, lane: str) -> list[dict]:
        model = self.opt("model", default="google/gemini-2.5-flash-image")
        return [{"id": model, "label": model}]

    async def generate(self, req: GenRequest) -> GenResult:
        base = (self.cfg.base_url or "https://openrouter.ai/api/v1").rstrip("/")
        model = req.model or self.opt("model", default="google/gemini-2.5-flash-image")
        content: list[dict] = []
        # Style references first: the model reads the instruction, then sees
        # what the film looks like, then hears what this shot is. Content-last
        # is deliberate — the last text part is the one it renders.
        # Reference frames pull the palette toward the references (measured: three night
        # interiors darkened a daylight scene), so they are opt-in per backend.
        refs = req.refs if self.opt("style_refs", default=False) is True else []
        for i, ref in enumerate(refs or []):
            if i == 0:
                content.append({"type": "text",
                                "text": style_mod.STYLE_REF_INSTRUCTION})
            content.append({"type": "image_url",
                            "image_url": {"url": _data_uri(Path(ref))}})
        if req.source:
            if content:
                content.append({"type": "text",
                                "text": "The image to work from follows."})
            content.append({"type": "image_url",
                            "image_url": {"url": _data_uri(Path(req.source))}})
        content.append({"type": "text", "text": prompt_with_negative(req)})
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
        data = r.json()
        # Token usage is how the style-reference option pays for itself or does
        # not: each attached frame is input tokens on every still.
        usage = {k: v for k, v in (data.get("usage") or {}).items()
                 if isinstance(v, (int, float))}
        msg = data["choices"][0]["message"]
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
        return GenResult(files=[out], meta={"backend": self.cfg.id, "model": model,
                                            "style_refs": len(refs or []),
                                            "usage": usage,
                                            "generation_id": data.get("id")})

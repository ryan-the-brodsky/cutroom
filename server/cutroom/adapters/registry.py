"""Adapter registry + default backend seeding.

The lane → backend → model chain:
  * a LANE names a kind of work (still, i2i, motion, vo, sfx, music)
  * a BACKEND is a configured adapter instance (rows in the backends table)
  * a MODEL is whatever that backend can serve (discovered live where the
    protocol allows — ComfyUI checkpoints, ElevenLabs voices)
Projects set per-lane defaults (LaneConfig); every generation request may
override backend and model.
"""
from __future__ import annotations

import os

from .base import Adapter, AdapterError, BackendConfig
from .comfyui import ComfyUIAdapter
from .elevenlabs import ElevenLabsAdapter
from .http_images import OpenAIImagesAdapter, OpenRouterImageAdapter
from .mock import MockAdapter
from .queue_apis import FalAdapter, ReplicateAdapter

ADAPTER_TYPES: dict[str, type[Adapter]] = {
    a.type_name: a
    for a in (ComfyUIAdapter, OpenAIImagesAdapter, OpenRouterImageAdapter,
              FalAdapter, ReplicateAdapter, ElevenLabsAdapter, MockAdapter)
}

GEN_LANES = ("still", "i2i", "motion", "vo", "sfx", "music")


def build_adapter(cfg_or_row) -> Adapter:
    cfg = cfg_or_row if isinstance(cfg_or_row, BackendConfig) \
        else BackendConfig.from_row(cfg_or_row)
    cls = ADAPTER_TYPES.get(cfg.type)
    if not cls:
        raise AdapterError(f"unknown backend type: {cfg.type}")
    return cls(cfg)


def pool_for(backend_row) -> tuple[str, int]:
    """(pool name, concurrency). GPU backends default to strictly serial —
    the memory discipline that kept the 16GB box alive, now per-backend."""
    adapter_cls = ADAPTER_TYPES.get(backend_row.type)
    kind = getattr(adapter_cls, "kind", "api")
    default = 1 if kind == "gpu" else 4
    conc = int((backend_row.options or {}).get("concurrency", default))
    return f"backend:{backend_row.id}", max(1, conc)


def default_backends() -> list[dict]:
    """Seeded on first boot. Local ComfyUI enabled (the self-host default);
    hosted templates disabled until keys are added. Env keys auto-wire."""
    eleven_key = os.environ.get("ELEVEN_LABS_API_KEY", "")
    return [
        {"id": "local-comfyui", "type": "comfyui",
         "label": "ComfyUI (local)", "base_url": "http://127.0.0.1:8188",
         "enabled": True, "options": {"concurrency": 1}},
        {"id": "elevenlabs", "type": "elevenlabs",
         "label": "ElevenLabs", "api_key": eleven_key,
         "enabled": bool(eleven_key), "options": {"model": "eleven_v3"}},
        {"id": "openrouter-image", "type": "openrouter-image",
         "label": "OpenRouter image", "base_url": "https://openrouter.ai/api/v1",
         "enabled": False,
         "options": {"model": "google/gemini-2.5-flash-image"}},
        {"id": "openai-images", "type": "openai-images",
         "label": "OpenAI-compatible images", "enabled": False,
         "options": {"size": "1536x1024"}},
        {"id": "fal", "type": "fal", "label": "fal.ai", "enabled": False,
         "options": {"model": "fal-ai/ltx-video",
                     "models": ["fal-ai/ltx-video"]}},
        {"id": "replicate", "type": "replicate", "label": "Replicate",
         "enabled": False, "options": {}},
        {"id": "mock", "type": "mock",
         "label": "Test mode (existing footage, instant)",
         "enabled": False, "options": {}},
    ]

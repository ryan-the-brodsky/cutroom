"""Adapter contract — every generative backend implements this.

A backend is a row of config (type, base_url, api_key, options); an adapter is
the code that speaks its protocol. Adapters are stateless per-call: they read
a GenRequest, produce files into the request's workdir, and return metadata.
Job handlers own moving files into project storage and recording Takes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

LANES = ("still", "i2i", "motion", "vo", "sfx", "music")


class AdapterError(RuntimeError):
    pass


@dataclass
class BackendConfig:
    id: str
    type: str
    label: str = ""
    base_url: str = ""
    api_key: str = ""
    options: dict = field(default_factory=dict)

    @classmethod
    def from_row(cls, row) -> "BackendConfig":
        return cls(id=row.id, type=row.type, label=row.label,
                   base_url=row.base_url, api_key=row.api_key,
                   options=dict(row.options or {}))


@dataclass
class GenRequest:
    lane: str
    workdir: Path
    prompt: str = ""
    negative: str = ""
    source: Path | None = None       # i2i / i2v input image
    refs: list[Path] = field(default_factory=list)   # style-reference frames
    width: int = 768
    height: int = 432
    frames: int = 97                 # i2v (8k+1 for LTX-class models)
    steps: int | None = None
    cfg: float | None = None
    denoise: float | None = None     # i2i
    seed: int = 42
    model: str | None = None         # per-request model override
    voice: str | None = None         # tts
    duration: float | None = None    # sfx/music/i2v seconds
    params: dict = field(default_factory=dict)
    log: Callable[[str], None] = lambda s: None


@dataclass
class GenResult:
    files: list[Path]
    meta: dict = field(default_factory=dict)


class Adapter:
    type_name: str = ""
    lanes: set[str] = set()
    kind: str = "api"                # api | gpu — informs default pool sizing

    def __init__(self, cfg: BackendConfig):
        self.cfg = cfg

    def opt(self, *keys, default=None):
        cur = self.cfg.options or {}
        for k in keys:
            if not isinstance(cur, dict) or k not in cur:
                return default
            cur = cur[k]
        return cur

    async def health(self) -> dict:
        raise NotImplementedError

    async def list_models(self, lane: str) -> list[dict]:
        """[{id, label?}] — feeds the model pickers. May be empty (free-text)."""
        return []

    async def generate(self, req: GenRequest) -> GenResult:
        raise NotImplementedError


def merged_lane_options(adapter: Adapter, lane: str, req: GenRequest,
                        defaults: dict) -> dict:
    """defaults < backend.options[lane] < request params (explicit wins)."""
    out = dict(defaults)
    out.update(adapter.cfg.options.get(lane, {}) or {})
    out.update({k: v for k, v in (req.params or {}).items() if v is not None})
    if req.steps is not None:
        out["steps"] = req.steps
    if req.cfg is not None:
        out["cfg"] = req.cfg
    return out

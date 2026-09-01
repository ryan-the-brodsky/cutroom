"""Test-mode backend — generations return real existing footage instantly.

Lets the full composition/editing surface (cel comps, freezes, chains,
animatic, curation) run end-to-end with production-shaped media before any
GPU or paid endpoint is plugged in. Selection is seeded, so rerolls vary
deterministically.

Where mock media comes from, per lane:
  still   a seeded pick from the source project's existing stills,
          cover-fit to the requested dims
  i2i     the REQUEST source image, hue-shifted by denoise (layout is kept,
          the restyle is visible — semantically faithful to i2i)
  motion  a seeded pick from the source project's existing clips, scaled to
          the requested dims and trimmed/padded to the requested frames —
          real anime motion flows through the composite path
  vo/sfx  a seeded pick from the source project's generated audio, else a
          synthesized tone

options: {"source_project": "<project-id>"}  (defaults to the requesting
project when the job payload carries one; falls back to synthesized media)
"""
from __future__ import annotations

import random
import uuid
from pathlib import Path

import numpy as np
from PIL import Image

from .base import Adapter, GenRequest, GenResult


def _pick(paths: list[str], seed: int) -> str | None:
    if not paths:
        return None
    return paths[random.Random(seed).randrange(len(paths))]


class MockAdapter(Adapter):
    type_name = "mock"
    lanes = {"still", "i2i", "motion", "vo", "sfx", "music"}
    kind = "api"

    async def health(self) -> dict:
        return {"up": True, "note": "test mode — returns existing footage"}

    async def list_models(self, lane: str) -> list[dict]:
        return [{"id": "mock-instant", "label": "mock (existing footage)"}]

    def _store(self, req: GenRequest):
        from ..storage import get_storage
        project = self.opt("source_project") or req.params.get("_project")
        if not project:
            return None
        try:
            store = get_storage().project(project)
            return store if store.root.exists() else None
        except Exception:
            return None

    # ------------------------------------------------------------- media
    def _synth_image(self, w: int, h: int, seed: int, out: Path) -> Path:
        rng = np.random.default_rng(seed)
        base = rng.integers(40, 200, 3)
        arr = np.zeros((h, w, 3), np.uint8)
        for c in range(3):
            arr[:, :, c] = np.clip(
                base[c] + np.linspace(-40, 40, w)[None, :] +
                np.linspace(-30, 30, h)[:, None], 0, 255)
        Image.fromarray(arr).save(out)
        return out

    def _still(self, req: GenRequest) -> Path:
        from ..engine.images import cover
        out = req.workdir / f"mock_{uuid.uuid4().hex[:8]}.png"
        store = self._store(req)
        pick = _pick(store.listdir("renders/stills", "*.png"), req.seed) \
            if store else None
        if pick:
            img = Image.open(store.resolve(pick)).convert("RGB")
            cover(img, (req.width, req.height)).save(out)
            req.log(f"[mock] still <- {pick}")
        else:
            self._synth_image(req.width, req.height, req.seed, out)
            req.log("[mock] still <- synthesized")
        return out

    def _i2i(self, req: GenRequest) -> Path:
        out = req.workdir / f"mock_{uuid.uuid4().hex[:8]}.png"
        img = Image.open(req.source).convert("HSV")
        arr = np.asarray(img).astype(int)
        shift = int(30 + 150 * float(req.denoise or 0.85))
        arr[:, :, 0] = (arr[:, :, 0] + shift + req.seed % 40) % 256
        Image.fromarray(arr.astype(np.uint8), "HSV").convert("RGB").save(out)
        req.log(f"[mock] i2i hue-shift {shift} (denoise {req.denoise})")
        return out

    def _motion(self, req: GenRequest) -> Path:
        from ..engine import ffmpeg as e_ff
        frames = req.frames if (req.frames - 1) % 8 == 0 else \
            max(9, ((req.frames - 1) // 8) * 8 + 1)
        dur = frames / 24.0
        out = req.workdir / f"mock_{uuid.uuid4().hex[:8]}.webm"
        store = self._store(req)
        clips = []
        if store:
            clips = store.listdir("renders/motion", "*.webm") + \
                store.listdir("renders/motion/tests", "*.webm")
        pick = _pick(clips, req.seed)
        if pick:
            src = store.resolve(pick)
            vf = (f"scale={req.width}:{req.height}:"
                  f"force_original_aspect_ratio=increase,"
                  f"crop={req.width}:{req.height},"
                  f"tpad=stop_mode=clone:stop_duration={dur:.3f}")
            e_ff.run([e_ff.FFMPEG, "-v", "error", "-y", "-i", str(src),
                      "-vf", vf, "-t", f"{dur:.3f}", "-r", "24", "-an",
                      *e_ff.VP9_ARGS, str(out)])
            req.log(f"[mock] motion <- {pick} ({frames}f @{req.width}x"
                    f"{req.height})")
        else:
            # brightness-pulse the source image (clearly mock, valid timing)
            base = Image.open(req.source).convert("RGB") if req.source else \
                Image.open(self._synth_image(req.width, req.height, req.seed,
                                             req.workdir / "b.png"))
            base = base.resize((req.width, req.height))
            arr = np.asarray(base).astype(float)
            enc = e_ff.RawFrameEncoder(out.with_suffix(".mp4"), req.width,
                                       req.height, 24)
            for f in range(frames):
                k = 0.85 + 0.15 * np.sin(2 * np.pi * f / 24)
                enc.write(np.clip(arr * k, 0, 255).astype(np.uint8))
            enc.close()
            out = out.with_suffix(".mp4")
            req.log(f"[mock] motion <- synthesized pulse ({frames}f)")
        return out

    def _audio(self, req: GenRequest) -> Path:
        from ..engine import ffmpeg as e_ff
        store = self._store(req)
        picks = store.listdir("audio/generated", "*.wav") if store else []
        pick = _pick(picks, req.seed)
        out = req.workdir / f"mock_{uuid.uuid4().hex[:8]}.wav"
        if pick:
            out.write_bytes(store.resolve(pick).read_bytes())
            req.log(f"[mock] vo <- {pick}")
        else:
            sr = 44100
            dur = req.duration or max(1.0, len(req.prompt) / 15)
            t = np.arange(int(sr * dur)) / sr
            x = 0.3 * np.sin(2 * np.pi * (200 + req.seed % 200) * t)
            e_ff.encode_audio(x, out)
            req.log("[mock] vo <- synthesized tone")
        return out

    async def generate(self, req: GenRequest) -> GenResult:
        if req.lane == "still":
            f = self._still(req)
        elif req.lane == "i2i":
            f = self._i2i(req)
        elif req.lane == "motion":
            f = self._motion(req)
        else:
            f = self._audio(req)
        return GenResult(files=[f], meta={"backend": self.cfg.id,
                                          "mock": True, "seed": req.seed})

"""ElevenLabs adapter — VO (v3 audio tags pass through untouched), SFX, music.

The voice picker lists the account's voices live. Per-line performance
direction (stability/style/similarity/speed + inline tags like [whispers] and
<break time="1.6s"/>) rides in request params, per bible/voice-direction.md.
"""
from __future__ import annotations

import uuid

import httpx

from .base import Adapter, AdapterError, GenRequest, GenResult

DEFAULT_BASE = "https://api.elevenlabs.io"


class ElevenLabsAdapter(Adapter):
    type_name = "elevenlabs"
    lanes = {"vo", "sfx", "music"}

    @property
    def base(self) -> str:
        return (self.cfg.base_url or DEFAULT_BASE).rstrip("/")

    def _headers(self) -> dict:
        if not self.cfg.api_key:
            raise AdapterError("elevenlabs backend has no api key")
        return {"xi-api-key": self.cfg.api_key}

    async def health(self) -> dict:
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.get(self.base + "/v1/user", headers=self._headers())
            if r.status_code in (401, 403):
                # Restricted keys (generation-only scopes) cannot read the account;
                # probe something they can: the voice list.
                async with httpx.AsyncClient(timeout=20) as c:
                    v = await c.get(self.base + "/v1/voices", headers=self._headers())
                if v.status_code == 200:
                    return {"up": True, "tier": "restricted key",
                            "note": "key cannot read account usage; generation works"}
                return {"up": False, "error": f"HTTP {r.status_code} (/v1/user), HTTP {v.status_code} (/v1/voices)"}
            if r.status_code != 200:
                return {"up": False, "error": f"HTTP {r.status_code}"}
            sub = r.json().get("subscription", {})
            return {"up": True, "tier": sub.get("tier"),
                    "chars_used": sub.get("character_count"),
                    "chars_limit": sub.get("character_limit")}
        except AdapterError:
            return {"up": False, "error": "missing key"}
        except Exception as e:
            return {"up": False, "error": str(e)}

    async def list_models(self, lane: str) -> list[dict]:
        """For the vo lane the 'models' the picker wants are VOICES."""
        if lane != "vo":
            return []
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(self.base + "/v1/voices", headers=self._headers())
        if r.status_code != 200:
            raise AdapterError(f"voices [{r.status_code}]: {r.text[:300]}")
        return [{"id": v["voice_id"],
                 "label": f"{v.get('name', v['voice_id'])} "
                          f"({v.get('category', '')})".strip()}
                for v in r.json().get("voices", [])]

    async def generate(self, req: GenRequest) -> GenResult:
        if req.lane == "vo":
            voice = req.voice or req.model or self.opt("voice")
            if not voice:
                raise AdapterError("vo needs a voice id")
            model = self.opt("model", default="eleven_v3")
            settings = {"stability": req.params.get("stability", 0.5),
                        "similarity_boost": req.params.get("similarity", 0.75),
                        "style": req.params.get("style", 0.0),
                        "use_speaker_boost": True}
            if req.params.get("speed"):
                settings["speed"] = req.params["speed"]
            payload = {"text": req.prompt, "model_id":
                       req.params.get("model_id", model),
                       "voice_settings": settings}
            if req.params.get("seed") is not None:
                payload["seed"] = int(req.params["seed"])
            url = f"{self.base}/v1/text-to-speech/{voice}"
            out_name = f"vo_{uuid.uuid4().hex[:8]}.mp3"
        elif req.lane == "sfx":
            # /v1/sound-generation: 0.5–30 s, prompt_influence 0–1 (higher
            # follows the words more literally, lower is more inventive).
            payload = {"text": req.prompt}
            if req.duration:
                payload["duration_seconds"] = max(0.5, min(
                    30.0, float(req.duration)))
            influence = (req.params.get("influence")
                         if req.params.get("influence") is not None
                         else req.params.get("prompt_influence"))
            if influence is not None:
                payload["prompt_influence"] = max(0.0, min(1.0,
                                                           float(influence)))
            if req.params.get("loop"):
                payload["loop"] = True
            url = f"{self.base}/v1/sound-generation"
            out_name = f"sfx_{uuid.uuid4().hex[:8]}.mp3"
        elif req.lane == "music":
            # /v1/music: 10 s–5 min, billed by length. `instrumental` keeps
            # the vocal generator out of a score that sits under dialogue.
            payload = {"prompt": req.prompt}
            if req.duration:
                payload["music_length_ms"] = int(
                    max(10.0, min(300.0, float(req.duration))) * 1000)
            if req.params.get("instrumental"):
                payload["force_instrumental"] = True
            music_model = req.model or self.opt("music_model")
            if music_model:
                payload["model_id"] = music_model
            url = f"{self.base}/v1/music"
            out_name = f"music_{uuid.uuid4().hex[:8]}.mp3"
        else:
            raise AdapterError(f"elevenlabs has no lane {req.lane}")

        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.post(url, json=payload, headers=self._headers())
        if r.status_code != 200:
            raise AdapterError(f"{req.lane} [{r.status_code}]: {r.text[:400]}")
        out = req.workdir / out_name
        out.write_bytes(r.content)
        return GenResult(files=[out],
                         meta={"backend": self.cfg.id, "lane": req.lane,
                               "voice": req.voice or req.model,
                               "chars": len(req.prompt)})

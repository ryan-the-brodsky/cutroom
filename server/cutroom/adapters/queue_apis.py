"""Queue-style hosted generation APIs: fal.ai and Replicate.

These close the seam the original pipeline declared but never implemented
("remote-video-tbd"): hosted video models become a motion backend the model
picker can select per shot. Both adapters are deliberately generic — the
model id and any extra payload live in Backend.options, and results are found
by walking the response JSON for media URLs, so new models need config, not
code.
"""
from __future__ import annotations

import asyncio
import base64
import uuid
from pathlib import Path

import httpx

from . import motion_models
from .base import Adapter, AdapterError, GenRequest, GenResult

MEDIA_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov",
                  ".wav", ".mp3")


def _find_media_urls(obj) -> list[str]:
    urls: list[str] = []

    def walk(v):
        if isinstance(v, str) and v.startswith("http") and \
                any(v.split("?")[0].lower().endswith(s) for s in MEDIA_SUFFIXES):
            urls.append(v)
        elif isinstance(v, dict):
            # fal-style {"url": ..., "content_type": ...}
            if isinstance(v.get("url"), str) and v["url"].startswith("http"):
                urls.append(v["url"])
            else:
                for x in v.values():
                    walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(obj)
    return list(dict.fromkeys(urls))


def _data_uri(path: Path) -> str:
    b64 = base64.b64encode(path.read_bytes()).decode()
    ext = path.suffix.lstrip(".").lower().replace("jpg", "jpeg") or "png"
    return f"data:image/{ext};base64,{b64}"


async def _download_all(urls: list[str], workdir: Path, headers: dict,
                        prefix: str) -> list[Path]:
    out = []
    async with httpx.AsyncClient(timeout=600, follow_redirects=True) as c:
        for u in urls:
            r = await c.get(u, headers=headers)
            if r.status_code != 200:
                continue
            name = u.split("?")[0].rsplit("/", 1)[-1] or "out.bin"
            dest = workdir / f"{prefix}_{name}"
            dest.write_bytes(r.content)
            out.append(dest)
    if not out:
        raise AdapterError("no downloadable outputs in response")
    return out



# --------------------------------------------------------------- payload maps
#: Per-model request shaping for fal image-to-video endpoints. Every endpoint
#: names its input image `image_url` and its prompt `prompt`, but duration,
#: resolution and the camera controls all differ, and several endpoints have no
#: duration field at all. The shapes live in the motion model registry
#: (`motion_models.py`) next to the price and the use cases they belong with;
#: this is the adapter's view of them.
#:
#:   duration_key   the field that carries clip length (None = fixed length)
#:   duration_type  "int" | "str"  — endpoints disagree on how to spell 5
#:   resolution_key + resolutions  — the model's own enum
#:   defaults       payload keys always sent unless the caller overrides them


def payload_map(model: str | None) -> dict:
    """Longest-prefix match, so a versioned sub-path still finds its map."""
    if not model:
        return {}
    best: tuple[int, dict] = (0, {})
    for prefix, m in motion_models.payload_maps().items():
        if model.startswith(prefix) and len(prefix) > best[0]:
            best = (len(prefix), m)
    return dict(best[1])


def _duration_value(m: dict, seconds: float):
    """Snap seconds onto whatever this endpoint accepts."""
    vals = m.get("duration_values")
    if vals:
        seconds = min(vals, key=lambda v: abs(float(v) - seconds))
    lo, hi = (m.get("duration_range") or [1, 15])[:2]
    seconds = max(float(lo), min(float(seconds), float(hi)))
    return str(int(round(seconds))) if m.get("duration_type") == "str" \
        else int(round(seconds))


class FalAdapter(Adapter):
    """fal.ai queue API. options: {"model": "fal-ai/ltx-video",
    "extra_payload": {...}, "prompt_key": "prompt", "image_key": "image_url"}

    Endpoints differ in more than their name: seedance takes `duration` as a
    string and locks the frame with `camera_fixed`, while Wan 2.2 turbo has no
    duration field at all and rejects a negative prompt. The motion model
    registry holds those differences as config, so a new model is a table row
    rather than a code change."""
    type_name = "fal"
    lanes = {"still", "motion"}

    async def health(self) -> dict:
        """Really validates the key, without the risk of starting work.

        Probing with a POST is wrong here: fal's queue endpoint accepts a
        submit and validates asynchronously, so an empty POST *enqueues a
        doomed job* instead of failing auth-first. Use a GET against the
        status route of a request id that cannot exist — fal authenticates
        before it looks the id up, so 401/403 means a bad key and 404 means
        the key was accepted. A GET creates nothing and costs nothing.
        """
        if not self.cfg.api_key:
            return {"up": False, "note": "missing key"}
        model = self.opt("model")
        if not model:
            return {"up": True, "note": "key set (no model configured to probe)"}
        base = (self.cfg.base_url or "https://queue.fal.run").rstrip("/")
        # Status routes live under the *app* id (owner/app), not the full
        # nested model path: submits go to fal-ai/wan/v2.2-a14b/image-to-video
        # but its queue routes hang off fal-ai/wan. Using the full path 405s.
        app = "/".join(model.split("/")[:2])
        probe = f"{base}/{app}/requests/00000000-0000-0000-0000-000000000000/status"
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.get(probe, headers={
                    "Authorization": f"Key {self.cfg.api_key}"})
        except Exception as e:                      # network/DNS/timeout
            return {"up": False, "note": f"unreachable: {type(e).__name__}"}
        if r.status_code in (401, 403):
            return {"up": False, "note": f"key rejected [{r.status_code}]"}
        if r.status_code in (404, 400, 422):
            # Authenticated fine; the bogus request id is what failed.
            return {"up": True, "note": f"key valid (auth ok on {model})"}
        if r.status_code == 200:
            return {"up": True, "note": "key valid"}
        return {"up": False, "note": f"unexpected [{r.status_code}]: {r.text[:120]}"}

    async def list_models(self, lane: str) -> list[dict]:
        models = self.opt("models") or ([self.opt("model")] if self.opt("model") else [])
        return [{"id": m, "label": m} for m in models if m]

    async def generate(self, req: GenRequest) -> GenResult:
        # "seedance" and "wan" are registry keys; anything else passes through
        model = motion_models.resolve_id(req.model or self.opt("model"))
        if not model:
            raise AdapterError("fal backend needs a model id (e.g. fal-ai/ltx-video)")
        headers = {"Authorization": f"Key {self.cfg.api_key}"}
        m = payload_map(model)
        payload: dict = {}
        # model defaults < backend options < this request
        payload.update(m.get("defaults") or {})
        payload[self.opt("prompt_key", default=m.get("prompt_key", "prompt"))] = \
            req.prompt
        if req.lane == "motion" and m:
            # clip length: only where the endpoint actually has the field
            secs = req.duration
            if secs:
                if m.get("duration_key"):
                    payload[m["duration_key"]] = _duration_value(m, float(secs))
                else:
                    req.log(f"{model} has no duration field — fixed-length clip; "
                            f"trim to {float(secs):g}s downstream")
            if m.get("seed_key"):
                payload.setdefault(m["seed_key"], req.seed)
        payload.update(self.opt("extra_payload") or {})
        payload.update(req.params.get("payload", {}))
        if req.negative:
            neg = m.get("negative_key", "negative_prompt") if m \
                else "negative_prompt"
            if neg:
                payload.setdefault(neg, req.negative)
            else:
                req.log(f"{model} takes no negative prompt — dropping it")
        if m.get("aspect_key") is None and m:
            payload.pop("aspect_ratio", None)
        # fal's Wan endpoints reject aspect_ratio="auto" for inputs outside
        # their supported set — resolve it from the actual source dims.
        if payload.get("aspect_ratio", "auto") == "auto" and req.width and \
                req.height:
            ratio = req.width / req.height
            payload["aspect_ratio"] = min(
                (("16:9", 16 / 9), ("9:16", 9 / 16), ("1:1", 1.0)),
                key=lambda kv: abs(kv[1] - ratio))[0]
        if req.source:
            payload[self.opt("image_key",
                             default=m.get("image_key", "image_url"))] = \
                _data_uri(Path(req.source))
        base = (self.cfg.base_url or "https://queue.fal.run").rstrip("/")
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(f"{base}/{model}", json=payload, headers=headers)
            if r.status_code not in (200, 201, 202):
                raise AdapterError(f"fal submit [{r.status_code}]: {r.text[:400]}")
            d = r.json()
            status_url = d.get("status_url")
            response_url = d.get("response_url")
            if not status_url:                       # synchronous response
                urls = _find_media_urls(d)
                return GenResult(
                    files=await _download_all(urls, req.workdir, headers, "fal"),
                    meta={"backend": self.cfg.id, "model": model})
            deadline = asyncio.get_event_loop().time() + \
                float(self.opt("timeout", default=1200))
            while asyncio.get_event_loop().time() < deadline:
                s = (await c.get(status_url, headers=headers)).json()
                st = s.get("status")
                if st == "COMPLETED":
                    break
                if st in ("FAILED", "ERROR", "CANCELLED"):
                    raise AdapterError(f"fal job {st}: {str(s)[:400]}")
                await asyncio.sleep(4)
            else:
                raise AdapterError("fal job timeout")
            result = (await c.get(response_url, headers=headers)).json()
        urls = _find_media_urls(result)
        if not urls:
            raise AdapterError("fal returned no media urls; response: "
                               f"{str(result)[:500]}")
        files = await _download_all(urls, req.workdir, headers, "fal")
        return GenResult(files=files, meta={"backend": self.cfg.id,
                                            "model": model})


class ReplicateAdapter(Adapter):
    """Replicate predictions API. options: {"model": "owner/name" or a
    64-char version hash, "extra_input": {...}, "image_key": "image"}"""
    type_name = "replicate"
    lanes = {"still", "motion"}

    async def health(self) -> dict:
        return {"up": bool(self.cfg.api_key),
                "note": "configured" if self.cfg.api_key else "missing key"}

    async def list_models(self, lane: str) -> list[dict]:
        models = self.opt("models") or ([self.opt("model")] if self.opt("model") else [])
        return [{"id": m, "label": m} for m in models if m]

    async def generate(self, req: GenRequest) -> GenResult:
        model = req.model or self.opt("model")
        if not model:
            raise AdapterError("replicate backend needs a model (owner/name or version)")
        base = (self.cfg.base_url or "https://api.replicate.com/v1").rstrip("/")
        headers = {"Authorization": f"Bearer {self.cfg.api_key}",
                   "Prefer": "wait=10"}
        inp = {"prompt": req.prompt}
        inp.update(self.opt("extra_input") or {})
        inp.update(req.params.get("input", {}))
        if req.source:
            inp[self.opt("image_key", default="image")] = _data_uri(Path(req.source))
        if "/" in model:
            url = f"{base}/models/{model}/predictions"
            payload = {"input": inp}
        else:
            url = f"{base}/predictions"
            payload = {"version": model, "input": inp}
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(url, json=payload, headers=headers)
            if r.status_code not in (200, 201, 202):
                raise AdapterError(f"replicate submit [{r.status_code}]: "
                                   f"{r.text[:400]}")
            pred = r.json()
            get_url = pred.get("urls", {}).get("get")
            deadline = asyncio.get_event_loop().time() + \
                float(self.opt("timeout", default=1200))
            while pred.get("status") in ("starting", "processing") and \
                    asyncio.get_event_loop().time() < deadline:
                await asyncio.sleep(4)
                pred = (await c.get(get_url, headers=headers)).json()
        if pred.get("status") != "succeeded":
            raise AdapterError(f"replicate {pred.get('status')}: "
                               f"{str(pred.get('error'))[:400]}")
        urls = _find_media_urls(pred.get("output"))
        files = await _download_all(urls, req.workdir, {}, "replicate")
        return GenResult(files=files, meta={"backend": self.cfg.id,
                                            "model": model})

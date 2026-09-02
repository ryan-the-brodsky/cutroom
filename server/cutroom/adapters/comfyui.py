"""ComfyUI adapter — any ComfyUI server, local or remote.

The decisive change from the single-machine scripts Cutroom grew out of: NO
filesystem coupling. Sources go
up via POST /upload/image and results come back via GET /view, so the ComfyUI
host can be this machine, a LAN box, or a rented GPU VM. Model discovery reads
/object_info, which is what feeds the UI model pickers.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path

import httpx

from .base import (Adapter, AdapterError, GenRequest, GenResult,
                   merged_lane_options)
from .comfy_workflows import (ANIMA_STILL_DEFAULTS, LTX_MOTION_DEFAULTS,
                              anima_graph, ltx_graph)


class ComfyUIAdapter(Adapter):
    type_name = "comfyui"
    lanes = {"still", "i2i", "motion"}
    kind = "gpu"

    @property
    def base(self) -> str:
        return (self.cfg.base_url or "http://127.0.0.1:8188").rstrip("/")

    def _client(self) -> httpx.AsyncClient:
        headers = {}
        if self.cfg.api_key:  # e.g. a reverse proxy in front of a rented box
            headers["Authorization"] = f"Bearer {self.cfg.api_key}"
        return httpx.AsyncClient(base_url=self.base, headers=headers,
                                 timeout=httpx.Timeout(30.0, read=60.0))

    async def health(self) -> dict:
        try:
            async with self._client() as c:
                q = (await c.get("/queue")).json()
                return {"up": True,
                        "running": len(q.get("queue_running", [])),
                        "pending": len(q.get("queue_pending", []))}
        except Exception as e:
            return {"up": False, "error": str(e)}

    async def list_models(self, lane: str) -> list[dict]:
        try:
            async with self._client() as c:
                info = (await c.get("/object_info")).json()
        except Exception as e:
            raise AdapterError(f"object_info failed: {e}") from e

        def choices(node: str, field: str) -> list[str]:
            try:
                v = info[node]["input"]["required"][field][0]
                return [x for x in v if isinstance(x, str)]
            except Exception:
                return []

        if lane in ("still", "i2i"):
            names = choices("UNETLoader", "unet_name") + \
                choices("CheckpointLoaderSimple", "ckpt_name")
        else:
            names = choices("CheckpointLoaderSimple", "ckpt_name") + \
                choices("UNETLoader", "unet_name")
        return [{"id": n, "label": n} for n in dict.fromkeys(names)]

    async def _upload(self, c: httpx.AsyncClient, path: Path) -> str:
        name = f"cutroom_{uuid.uuid4().hex[:8]}_{path.name}"
        r = await c.post("/upload/image",
                         files={"image": (name, path.read_bytes(),
                                          "application/octet-stream")},
                         data={"overwrite": "true"})
        if r.status_code != 200:
            raise AdapterError(f"upload failed [{r.status_code}]: {r.text[:300]}")
        d = r.json()
        sub = d.get("subfolder") or ""
        return f"{sub}/{d['name']}" if sub else d["name"]

    async def _run_graph(self, graph: dict, timeout: float,
                         req: GenRequest) -> list[dict]:
        async with self._client() as c:
            r = await c.post("/prompt", json=graph)
            if r.status_code != 200:
                raise AdapterError(f"/prompt rejected [{r.status_code}]: "
                                   f"{r.text[:500]}")
            pid = r.json()["prompt_id"]
            req.log(f"[comfyui:{self.cfg.id}] queued {pid}")
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    h = (await c.get(f"/history/{pid}")).json()
                except Exception:
                    await asyncio.sleep(5)
                    continue
                entry = h.get(pid, {})
                outputs = entry.get("outputs", {})
                files = []
                for node_out in outputs.values():
                    for key in ("images", "gifs", "videos"):
                        files.extend(node_out.get(key) or [])
                if files:
                    return files
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    msgs = json.dumps(status.get("messages", []))[:800]
                    raise AdapterError(f"comfyui job error: {msgs}")
                await asyncio.sleep(5)
            try:
                await c.post("/interrupt", json={})
            except Exception:
                pass
            raise AdapterError(f"comfyui timeout after {timeout}s")

    async def _download(self, files: list[dict], workdir: Path,
                        req: GenRequest) -> list[Path]:
        out = []
        async with self._client() as c:
            for f in files:
                params = {"filename": f["filename"],
                          "subfolder": f.get("subfolder", ""),
                          "type": f.get("type", "output")}
                r = await c.get("/view", params=params)
                if r.status_code != 200:
                    raise AdapterError(f"/view failed for {f['filename']}")
                dest = workdir / f["filename"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(r.content)
                out.append(dest)
                req.log(f"[comfyui:{self.cfg.id}] downloaded {f['filename']} "
                        f"({len(r.content) // 1024} KB)")
        return out

    async def free(self) -> None:
        """Evict models — the one-heavy-lane-at-a-time discipline for small boxes."""
        try:
            async with self._client() as c:
                await c.post("/free", json={"unload_models": True,
                                            "free_memory": True})
        except Exception:
            pass

    async def generate(self, req: GenRequest) -> GenResult:
        prefix = f"cutroom_{uuid.uuid4().hex[:8]}"
        if req.lane in ("still", "i2i"):
            o = merged_lane_options(self, "still", req, ANIMA_STILL_DEFAULTS)
            if req.model:
                o["unet"] = req.model
            source_name = None
            if req.lane == "i2i":
                if not req.source:
                    raise AdapterError("i2i needs a source image")
                async with self._client() as c:
                    source_name = await self._upload(c, Path(req.source))
            graph = anima_graph(o, req.prompt, req.negative, req.width,
                                req.height, req.seed, prefix,
                                denoise=req.denoise or 0.85,
                                source_image=source_name)
        elif req.lane == "motion":
            o = merged_lane_options(self, "motion", req, LTX_MOTION_DEFAULTS)
            if req.model:
                o["checkpoint"] = req.model
            if not req.source:
                raise AdapterError("motion (i2v) needs a source image")
            if req.width % 32 or req.height % 32:
                raise AdapterError(f"i2v dims must be /32: {req.width}x{req.height}")
            frames = req.frames
            if (frames - 1) % 8:
                frames = max(9, ((frames - 1) // 8) * 8 + 1)
                req.log(f"[comfyui] frames snapped to 8k+1: {frames}")
            async with self._client() as c:
                source_name = await self._upload(c, Path(req.source))
            graph = ltx_graph(o, source_name, req.prompt, req.negative,
                              req.width, req.height, frames, req.seed, prefix)
        else:
            raise AdapterError(f"comfyui adapter has no lane {req.lane}")

        files = await self._run_graph(graph, float(o.get("timeout", 1800)), req)
        paths = await self._download(files, req.workdir, req)
        if o.get("free_after") and req.lane == "motion":
            await self.free()
        return GenResult(files=paths,
                         meta={"backend": self.cfg.id, "lane": req.lane,
                               "seed": req.seed, "options": {
                                   k: v for k, v in o.items()
                                   if k not in ("positive_prefix", "negative")}})

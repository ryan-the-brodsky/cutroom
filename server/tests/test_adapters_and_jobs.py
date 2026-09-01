"""Adapter tests against a fake ComfyUI (httpx MockTransport) + queue
mechanics with a stub handler."""
import asyncio
import json
import time
from pathlib import Path

import httpx
import pytest

from conftest import make_image


class FakeComfy:
    """Enough of the ComfyUI HTTP API to exercise the adapter."""

    def __init__(self, out_bytes: bytes = b"PNGDATA", out_name: str = "out.png"):
        self.uploads: list[str] = []
        self.graphs: list[dict] = []
        self.out_bytes = out_bytes
        self.out_name = out_name

    def handler(self, request: httpx.Request) -> httpx.Response:
        p = request.url.path
        if p == "/queue":
            return httpx.Response(200, json={"queue_running": [],
                                             "queue_pending": []})
        if p == "/object_info":
            return httpx.Response(200, json={
                "UNETLoader": {"input": {"required": {
                    "unet_name": [["anima-base-v1.0.safetensors",
                                   "other-model.safetensors"]]}}},
                "CheckpointLoaderSimple": {"input": {"required": {
                    "ckpt_name": [["ltxv-2b-0.9.8-distilled.safetensors"]]}}},
            })
        if p == "/upload/image":
            self.uploads.append("up")
            return httpx.Response(200, json={"name": "upload.png",
                                             "subfolder": ""})
        if p == "/prompt":
            self.graphs.append(json.loads(request.content))
            return httpx.Response(200, json={"prompt_id": "pid-1"})
        if p.startswith("/history/"):
            return httpx.Response(200, json={"pid-1": {"outputs": {"9": {
                "images": [{"filename": self.out_name, "subfolder": "",
                            "type": "output"}]}}}})
        if p == "/view":
            return httpx.Response(200, content=self.out_bytes)
        if p in ("/free", "/interrupt"):
            return httpx.Response(200, json={})
        return httpx.Response(404)


@pytest.fixture()
def fake_comfy(monkeypatch):
    fake = FakeComfy()
    from cutroom.adapters.comfyui import ComfyUIAdapter

    def _client(self):
        return httpx.AsyncClient(transport=httpx.MockTransport(fake.handler),
                                 base_url="http://fake:8188")
    monkeypatch.setattr(ComfyUIAdapter, "_client", _client)
    return fake


def test_comfyui_still_generation(fake_comfy, tmp_path, data_dir):
    from cutroom.adapters.base import BackendConfig, GenRequest
    from cutroom.adapters.comfyui import ComfyUIAdapter
    adapter = ComfyUIAdapter(BackendConfig(id="t", type="comfyui"))
    req = GenRequest(lane="still", workdir=tmp_path, prompt="a night street",
                     width=768, height=432, seed=7)
    res = asyncio.run(adapter.generate(req))
    assert res.files and res.files[0].read_bytes() == b"PNGDATA"
    graph = fake_comfy.graphs[0]["prompt"]
    ks = graph["19"]["inputs"]
    assert ks["seed"] == 7 and ks["steps"] == 20 and ks["cfg"] == 4.0
    assert ks["sampler_name"] == "er_sde"
    assert graph["11"]["inputs"]["text"].startswith("masterpiece")
    assert "a night street" in graph["11"]["inputs"]["text"]


def test_comfyui_motion_snaps_frames_and_uploads(fake_comfy, tmp_path,
                                                 data_dir):
    from cutroom.adapters.base import BackendConfig, GenRequest
    from cutroom.adapters.comfyui import ComfyUIAdapter
    src = make_image(tmp_path / "crop.png", 128, 96)
    adapter = ComfyUIAdapter(BackendConfig(id="t", type="comfyui"))
    req = GenRequest(lane="motion", workdir=tmp_path, prompt="hand turns dial",
                     source=src, width=128, height=96, frames=50, seed=42)
    asyncio.run(adapter.generate(req))
    assert fake_comfy.uploads
    graph = fake_comfy.graphs[0]["prompt"]
    assert graph["6"]["inputs"]["length"] == 49          # snapped to 8k+1
    assert graph["1"]["inputs"]["ckpt_name"] == \
        "ltxv-2b-0.9.8-distilled.safetensors"
    assert graph["10"]["inputs"]["sampler_name"] == "euler"


def test_comfyui_rejects_bad_dims(fake_comfy, tmp_path, data_dir):
    from cutroom.adapters.base import AdapterError, BackendConfig, GenRequest
    from cutroom.adapters.comfyui import ComfyUIAdapter
    src = make_image(tmp_path / "c.png", 100, 100)
    adapter = ComfyUIAdapter(BackendConfig(id="t", type="comfyui"))
    with pytest.raises(AdapterError):
        asyncio.run(adapter.generate(GenRequest(
            lane="motion", workdir=tmp_path, prompt="x", source=src,
            width=100, height=100)))


def test_comfyui_model_discovery(fake_comfy, data_dir):
    from cutroom.adapters.base import BackendConfig
    from cutroom.adapters.comfyui import ComfyUIAdapter
    adapter = ComfyUIAdapter(BackendConfig(id="t", type="comfyui"))
    models = asyncio.run(adapter.list_models("still"))
    ids = [m["id"] for m in models]
    assert "anima-base-v1.0.safetensors" in ids
    assert "other-model.safetensors" in ids


def test_queue_runs_and_chains(client, monkeypatch):
    """Submit through the live dispatcher; verify execution, logs, chaining."""
    from cutroom.jobs import handlers
    ran = []

    async def stub(ctx, payload):
        ctx.log(f"stub ran {payload.get('n')}")
        ran.append(payload.get("n"))
        return {"n": payload.get("n")}
    monkeypatch.setitem(handlers.HANDLERS, "test.stub", stub)

    from cutroom.db import session_scope
    from cutroom.jobs.queue import submit_job
    with session_scope() as s:
        job = submit_job(s, "test.stub", {"n": 1}, None, "cpu", "stub 1",
                         chain={"type": "test.stub", "payload": {"n": 2},
                                "pool": "cpu", "title": "stub 2"})
        jid = job.id

    deadline = time.time() + 15
    while time.time() < deadline and len(ran) < 2:
        time.sleep(0.2)
    assert ran == [1, 2]
    d = client.get(f"/api/jobs/{jid}").json()
    assert d["status"] == "done" and d["result"] == {"n": 1}
    log = client.get(f"/api/jobs/{jid}/log").json()
    assert any("stub ran 1" in line for line in log["lines"])
    jobs = client.get("/api/jobs").json()
    assert {j["title"] for j in jobs} == {"stub 1", "stub 2"}


def test_queue_failure_recorded(client, monkeypatch):
    from cutroom.jobs import handlers

    async def boom(ctx, payload):
        raise RuntimeError("kaboom")
    monkeypatch.setitem(handlers.HANDLERS, "test.boom", boom)
    from cutroom.db import session_scope
    from cutroom.jobs.queue import submit_job
    with session_scope() as s:
        jid = submit_job(s, "test.boom", {}, None, "cpu", "boom").id
    deadline = time.time() + 15
    while time.time() < deadline:
        d = client.get(f"/api/jobs/{jid}").json()
        if d["status"] in ("done", "failed"):
            break
        time.sleep(0.2)
    assert d["status"] == "failed"
    assert "kaboom" in d["error"]


def test_worker_claim_protocol(client, monkeypatch):
    """Remote pool: local dispatcher must skip; HTTP claim must serialize."""
    client.post("/api/backends",
                json={"id": "vm-comfy", "type": "comfyui",
                      "base_url": "http://10.0.0.9:8188",
                      "options": {"remote": True}})
    from cutroom.db import session_scope
    from cutroom.jobs.queue import submit_job
    with session_scope() as s:
        j1 = submit_job(s, "gen.still", {"project": "x", "prompt": "p"},
                        None, "backend:vm-comfy", "remote job 1").id
        submit_job(s, "gen.still", {"project": "x", "prompt": "p"},
                   None, "backend:vm-comfy", "remote job 2")
    time.sleep(2.5)  # give the local dispatcher a chance to (wrongly) grab it
    assert client.get(f"/api/jobs/{j1}").json()["status"] == "queued"

    r = client.post("/api/workers/claim",
                    json={"pools": ["backend:vm-comfy"], "name": "vm1"})
    claimed = r.json()["job"]
    assert claimed["id"] == j1
    # pool busy → second claim gets nothing
    r2 = client.post("/api/workers/claim",
                     json={"pools": ["backend:vm-comfy"], "name": "vm1"})
    assert r2.json()["job"] is None
    client.post(f"/api/workers/jobs/{j1}/log", json={"lines": ["hello"]})
    client.post(f"/api/workers/jobs/{j1}/complete",
                json={"status": "done", "result": {"takes": ["a.png"]}})
    d = client.get(f"/api/jobs/{j1}").json()
    assert d["status"] == "done" and d["worker"] == "vm1"
    assert "hello" in client.get(f"/api/jobs/{j1}/log").json()["lines"][0]
    # pool freed → next claim returns job 2
    r3 = client.post("/api/workers/claim",
                     json={"pools": ["backend:vm-comfy"], "name": "vm1"})
    assert r3.json()["job"]["title"] == "remote job 2"

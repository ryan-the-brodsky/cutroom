"""Integration tests for the timeline HTTP surface: model, engine projection,
interchange (OTIO/EDL), engine status, and the render endpoint's guard."""
from __future__ import annotations

from cutroom.db import session_scope
from cutroom.models import Project, Shot
from cutroom.storage import get_storage

from conftest import make_clip, make_image, make_wav


def _seed(client, pid: str) -> None:
    """A 2-shot film reachable through the app (client builds the DB)."""
    store = get_storage().create_project(pid)
    make_clip(store.resolve("renders/motion/B01-S1.webm"), seconds=2.0, fps=24)
    make_image(store.resolve("renders/stills/B02-S1_0.png"))
    make_wav(store.resolve("audio/generated/B01-S1_0.wav"), seconds=1.0)
    with session_scope() as s:
        s.add(Project(id=pid, label="t"))
        s.add(Shot(project_id=pid, sid="B01-S1", type="HERO", seconds=3.0,
                   order_idx=0, act=1))
        s.add(Shot(project_id=pid, sid="B02-S1", type="STILL", seconds=2.0,
                   order_idx=1, act=1, keeper="renders/stills/B02-S1_0.png"))


def test_timeline_and_freecut(client, data_dir):
    _seed(client, "api_a")
    tl = client.get("/api/projects/api_a/timeline").json()
    assert len(tl["clips"]) >= 3 and len(tl["tracks"]) >= 2
    fc = client.get("/api/projects/api_a/timeline/freecut").json()
    assert fc["outputFileName"] == "api_a.mp4"
    assert any(i["type"] == "video" for i in fc["items"])


def test_otio_endpoint(client, data_dir):
    _seed(client, "api_b")
    otio = client.get("/api/projects/api_b/timeline/otio").json()
    assert otio["OTIO_SCHEMA"].startswith("Timeline")
    tracks = otio["tracks"]["children"]
    assert tracks and all(t["OTIO_SCHEMA"].startswith("Track") for t in tracks)
    clips = [c for t in tracks for c in t["children"]
             if c.get("OTIO_SCHEMA", "").startswith("Clip")]
    assert clips
    # lineage survives into OTIO metadata
    assert any(c.get("metadata", {}).get("cutroom", {}).get("shot")
               for c in clips)


def test_edl_endpoint(client, data_dir):
    _seed(client, "api_c")
    r = client.get("/api/projects/api_c/timeline/edl")
    assert r.status_code == 200
    body = r.text
    assert body.startswith("TITLE:")
    import re
    assert re.search(r"\d{2}:\d{2}:\d{2}:\d{2}", body)   # a timecode


def test_engine_status_and_render_guard(client, data_dir, monkeypatch):
    _seed(client, "api_d")
    # engine unavailable in the test env → status false, render 503
    monkeypatch.delenv("CUTROOM_ENGINE_DIR", raising=False)
    assert client.get("/api/projects/api_d/timeline/engine").json() == {"available": False}
    assert client.post("/api/projects/api_d/timeline/render", json={}).status_code == 503

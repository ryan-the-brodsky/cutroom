"""Hosted demo mode: roles, rate limits, bundle round trip, boot import."""
import http.server
import json
import socketserver
import threading
from pathlib import Path

import pytest

from cutroom import demo


@pytest.fixture()
def demo_client(data_dir, monkeypatch):
    """A demo-mode app: visitors hold `viewer`, the owner holds `admin`."""
    monkeypatch.setenv("CUTROOM_DEMO", "1")
    monkeypatch.setenv("CUTROOM_AUTH_TOKEN", "judge")
    monkeypatch.setenv("CUTROOM_ADMIN_TOKEN", "boss")
    from cutroom import config
    config.reset_settings()
    demo.reset_rate_limits()
    from fastapi.testclient import TestClient
    from cutroom.main import create_app
    with TestClient(create_app()) as c:
        yield c
    config.reset_settings()


VIEWER = {"Authorization": "Bearer judge"}
ADMIN = {"Authorization": "Bearer boss"}


def test_both_tokens_authenticate_but_only_one_is_admin(demo_client):
    assert demo_client.get("/api/system").status_code == 401
    assert demo_client.get("/api/system", headers=VIEWER).json()["role"] == "viewer"
    assert demo_client.get("/api/system", headers=ADMIN).json()["role"] == "admin"
    assert demo_client.get("/api/system", headers=VIEWER).json()["demo"] is True


def test_query_param_token_works_for_the_judge_link(demo_client):
    r = demo_client.get("/api/system?token=judge")
    assert r.status_code == 200 and r.json()["role"] == "viewer"


ADMIN_ONLY = [
    ("post", "/api/backends", {"id": "x", "type": "mock"}),
    ("post", "/api/backends/mock/delete", {}),
    ("post", "/api/projects/p/import", {"src_root": "/tmp"}),
    ("post", "/api/projects/p/lanes", {"lane": "still", "backend": "mock"}),
    ("post", "/api/projects/p/pause", {"paused": True}),
    ("post", "/api/system/pause", {"paused": True}),
    ("post", "/api/projects/p/comps/c/delete", {}),
]


@pytest.mark.parametrize("method,path,body", ADMIN_ONLY)
def test_configuration_is_admin_only(demo_client, method, path, body):
    r = getattr(demo_client, method)(path, json=body, headers=VIEWER)
    assert r.status_code == 403, path
    detail = r.json()["detail"]
    assert "hosted demo" in detail and "reserved" in detail
    # the same call as admin gets past the gate (whatever it then answers)
    r2 = getattr(demo_client, method)(path, json=body, headers=ADMIN)
    assert r2.status_code != 403, path


def test_workers_are_closed_to_viewers(demo_client):
    r = demo_client.post("/api/workers/claim", json={"pools": ["cpu"]},
                         headers=VIEWER)
    assert r.status_code in (401, 403)


def test_creative_work_stays_open_to_viewers(demo_client, tmp_path):
    from cutroom.importer.folder import import_folder
    src = tmp_path / "src"
    (src / "prompts").mkdir(parents=True)
    (src / "prompts/shots.jsonl").write_text(
        '{"id": "B01-S1", "beat": "B01", "act": 1, "type": "HERO", '
        '"seconds": 4, "image_prompt": "a dugout"}\n')
    import_folder(str(src), "p", log=lambda m: None)
    # reading the film, and submitting a free (mock) generation
    assert demo_client.get("/api/projects/p/film", headers=VIEWER).status_code == 200
    r = demo_client.post("/api/projects/p/generate/still",
                         json={"prompt": "a dugout", "backend": "mock",
                               "shot": "B01-S1"}, headers=VIEWER)
    assert r.status_code == 200 and r.json()["job"]


def test_rate_limit_counts_per_token(demo_client, monkeypatch, tmp_path):
    from cutroom import config
    monkeypatch.setattr(config.get_settings(), "demo_jobs_per_min", 3)
    from cutroom.importer.folder import import_folder
    src = tmp_path / "src"
    (src / "prompts").mkdir(parents=True)
    (src / "prompts/shots.jsonl").write_text(
        '{"id": "B01-S1", "beat": "B01", "act": 1, "type": "STILL", '
        '"seconds": 4, "image_prompt": "x"}\n')
    import_folder(str(src), "p", log=lambda m: None)
    body = {"prompt": "x", "backend": "mock", "shot": "B01-S1"}
    codes = [demo_client.post("/api/projects/p/generate/still", json=body,
                              headers=VIEWER).status_code for _ in range(5)]
    assert codes[:3] == [200, 200, 200]
    assert codes[3] == 429
    # a different token has its own bucket
    assert demo_client.post("/api/projects/p/generate/still", json=body,
                            headers=ADMIN).status_code == 200


def test_off_demo_nothing_is_gated(client):
    assert client.get("/api/system").json()["role"] == "admin"
    assert client.get("/api/system").json()["demo"] is False
    assert client.post("/api/backends",
                       json={"id": "zz", "type": "mock"}).status_code == 200


# ------------------------------------------------------------- the bundle


def _synthetic_project(root: Path) -> Path:
    (root / "prompts").mkdir(parents=True)
    (root / "renders/stills").mkdir(parents=True)
    (root / "audio/generated").mkdir(parents=True)
    (root / "assembly").mkdir(parents=True)
    (root / "dashboard/state").mkdir(parents=True)
    (root / "prompts/shots.jsonl").write_text(
        '{"id": "B01-S1", "beat": "B01", "act": 1, "type": "HERO", '
        '"seconds": 4, "image_prompt": "a dugout. A veteran catcher."}\n')
    (root / "prompts/characters.jsonl").write_text(
        '{"id": "CHAR-ross", "character": "David Ross — the veteran catcher"}\n')
    (root / "renders/curation.json").write_text(
        json.dumps({"shots": {"B01-S1": {"keeper": "B01-S1_11.png"}}}))
    (root / "renders/stills/B01-S1_11.png").write_bytes(b"\x89PNG" + b"0" * 64)
    (root / "audio/generated/B01-S1_line.wav").write_bytes(b"RIFF" + b"0" * 64)
    (root / "dashboard/state/overrides-demo.json").write_text(
        json.dumps({"B01-S1": {"seconds": 5.0}}))
    (root / "assembly/cut.mp4").write_bytes(b"0" * 4096)      # must be excluded
    (root / "renders/huge.bin").write_bytes(b"0" * 128)
    return root


def test_bundle_members_exclude_assembly_and_oversized_files(tmp_path):
    src = _synthetic_project(tmp_path / "src")
    rels = [rel for _, rel in demo.bundle_members(src, max_bytes=100)]
    assert "prompts/shots.jsonl" in rels
    assert "prompts/characters.jsonl" in rels
    assert "renders/curation.json" in rels
    assert "dashboard/state/overrides-demo.json" in rels
    assert "renders/stills/B01-S1_11.png" in rels
    assert "audio/generated/B01-S1_line.wav" in rels
    assert not any(r.startswith("assembly/") for r in rels)
    assert "renders/huge.bin" not in rels           # 128 B media > the 100 B cap


def test_bundle_round_trip_imports_a_browsable_project(tmp_path, client):
    src = _synthetic_project(tmp_path / "src")
    out = demo.build_bundle(str(src), str(tmp_path / "bundle.tar.zst"),
                            log=lambda m: None)
    archive = Path(out["path"])
    assert archive.exists() and out["files"] >= 6
    dest = tmp_path / "unpacked"
    demo.extract_bundle(archive, dest, log=lambda m: None)
    assert (dest / "prompts/shots.jsonl").exists()
    assert not (dest / "assembly").exists()

    from cutroom.importer.folder import import_folder
    stats = import_folder(str(dest), "round-trip", log=lambda m: None)
    assert stats["shots"] == 1
    film = client.get("/api/projects/round-trip/film").json()
    assert film[0]["sid"] == "B01-S1"
    assert film[0]["keeper"] == "renders/stills/B01-S1_11.png"
    assert film[0]["seconds"] == 5.0                  # override survived
    cast = client.get("/api/projects/round-trip/cast").json()["cast"]
    assert cast[0]["name"] == "David Ross"


def test_boot_import_downloads_extracts_and_imports(tmp_path, data_dir,
                                                    monkeypatch):
    src = _synthetic_project(tmp_path / "src")
    served = tmp_path / "served"
    served.mkdir()
    demo.build_bundle(str(src), str(served / "bundle.tar.zst"),
                      log=lambda m: None)

    handler = type("H", (http.server.SimpleHTTPRequestHandler,), {
        "directory_": str(served),
        "__init__": lambda self, *a, **kw: http.server.
        SimpleHTTPRequestHandler.__init__(self, *a, directory=str(served), **kw),
        "log_message": lambda *a, **kw: None})
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        monkeypatch.setenv("CUTROOM_DEMO", "1")
        monkeypatch.setenv(
            "CUTROOM_DEMO_BUNDLE", f"http://127.0.0.1:{port}/bundle.tar.zst")
        monkeypatch.setenv("CUTROOM_DEMO_PROJECT", "next-year")
        monkeypatch.setenv("CUTROOM_LANE_STILL", "mock:tiny")
        from cutroom import config
        config.reset_settings()
        from cutroom.db import init_db
        from cutroom.main import seed_backends
        init_db()
        seed_backends()
        out = demo.boot_import()
        httpd.shutdown()

    assert out["imported"]["shots"] == 1
    assert out["project"] == "next-year"
    from cutroom.db import session_scope
    from cutroom.models import Backend, LaneConfig, Project
    with session_scope() as s:
        assert s.get(Project, "next-year")
        assert s.get(Backend, "mock").enabled            # the free fallback
        lc = s.query(LaneConfig).filter_by(project_id="next-year",
                                           lane="still").one()
        assert (lc.backend_id, lc.model) == ("mock", "tiny")
    # idempotent: a second boot with the project present is a no-op
    assert demo.boot_import()["skipped"] == "projects exist"
    assert (data_dir / "logs/boot.log").exists()

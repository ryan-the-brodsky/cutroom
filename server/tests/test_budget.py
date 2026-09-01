"""Spend cap — the rolling 24h ledger and the 402 it raises."""
import time

import pytest

from cutroom import budget, demo


@pytest.fixture()
def demo_budget_client(data_dir, monkeypatch):
    monkeypatch.setenv("CUTROOM_DEMO", "1")
    monkeypatch.setenv("CUTROOM_DEMO_BUDGET_USD", "0.10")
    monkeypatch.setenv("CUTROOM_COST_MOCK", "0")
    from cutroom import config
    config.reset_settings()
    demo.reset_rate_limits()
    from fastapi.testclient import TestClient
    from cutroom.main import create_app
    with TestClient(create_app()) as c:
        _seed_project(c)
        yield c
    config.reset_settings()


def _seed_project(client):
    from cutroom.importer.game7 import import_game7
    import tempfile
    from pathlib import Path
    src = Path(tempfile.mkdtemp()) / "src"
    (src / "prompts").mkdir(parents=True)
    (src / "prompts/shots.jsonl").write_text(
        '{"id": "B01-S1", "beat": "B01", "act": 1, "type": "STILL", '
        '"seconds": 4, "image_prompt": "x"}\n')
    import_game7(str(src), "p", log=lambda m: None)


def test_defaults_and_env_override(data_dir, monkeypatch):
    assert budget.default_cost("mock", "mock") == 0.0
    assert budget.default_cost("local-comfyui", "comfyui") == 0.0
    assert budget.default_cost("openrouter-image", "openrouter-image") == 0.04
    assert budget.default_cost("fal", "fal") == 0.05
    assert budget.default_cost("elevenlabs", "elevenlabs") == 0.02
    # unknown id falls through to the adapter type
    assert budget.default_cost("my-vm-comfy", "comfyui") == 0.0
    monkeypatch.setenv("CUTROOM_COST_OPENROUTER_IMAGE", "0.11")
    assert budget.default_cost("openrouter-image", "openrouter-image") == 0.11


def test_seeded_backends_carry_a_cost(client):
    rows = {b["id"]: b for b in client.get("/api/backends").json()}
    assert rows["mock"]["options"]["cost_usd"] == 0.0
    assert rows["fal"]["options"]["cost_usd"] == 0.05
    assert rows["openrouter"]["options"]["model"] == "z-ai/glm-5.3-flash"
    assert budget.cost_usd("mock") == 0.0
    assert budget.cost_usd("fal") == 0.05
    assert budget.cost_usd("nope") == 0.0
    assert budget.is_paid("fal") and not budget.is_paid("mock")


def test_ledger_accumulates_and_ages_out(client):
    assert budget.spent_24h() == 0.0
    budget.charge("fal", 3, "p", "job1")            # 3 × $0.05
    assert budget.spent_24h() == pytest.approx(0.15)
    budget.charge("mock", 10, "p", "job2")          # free: never recorded
    assert budget.spent_24h() == pytest.approx(0.15)
    # a row older than the window drops out on the next write
    import json
    path = data_dir_of()
    rows = json.loads(path.read_text())
    rows[0]["t"] = time.time() - 25 * 3600
    path.write_text(json.dumps(rows))
    assert budget.spent_24h() == 0.0


def data_dir_of():
    from cutroom.config import get_settings
    return get_settings().data_dir / "spend-ledger.json"


def test_state_reports_spent_and_limit(client):
    budget.charge("fal", 1)
    st = budget.state()
    assert st["spent"] == pytest.approx(0.05)
    assert st["limit"] == 10.0                       # the default cap


def test_402_when_the_cap_is_reached(demo_budget_client):
    # cap is $0.10; fal costs $0.05/take, so two takes fit and a third does not
    from cutroom.db import session_scope
    from cutroom.models import Backend
    with session_scope() as s:
        s.get(Backend, "fal").enabled = True
        s.get(Backend, "fal").api_key = "x"

    body = {"prompt": "x", "shot": "B01-S1", "backend": "fal",
            "params": {}, "seeds": [1]}
    assert demo_budget_client.post("/api/projects/p/generate/motion",
                                   json=body).status_code == 200
    budget.charge("fal", 2)                          # simulate the takes landing
    r = demo_budget_client.post("/api/projects/p/generate/motion", json=body)
    assert r.status_code == 402
    d = r.json()
    assert "demo budget exhausted" in d["detail"]
    assert d["spent"] == pytest.approx(0.10)
    assert d["budget"] == 0.10
    assert d["backend"] == "fal"
    # ...and mock keeps working, which is what the error tells you to do
    assert demo_budget_client.post(
        "/api/projects/p/generate/still",
        json={"prompt": "x", "shot": "B01-S1", "backend": "mock"}
    ).status_code == 200


def test_no_cap_off_demo(client):
    budget.charge("fal", 1000)                       # $50, way over the $10 cap
    from cutroom.db import session_scope
    from cutroom.models import Backend
    with session_scope() as s:
        s.get(Backend, "fal").enabled = True
        s.get(Backend, "fal").api_key = "x"
    _seed_project(client)
    r = client.post("/api/projects/p/generate/motion",
                    json={"prompt": "x", "shot": "B01-S1", "backend": "fal"})
    assert r.status_code == 200                      # a self-host is uncapped


def test_record_take_charges_the_ledger(client):
    from cutroom.jobs.handlers import record_take
    _seed_project(client)
    record_take("p", "B01-S1", "motion", "renders/motion/x.webm",
                backend_id="fal", job_id="j1")
    record_take("p", "B01-S1", "still", "renders/stills/y.png",
                backend_id="mock", job_id="j2")
    record_take("p", "B01-S1", "still", "renders/stills/z.png")   # imported
    assert budget.spent_24h() == pytest.approx(0.05)

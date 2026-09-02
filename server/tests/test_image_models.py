"""The still lane's model registry: the endpoint, key resolution, and the
cost a take records when a pricier model drew it.

The bake-off behind the numbers is docs/research/image-models/RESULTS.md.
"""
import pytest

from cutroom.adapters import image_models as im


# ------------------------------------------------------------------ registry

def test_registry_records_carry_price_registers_and_a_fallback():
    rows = im.all_models()
    assert [m["key"] for m in rows] == ["flash", "pro", "flash3"]
    keys = {m["key"] for m in rows}
    for m in rows:
        assert m["cost_per_still_usd"] > 0
        assert m["fallback"] in keys and m["fallback"] != m["key"]
        assert m["failure_modes"]
        assert set(m["registers"]) <= set(im.REGISTERS)
    # the default is the cheap one, and it is NOT the one that spells
    assert im.DEFAULT_MODEL_KEY == "flash"
    assert "legible_text" not in im.get_model("flash")["registers"]
    assert "legible_text" in im.get_model(im.TEXT_MODEL_KEY)["registers"]
    # pro is the expensive one, measured
    assert im.cost_for("pro") > im.cost_for("flash") * 3


def test_key_resolution_and_pass_through():
    assert im.resolve_id("pro") == "google/gemini-3-pro-image"
    assert im.resolve_id("flash") == "google/gemini-2.5-flash-image"
    # a full id resolves to itself
    assert im.resolve_id("google/gemini-3-pro-image") == "google/gemini-3-pro-image"
    # an operator may still name a model the registry has never heard of
    assert im.resolve_id("some/other-image-model") == "some/other-image-model"
    assert im.resolve_id(None) is None
    assert im.get_model("nope") is None
    # an unknown model has no measured price, so it falls to the caller's
    assert im.cost_for("some/other-image-model", default=0.04) == 0.04


def test_env_narrows_the_registry(monkeypatch):
    monkeypatch.setenv("CUTROOM_IMAGE_MODELS", "flash")
    assert [m["key"] for m in im.all_models()] == ["flash"]
    # narrowing hides a model from the list but never breaks resolution
    assert im.resolve_id("pro") == "google/gemini-3-pro-image"


def test_text_detector_and_hint():
    assert im.wants_text("two monitors showing the word GOODBYE")
    assert im.wants_text("a hand-painted sign over the door")
    assert im.wants_text(None, "the title card reads FIN")
    assert not im.wants_text("a boy on a bicycle at dusk")
    assert not im.wants_text(None, None)
    hint = im.text_hint("flash")
    assert hint and 'model:"pro"' in hint and "$0.14" in hint
    # the model that already spells is not told to switch
    assert im.text_hint("pro") is None


# ------------------------------------------------------------------ endpoints

def test_image_models_endpoint(client):
    d = client.get("/api/image-models").json()
    assert d["default"] == "flash" and d["text_model"] == "pro"
    assert "legible_text" in d["registers"]
    assert 'model:"pro"' in d["doctrine"]
    by_key = {m["key"]: m for m in d["models"]}
    assert by_key["pro"]["id"] == "google/gemini-3-pro-image"
    assert by_key["flash"]["cost_per_still_usd"] == pytest.approx(0.0387)
    assert by_key["pro"]["cost_per_still_usd"] == pytest.approx(0.1387)


def test_backend_model_list_offers_the_registry_with_prices(client):
    d = client.get("/api/backends/openrouter-image/models?lane=still").json()
    ids = [m["id"] for m in d["models"]]
    assert "google/gemini-3-pro-image" in ids
    pro = next(m for m in d["models"] if m["key"] == "pro")
    # the picker shows a real choice, with what it costs, not "default"
    assert "$0.139/still" in pro["label"] and "legible_text" in pro["label"]


def test_backends_row_carries_the_image_registry(client):
    row = {b["id"]: b for b in client.get("/api/backends").json()}["openrouter-image"]
    assert [m["key"] for m in row["image_models"]] == ["flash", "pro", "flash3"]
    assert row["image_model"] == "google/gemini-2.5-flash-image"


# -------------------------------------------------------------- cost on takes

def test_take_records_the_model_price_and_spend_follows(client, data_dir):
    """A pro still costs three and a half flash stills. The take carries the
    number, the ledger charges it, and /spend adds it up per model instead of
    pricing every still at the backend's one flat guess."""
    from cutroom import budget
    from cutroom.jobs.handlers import record_take
    from tests.test_budget import _seed_project
    _seed_project(client)

    record_take("p", "B01-S1", "still", "renders/stills/a.png",
                backend_id="openrouter-image",
                model="google/gemini-2.5-flash-image", cost_usd=0.0387)
    record_take("p", "B01-S1", "still", "renders/stills/b.png",
                backend_id="openrouter-image",
                model="google/gemini-3-pro-image", cost_usd=0.1387,
                job_id="j2")

    assert budget.spent_24h() == pytest.approx(0.1774, abs=1e-4)
    spend = client.get("/api/projects/p/spend").json()
    assert spend["total_usd"] == pytest.approx(0.1774, abs=1e-4)
    assert spend["by_lane"]["still"]["calls"] == 2
    # the flat per-backend figure is still reported, and is not what was billed
    assert spend["by_backend"]["openrouter-image"]["cost_usd"] == 0.04

    # the price rides on the take itself, which is what /spend reads back
    from cutroom.db import session_scope
    from cutroom.models import Take
    with session_scope() as s:
        priced = {t.model: (t.params or {}).get("cost_usd")
                  for t in s.query(Take).filter_by(project_id="p")}
    assert priced["google/gemini-3-pro-image"] == pytest.approx(0.1387)
    assert priced["google/gemini-2.5-flash-image"] == pytest.approx(0.0387)


def test_a_take_with_no_recorded_price_still_uses_the_backend_figure(client):
    from cutroom import budget
    from cutroom.jobs.handlers import record_take
    from tests.test_budget import _seed_project
    _seed_project(client)

    record_take("p", "B01-S1", "still", "renders/stills/c.png",
                backend_id="openrouter-image", model="whatever")
    assert budget.spent_24h() == pytest.approx(0.04)
    assert client.get("/api/projects/p/spend").json()["total_usd"] == \
        pytest.approx(0.04)

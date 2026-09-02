"""Motion profiles (the live window is a backend property) and /spend.

Doctrine 2026-09-02: a clip plays in FULL for the backend's own clip length.
`freeze_after` is a repair tool a caller asks for, never a default.
"""
import pytest

from cutroom.adapters import motion_models as mm
from cutroom.adapters import motion_profiles as mp
from cutroom.adapters.queue_apis import _duration_value, payload_map


# ------------------------------------------------------------------ profiles

def test_local_rig_keeps_its_one_second_ceiling_as_advice():
    p = mp.profile_for({}, "comfyui")
    assert mp.live_default(p) == 1.0          # what LTX holds
    assert mp.seconds_default(p) == 2.0       # what a clip still plays for
    assert mp.fps_of(p) == 24
    assert mp.clip_cost(p) == 0.0


def test_wan_turbo_is_a_fixed_five_second_clip():
    p = mp.profile_for({"model": "fal-ai/wan/v2.2-a14b/image-to-video/turbo"},
                       "fal")
    assert mp.seconds_default(p) == 5.0
    assert mp.seconds_max(p) == 5.0
    # the turbo endpoint has no duration field, so 3s still bills a whole clip
    assert mp.clamp_seconds(p, 3) == 5.0
    assert mp.clip_cost(p, 3) == 0.05
    assert mp.frames_for_seconds(p, 5) == 81


def test_per_second_models_bill_the_length_you_ask_for():
    p = mp.profile_for({"model": "seedance"}, "fal")      # a registry key works
    assert mp.clip_cost(p, 5) == pytest.approx(0.108, abs=1e-4)
    assert mp.clip_cost(p, 3) == pytest.approx(0.0648, abs=1e-4)
    assert mp.clamp_seconds(p, 99) == 12.0


def test_a_stored_profile_partially_overrides_the_model_table():
    p = mp.profile_for({"model": "fal-ai/wan/v2.2-a14b/image-to-video/turbo",
                        "motion_profile": {"seconds_max": 3.0}}, "fal")
    assert mp.seconds_max(p) == 3.0
    assert p["cost_per_clip_usd"] == 0.05      # the rest of the table survives


def test_unknown_models_assume_the_cautious_local_ceiling():
    p = mp.profile_for({"model": "some/brand-new-model"}, "fal")
    assert mp.seconds_default(p) == 2.0
    assert "assuming" in p["note"]


def test_env_override_wins(monkeypatch):
    monkeypatch.setenv("CUTROOM_MOTION_PROFILE_FAL",
                       '{"seconds_default": 4.0, "cost_per_clip_usd": 0.01}')
    prof = mp.default_profile_for_row("fal", "fal", "fal-ai/ltx-video")
    assert prof == {"seconds_default": 4.0, "cost_per_clip_usd": 0.01}


def test_seconds_and_frames_round_trip():
    p = mp.profile_for({}, "comfyui")
    assert mp.frames_for_seconds(p, 2.0) == 49            # 8k+1 at 24 fps
    assert mp.frames_for_seconds(p, 4.0) == 97
    assert mp.seconds_for_frames(p, 49) == pytest.approx(2.042, abs=1e-3)


# ---------------------------------------------------------- fal payload maps

def test_payload_maps_speak_each_endpoints_own_dialect():
    seed = payload_map("fal-ai/bytedance/seedance/v1/pro/fast/image-to-video")
    turbo = payload_map("fal-ai/wan/v2.2-a14b/image-to-video/turbo")
    assert _duration_value(seed, 3.4) == "3"        # string seconds, 2-12
    assert _duration_value(seed, 99) == "12"        # clamped to the ceiling
    assert seed["defaults"]["camera_fixed"] is True
    assert turbo["duration_key"] is None            # no duration field at all
    assert turbo["negative_key"] is None            # and no negative prompt
    assert payload_map("fal-ai/nothing-like-this") == {}
    # the maps come from the registry, so they cover exactly its models
    assert set(payload_map.__globals__["motion_models"].payload_maps()) == {
        m["id"] for m in mm.all_models(include_disabled=True)}


# ------------------------------------------------------------------ seeding

def test_seeded_motion_backends_carry_a_profile(client):
    rows = {b["id"]: b for b in client.get("/api/backends").json()}
    comfy = rows["local-comfyui"]
    assert "motion" in comfy["lanes"]
    assert comfy["motion_profile"]["live_seconds_default"] == 1.0
    assert "1s" in comfy["motion_profile_summary"] or \
        "holds ~1s" in comfy["motion_profile_summary"]
    assert rows["fal"]["motion_profile"]["seconds_default"] > 0
    # a lane that never animates carries no profile
    assert "motion_profile" not in rows["elevenlabs"]


# ------------------------------------------------------------------ /spend

def _seed(client, tmp_path):
    from cutroom.importer.folder import import_folder
    src = tmp_path / "src"
    (src / "prompts").mkdir(parents=True)
    (src / "prompts/shots.jsonl").write_text(
        '{"id": "B01-S1", "beat": "B01", "act": 1, "type": "HERO", '
        '"seconds": 6, "image_prompt": "x", "motion_prompt": "one burst"}\n'
        '{"id": "B02-S1", "beat": "B02", "act": 2, "type": "STILL", '
        '"seconds": 3, "image_prompt": "y"}\n')
    import_folder(str(src), "sp", log=lambda m: None)


def test_spend_is_empty_before_anything_is_generated(client, tmp_path):
    _seed(client, tmp_path)
    d = client.get("/api/projects/sp/spend").json()
    assert d["total_usd"] == 0.0
    assert d["takes"] == 0
    assert d["by_lane"] == {} and d["by_backend"] == {}


def test_spend_prices_takes_by_backend_and_lane(client, tmp_path):
    _seed(client, tmp_path)
    from cutroom.jobs.handlers import record_take
    # one paid still, one paid motion job that records BOTH a crop and the
    # composite from a single adapter call, plus a free local clip
    record_take("sp", "B01-S1", "still", "renders/stills/a.png",
                backend_id="fal", model="m", seed=1, job_id="j1")
    record_take("sp", "B01-S1", "crop", "renders/motion/tests/a.webm",
                backend_id="fal", model="m", seed=2, job_id="j2")
    record_take("sp", "B01-S1", "motion", "renders/fx/a.mp4",
                backend_id="fal", model="m", seed=2, job_id="j2")
    record_take("sp", "B02-S1", "motion", "renders/fx/b.mp4",
                backend_id="local-comfyui", model="ltx", seed=3, job_id="j3")
    record_take("sp", "B02-S1", "still", "renders/stills/imported.png")

    d = client.get("/api/projects/sp/spend").json()
    # two billable calls at $0.05, NOT three: the crop and the composite are
    # one generation
    assert d["total_usd"] == pytest.approx(0.10, abs=1e-6)
    assert d["takes"] == 2
    assert d["by_lane"]["still"]["calls"] == 1
    assert d["by_lane"]["motion"]["calls"] == 1
    assert d["by_backend"]["fal"]["usd"] == pytest.approx(0.10, abs=1e-6)
    assert "local-comfyui" not in d["by_backend"]     # free never shows up
    assert d["ledger_24h_usd"] >= 0.0


def test_spend_404s_for_a_project_that_does_not_exist(client):
    assert client.get("/api/projects/nope/spend").status_code == 404


# --------------------------------------------------- generate/motion seconds

def test_generate_motion_resolves_seconds_and_never_freezes_by_default(
        client, tmp_path, monkeypatch):
    _seed(client, tmp_path)
    from cutroom.api import generate as g
    monkeypatch.setattr(g.budget, "resolve_backend_id",
                        lambda *a, **k: "local-comfyui")
    body = g.apply_motion_profile("sp", "motion", {"plate": "p.png",
                                                   "prompt": "x"})
    assert body["seconds"] == 2.0
    assert body["frames"] == 49
    assert "freeze_after" not in body            # clips play in full
    assert body["motion_profile"]["backend"] == "local-comfyui"


def test_generate_motion_honours_an_explicit_live_window(client, tmp_path,
                                                         monkeypatch):
    _seed(client, tmp_path)
    from cutroom.api import generate as g
    monkeypatch.setattr(g.budget, "resolve_backend_id",
                        lambda *a, **k: "local-comfyui")
    body = g.apply_motion_profile(
        "sp", "motion", {"plate": "p.png", "prompt": "x", "seconds": 4,
                         "live_seconds": 1.2})
    assert body["frames"] == 97
    assert body["freeze_after"] == 1.2
    assert "live_seconds" not in body

    # and clamps a live window past what the backend holds
    clamped = g.apply_motion_profile(
        "sp", "motion", {"plate": "p.png", "prompt": "x", "live_seconds": 9})
    assert clamped["freeze_after"] == 1.5


def test_generate_motion_leaves_other_lanes_alone(client, tmp_path):
    _seed(client, tmp_path)
    from cutroom.api import generate as g
    body = g.apply_motion_profile("sp", "still", {"prompt": "x"})
    assert body == {"prompt": "x"}


# ----------------------------------------------------- motion model registry

def test_registry_seeds_exactly_seedance_then_wan():
    rows = mm.all_models()
    assert [m["key"] for m in rows] == ["seedance", "wan"]
    assert [m["rank"] for m in rows] == [1, 2]
    assert rows[0]["note"] == "best when budget allows"
    assert "dark close-ups" in rows[1]["note"]
    # the models the bake-off rejected are gone from the code, not the history
    ids = " ".join(m["id"] for m in mm.all_models(include_disabled=True))
    assert "pixverse" not in ids


def test_every_record_carries_a_failure_mode_and_a_fallback():
    for m in mm.all_models():
        assert m["failure_modes"]
        assert mm.get_model(m["fallback"]) is not None
        assert set(m["registers"]) <= set(mm.REGISTERS)
    assert mm.get_model("seedance")["fallback"] == "wan"
    assert mm.get_model("wan")["fallback"] == "seedance"


def test_a_short_key_resolves_to_an_endpoint_id():
    assert mm.resolve_id("wan") == "fal-ai/wan/v2.2-a14b/image-to-video/turbo"
    assert mm.resolve_id("seedance").endswith("seedance/v1/pro/fast/image-to-video")
    assert mm.resolve_id("fal-ai/anything/else") == "fal-ai/anything/else"
    assert mm.resolve_id(None) is None


def test_cost_follows_the_billing_model():
    seed, wan = mm.get_model("seedance"), mm.get_model("wan")
    assert mm.cost_for(seed, 5) == pytest.approx(0.108, abs=1e-4)
    assert mm.cost_for(seed, 3) == pytest.approx(0.0648, abs=1e-4)   # per second
    assert mm.cost_for(wan, 5) == 0.05
    assert mm.cost_for(wan, 3) == 0.05                               # per clip


# --- planner model choice under three budgets

def test_comfortable_budget_buys_the_rank_one_model():
    m, why = mm.pick_model(2.00, 5.0)
    assert m["key"] == "seedance"
    assert "best when budget allows" in why


def test_thin_budget_degrades_to_wan_instead_of_dropping_the_shot():
    m, why = mm.pick_model(0.06, 5.0)
    assert m["key"] == "wan"
    assert "$0.06 left" in why
    # and below the cheapest clip it refuses honestly
    none, reason = mm.pick_model(0.01, 5.0)
    assert none is None and "cheapest is $0.050" in reason


def test_mixed_run_spends_down_from_seedance_to_wan():
    """A real plan: the budget drains, the model degrades, nothing is dropped."""
    budget, picks = 0.30, []
    while True:
        m, _ = mm.pick_model(budget, 5.0)
        if m is None:
            break
        picks.append(m["key"])
        budget = round(budget - mm.cost_for(m, 5.0), 4)
    assert picks == ["seedance", "seedance", "wan"]
    assert budget == pytest.approx(0.034, abs=1e-4)


def test_a_register_a_model_won_beats_rank():
    # Wan won dark close-ups, so it takes them even with money to spare
    m, why = mm.pick_model(2.00, 5.0, register="dialogue_closeup")
    assert m["key"] == "wan" and "dark close-ups" in why
    # legible text is Seedance's, and rank agrees
    assert mm.pick_model(2.00, 5.0, register="legible_text")[0]["key"] == "seedance"
    # but a thin budget still overrides the preference
    assert mm.pick_model(0.06, 5.0, register="legible_text")[0]["key"] == "wan"


def test_unfaithful_hint_names_the_other_model():
    seed = mm.unfaithful_hint("seedance", "a dark close-up")
    assert 'model:"wan"' in seed and "brighter room" in seed
    wan = mm.unfaithful_hint("wan")
    assert 'model:"seedance"' in wan and "fine text" in wan
    assert mm.unfaithful_hint("nothing-registered") is None


def test_motion_models_endpoint(client):
    d = client.get("/api/motion-models").json()
    assert [m["key"] for m in d["models"]] == ["seedance", "wan"]
    assert d["default"] == "wan"          # the cheap floor the demo runs on
    assert set(d["registers"]) == set(mm.REGISTERS)
    assert "switch to the registry's fallback" in d["doctrine"]
    # payload maps are adapter plumbing, not part of the public record
    assert all("payload_map" not in m for m in d["models"])
    assert all(m["cost"] and m["failure_modes"] for m in d["models"])


def test_backends_carry_the_registry_on_the_fal_row(client):
    rows = {b["id"]: b for b in client.get("/api/backends").json()}
    fal = rows["fal"]["motion_profile"]
    assert [m["key"] for m in fal["models"]] == ["seedance", "wan"]
    # a local rig serves one model, so it gets no registry
    assert "models" not in rows["local-comfyui"]["motion_profile"]


def test_env_can_narrow_the_registry(monkeypatch):
    monkeypatch.setenv("CUTROOM_MOTION_MODELS", "wan")
    assert [m["key"] for m in mm.all_models()] == ["wan"]
    assert mm.pick_model(2.00, 5.0)[0]["key"] == "wan"


def test_a_per_request_model_reprices_the_profile(client, tmp_path,
                                                  monkeypatch):
    _seed(client, tmp_path)
    from cutroom.api import generate as g
    monkeypatch.setattr(g.budget, "resolve_backend_id", lambda *a, **k: "fal")
    body = g.apply_motion_profile("sp", "motion",
                                  {"plate": "p.png", "prompt": "x",
                                   "model": "seedance", "seconds": 5})
    # the short key is resolved for the adapter, and the profile follows it
    assert body["model"].endswith("seedance/v1/pro/fast/image-to-video")
    assert body["motion_profile"]["seconds_max"] == 12.0

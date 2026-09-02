"""Motion profiles (the live window is a backend property) and /spend.

Doctrine 2026-09-02: a clip plays in FULL for the backend's own clip length.
`freeze_after` is a repair tool a caller asks for, never a default.
"""
import pytest

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
    p = mp.profile_for({"model": "fal-ai/pixverse/v6/image-to-video"}, "fal")
    assert mp.clip_cost(p, 5) == pytest.approx(0.175, abs=1e-4)
    assert mp.clip_cost(p, 3) == pytest.approx(0.105, abs=1e-4)
    assert mp.clamp_seconds(p, 99) == 15.0


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
    v6 = payload_map("fal-ai/pixverse/v6/image-to-video")
    v45 = payload_map("fal-ai/pixverse/v4.5/image-to-video")
    seed = payload_map("fal-ai/bytedance/seedance/v1/pro/fast/image-to-video")
    turbo = payload_map("fal-ai/wan/v2.2-a14b/image-to-video/turbo")
    assert _duration_value(v6, 3.4) == 3            # integer seconds
    assert _duration_value(v45, 3.4) == "5"         # string, enum 5 or 8
    assert _duration_value(seed, 3.4) == "3"
    assert turbo["duration_key"] is None            # no duration field at all
    assert turbo["negative_key"] is None            # and no negative prompt
    assert v6["defaults"]["style"] == "anime"
    assert seed["defaults"]["camera_fixed"] is True
    assert payload_map("fal-ai/nothing-like-this") == {}


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

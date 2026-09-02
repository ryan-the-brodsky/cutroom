"""The per-shot audio plan: what the Shot Editor monitor should play under
one shot, using the same placement the assembler cuts with."""
import pytest

from conftest import make_image, make_wav

from cutroom.storage import get_storage


PID = "hearfilm"
SIDS = ("B01-S1", "B01-S2", "B01-S3")


@pytest.fixture()
def film(client):
    """Three 3-second shots, each with a still, so every window is exact."""
    client.post("/api/projects", json={"id": PID, "label": "Hear film"})
    store = get_storage().project(PID)
    for sid in SIDS:
        client.post(f"/api/projects/{PID}/shots", json={
            "sid": sid, "beat": "B01", "act": 1, "seconds": 3.0,
            "image_prompt": sid})
        make_image(store.resolve(f"renders/stills/{sid}_a.png"), 320, 192)
    return store


def plan(client, sid: str) -> dict:
    r = client.get(f"/api/projects/{PID}/shots/{sid}/audio-plan")
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------ windows

def test_shot_windows_come_from_the_compiled_timeline(client, film):
    for i, sid in enumerate(SIDS):
        p = plan(client, sid)
        assert p["shot_start"] == pytest.approx(i * 3.0)
        assert p["seconds"] == pytest.approx(3.0)
        assert p["vo"] is None and p["music"] == [] and p["sfx"] == []


def test_missing_shot_is_404(client, film):
    assert client.get(f"/api/projects/{PID}/shots/NOPE/audio-plan").status_code == 404


# ---------------------------------------------------------------------- VO

def test_vo_sits_at_head_pad_plus_offset(client, film):
    make_wav(film.resolve("audio/generated/B01-S2_call.wav"), seconds=1.2)
    client.post(f"/api/projects/{PID}/shots/B01-S2/override",
                json={"vo_offset": 0.5})
    p = plan(client, "B01-S2")
    assert p["vo"]["path"] == "audio/generated/B01-S2_call.wav"
    assert p["vo"]["at"] == pytest.approx(0.8, abs=0.03)   # 0.3 head pad + 0.5
    assert p["vo"]["duration"] == pytest.approx(1.2, abs=0.05)
    assert p["vo"]["muted"] is False
    # and it belongs to that shot only
    assert plan(client, "B01-S1")["vo"] is None


def test_muted_vo_is_reported_not_hidden(client, film):
    make_wav(film.resolve("audio/generated/B01-S2_call.wav"), seconds=1.2)
    client.post(f"/api/projects/{PID}/shots/B01-S2/override",
                json={"mute_vo": True, "vo_offset": 0.25})
    p = plan(client, "B01-S2")
    assert p["vo"]["muted"] is True
    assert p["vo"]["at"] == pytest.approx(0.55, abs=0.03)


# -------------------------------------------------------------------- music

def test_bed_spanning_three_shots_reports_offset_into_file(client, film):
    make_wav(film.resolve("audio/music/bed.wav"), seconds=12.0, freq=220.0)
    client.post(f"/api/projects/{PID}/cues", json={
        "kind": "music", "path": "audio/music/bed.wav", "start": 0.0,
        "duration": 12.0, "gain": -8, "fade_in": 0.5, "fade_out": 1.5,
        "label": "opening bed"})

    first = plan(client, "B01-S1")["music"][0]
    assert first["at"] == 0.0 and first["offset_into_file"] == 0.0
    assert first["duration_in_shot"] == pytest.approx(3.0)

    third = plan(client, "B01-S3")["music"][0]
    assert third["at"] == 0.0
    assert third["offset_into_file"] == pytest.approx(6.0)   # two shots in
    assert third["duration_in_shot"] == pytest.approx(3.0)
    # gain and fades pass straight through
    assert third["gain_db"] == -8.0
    assert third["fade_in"] == 0.5 and third["fade_out"] == 1.5
    assert third["label"] == "opening bed"
    assert third["loop"] is False


def test_a_cue_outside_the_window_is_excluded(client, film):
    make_wav(film.resolve("audio/music/tail.wav"), seconds=2.0, freq=330.0)
    client.post(f"/api/projects/{PID}/cues", json={
        "kind": "music", "path": "audio/music/tail.wav", "start": 7.0,
        "duration": 2.0})
    assert plan(client, "B01-S1")["music"] == []
    assert plan(client, "B01-S2")["music"] == []
    third = plan(client, "B01-S3")["music"]
    assert len(third) == 1 and third[0]["at"] == pytest.approx(1.0)


# ---------------------------------------------------------------------- SFX

def test_sfx_anchored_to_a_shot_fires_only_under_it(client, film):
    make_wav(film.resolve("audio/sfx/door.wav"), seconds=0.8, freq=880.0)
    client.post(f"/api/projects/{PID}/cues", json={
        "kind": "sfx", "path": "audio/sfx/door.wav", "shot": "B01-S2",
        "offset": 0.4, "gain": -3, "label": "door"})
    assert plan(client, "B01-S1")["sfx"] == []
    assert plan(client, "B01-S3")["sfx"] == []
    hit = plan(client, "B01-S2")["sfx"]
    assert len(hit) == 1
    assert hit[0]["at"] == pytest.approx(0.4)
    assert hit[0]["offset_into_file"] == 0.0
    assert hit[0]["gain_db"] == -3.0
    assert hit[0]["label"] == "door"


def test_a_looping_bed_wraps_its_offset_into_the_file(client, film):
    make_wav(film.resolve("audio/music/loop.wav"), seconds=2.0, freq=110.0)
    client.post(f"/api/projects/{PID}/cues", json={
        "kind": "music", "path": "audio/music/loop.wav", "start": 0.0,
        "duration": 9.0, "loop": True})
    third = plan(client, "B01-S3")["music"][0]
    assert third["loop"] is True
    # 6s into a 2s file → back at the top
    assert third["offset_into_file"] == pytest.approx(0.0, abs=0.05)

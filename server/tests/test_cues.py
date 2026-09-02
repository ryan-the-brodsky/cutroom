"""Music / SFX cues: the API, the record shape, and — the one that matters —
proof that a cue is AUDIBLE in the assembled cut."""
import subprocess
import wave

import numpy as np
import pytest

from conftest import make_image, make_wav

from cutroom import cues as C
from cutroom.db import session_scope
from cutroom.engine import assemble
from cutroom.models import Project


# ---------------------------------------------------------------- helpers

def rms_window(video, start: float, seconds: float, tmp_path) -> float:
    """RMS of the mixed audio in [start, start+seconds) of a rendered file."""
    out = tmp_path / f"win-{start}-{seconds}.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start}",
                    "-t", f"{seconds}", "-i", str(video),
                    "-ac", "1", "-ar", "44100", str(out)], check=True)
    with wave.open(str(out)) as w:
        raw = w.readframes(w.getnframes())
    if not raw:
        return 0.0
    x = np.frombuffer(raw, np.int16).astype(np.float64) / 32768.0
    return float(np.sqrt(np.mean(x * x)))


@pytest.fixture()
def film_project(client, tmp_path):
    """A two-shot project with a real image so the assembler has picture."""
    client.post("/api/projects", json={"id": "cuefilm", "label": "Cue film"})
    for i, sid in enumerate(("B01-S1", "B01-S2")):
        client.post("/api/projects/cuefilm/shots", json={
            "sid": sid, "beat": "B01", "act": 1, "seconds": 3.0,
            "image_prompt": f"shot {i}"})
    return "cuefilm"


# ---------------------------------------------------------------- record shape

def test_gain_is_decibels_and_parses_the_importer_hint():
    assert C.parse_gain_db(-16) == -16.0
    assert C.parse_gain_db("-18dB bed, swell on the homer") == -18.0
    assert C.parse_gain_db("0dB hero") == 0.0
    assert C.parse_gain_db(None, -14.0) == -14.0


def test_normalize_accepts_the_importers_music_row():
    row = {"music-file": "audio/music/01.mp3", "beats": "B01-B02",
           "shots": ["B01", "B02"], "duration_s": 20,
           "gain-hint": "-16dB under narration"}
    cue = C.normalize("music", row)
    assert cue["path"] == "audio/music/01.mp3"
    assert cue["shot"] == "B01"          # first anchor wins
    assert cue["duration"] == 20.0
    assert cue["gain"] == -16.0
    assert cue["id"].startswith("cue_")


def test_normalize_accepts_the_importers_sfx_row():
    cue = C.normalize("sfx", {"shot": "B01-S1", "sfx-file": "audio/sfx/a.mp3",
                              "offset": 0.3, "gain-hint": "-8dB accent"})
    assert (cue["shot"], cue["offset"], cue["gain"]) == ("B01-S1", 0.3, -8.0)
    assert "start" not in cue           # shot-anchored, not absolute


def test_normalize_rejects_a_pathless_cue_and_an_unbounded_loop():
    with pytest.raises(C.CueError):
        C.normalize("music", {"start": 1})
    with pytest.raises(C.CueError):
        C.normalize("music", {"path": "a.mp3", "loop": True})


# ---------------------------------------------------------------- the API

def test_cue_crud_round_trip(client, film_project):
    pid = film_project
    assert client.get(f"/api/projects/{pid}/cues").json() == {"music": [],
                                                              "sfx": []}
    r = client.post(f"/api/projects/{pid}/cues", json={
        "kind": "music", "path": "audio/music/theme.mp3", "start": 0,
        "duration": 6, "gain": -16, "fade_in": 0.5, "fade_out": 1.0})
    assert r.status_code == 200, r.text
    cue_id = r.json()["cue"]["id"]
    assert r.json()["exists"] is False           # the file is not there yet

    r = client.post(f"/api/projects/{pid}/cues", json={
        "kind": "sfx", "path": "audio/sfx/door.mp3", "shot": "B01-S2",
        "offset": 0.25})
    assert r.json()["at"] == pytest.approx(3.25)  # shot 2 starts at 3.0s

    sheet = client.get(f"/api/projects/{pid}/cues").json()
    assert [c["path"] for c in sheet["music"]] == ["audio/music/theme.mp3"]
    assert sheet["sfx"][0]["gain"] == -8.0        # the SFX default
    assert sheet["music"][0]["fade_out"] == 1.0

    assert client.post(f"/api/projects/{pid}/cues/{cue_id}/delete").json()["ok"]
    assert client.get(f"/api/projects/{pid}/cues").json()["music"] == []
    assert client.post(f"/api/projects/{pid}/cues/{cue_id}/delete"
                       ).status_code == 404


def test_moving_a_shot_anchored_cue_keeps_its_anchor(client, film_project):
    """The move rewrites `offset`, not the anchor: the cue still travels with
    its shot when the cut re-times, which is what the assembler honors."""
    pid = film_project
    cue_id = client.post(f"/api/projects/{pid}/cues", json={
        "kind": "sfx", "path": "audio/sfx/door.mp3", "shot": "B01-S2",
        "offset": 0.25}).json()["cue"]["id"]

    r = client.post(f"/api/projects/{pid}/cues/{cue_id}/move", json={"at": 4.5})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["at"] == pytest.approx(4.5)
    assert body["previous_at"] == pytest.approx(3.25)
    assert body["cue"]["shot"] == "B01-S2"       # anchor kept
    assert body["cue"]["offset"] == pytest.approx(1.5)   # shot 2 starts at 3.0s
    assert "start" not in body["cue"]

    # …and `delta` slides it from wherever it now sits.
    r = client.post(f"/api/projects/{pid}/cues/{cue_id}/move", json={"delta": -1})
    assert r.json()["at"] == pytest.approx(3.5)
    sheet = client.get(f"/api/projects/{pid}/cues").json()
    assert sheet["sfx"][0]["at"] == pytest.approx(3.5)
    assert sheet["sfx"][0]["gain"] == -8.0       # nothing else was touched


def test_moving_an_absolute_cue_rewrites_its_start(client, film_project):
    pid = film_project
    cue_id = client.post(f"/api/projects/{pid}/cues", json={
        "kind": "music", "path": "audio/music/theme.mp3", "start": 2,
        "offset": 0.5, "gain": -12}).json()["cue"]["id"]

    body = client.post(f"/api/projects/{pid}/cues/{cue_id}/move",
                       json={"at": 10}).json()
    assert body["cue"]["start"] == pytest.approx(9.5)    # start + offset == 10
    assert body["cue"]["offset"] == pytest.approx(0.5)   # the record's shape survives
    assert body["cue"]["gain"] == -12
    assert body["at"] == pytest.approx(10)

    # A move can never place a cue before the film starts.
    assert client.post(f"/api/projects/{pid}/cues/{cue_id}/move",
                       json={"at": -30}).json()["at"] == 0.0


def test_move_needs_a_place_and_a_real_cue(client, film_project):
    pid = film_project
    cue_id = client.post(f"/api/projects/{pid}/cues", json={
        "kind": "music", "path": "audio/music/theme.mp3", "start": 1},
    ).json()["cue"]["id"]
    assert client.post(f"/api/projects/{pid}/cues/{cue_id}/move",
                       json={}).status_code == 400
    assert client.post(f"/api/projects/{pid}/cues/nope/move",
                       json={"at": 1}).status_code == 404


def test_imported_cues_get_ids_so_they_can_be_moved(client, film_project):
    """The folder importer drops raw JSONL rows into settings — no ids. Reading
    the sheet (or the timeline) backfills them, and the same id comes back
    twice, which is what makes a cue addressable at all."""
    pid = film_project
    with session_scope() as s:
        proj = s.get(Project, pid)
        proj.settings = {**(proj.settings or {}), "sfx_cues": [
            {"shot": "B01-S2", "sfx-file": "audio/sfx/B01-S2-sfx.mp3",
             "gain-hint": "-8dB accent"}]}

    first = client.get(f"/api/projects/{pid}/cues").json()["sfx"][0]["id"]
    again = client.get(f"/api/projects/{pid}/cues").json()["sfx"][0]["id"]
    assert first == again and first.startswith("cue_")

    moved = client.post(f"/api/projects/{pid}/cues/{first}/move",
                        json={"at": 5}).json()
    assert moved["at"] == pytest.approx(5)
    assert moved["cue"]["offset"] == pytest.approx(2.0)   # B01-S2 starts at 3.0s
    assert moved["cue"]["gain-hint"] == "-8dB accent"     # the raw row survives


def test_cue_kind_is_inferred_from_the_path(client, film_project):
    r = client.post(f"/api/projects/{film_project}/cues",
                    json={"path": "audio/music/x.mp3", "start": 1})
    assert r.json()["cue"]["kind"] == "music"
    assert client.post(f"/api/projects/{film_project}/cues",
                       json={"start": 1}).status_code == 400


def test_cues_are_readable_without_the_admin_token(monkeypatch, client,
                                                   film_project):
    """Demo viewers place cues; only admin-gated routes 403 (see demo.py)."""
    from cutroom import config
    monkeypatch.setenv("CUTROOM_DEMO", "1")
    config.reset_settings()
    try:
        r = client.post(f"/api/projects/{film_project}/cues",
                        json={"kind": "sfx", "path": "audio/sfx/a.mp3",
                              "start": 0})
        assert r.status_code == 200, r.text
    finally:
        config.reset_settings()


def test_act_scope_drops_cues_anchored_outside_it(client, film_project):
    client.post(f"/api/projects/{film_project}/shots", json={
        "sid": "B09-S1", "beat": "B09", "act": 2, "seconds": 2.0})
    client.post(f"/api/projects/{film_project}/cues", json={
        "kind": "sfx", "path": "audio/sfx/a.mp3", "shot": "B09-S1"})
    sheet = client.get(f"/api/projects/{film_project}/cues?scope=act1").json()
    assert sheet["sfx"][0]["at"] is None     # out of scope, not placed


# ---------------------------------------------------------------- audible

def test_a_music_cue_is_audible_in_the_assembled_cut(tmp_path):
    """The whole point: mix RMS over the cue window must beat the silence
    before it. Synthetic media, no models, no network."""
    plate = make_image(tmp_path / "plate.png", 320, 224)
    tone = make_wav(tmp_path / "music.wav", seconds=3.0, freq=220.0)
    shots = [assemble.TimelineShot(sid="B01-S1", seconds=3.0, source=plate),
             assemble.TimelineShot(sid="B01-S2", seconds=3.0, source=plate)]
    out = tmp_path / "cut.mp4"
    info = assemble.build_animatic(
        shots, out, res=(320, 224), fps=12,
        cues=[assemble.AudioCue(path=tone, shot="B01-S2", gain_db=0.0)])

    assert info["audio_items"] == 1
    silent = rms_window(out, 0.5, 1.5, tmp_path)      # before the cue
    loud = rms_window(out, 3.5, 1.5, tmp_path)        # inside the cue
    assert loud > 0.05
    assert loud > silent * 20


def test_cue_gain_and_fades_shape_the_mix(tmp_path):
    plate = make_image(tmp_path / "plate.png", 320, 224)
    tone = make_wav(tmp_path / "music.wav", seconds=4.0, freq=220.0)
    shots = [assemble.TimelineShot(sid="B01-S1", seconds=4.0, source=plate)]

    hot = tmp_path / "hot.mp4"
    assemble.build_animatic(shots, hot, res=(320, 224), fps=12,
                            cues=[assemble.AudioCue(path=tone, start=0.0)])
    quiet = tmp_path / "quiet.mp4"
    assemble.build_animatic(
        shots, quiet, res=(320, 224), fps=12,
        cues=[assemble.AudioCue(path=tone, start=0.0, gain_db=-20.0)])
    hot_rms = rms_window(hot, 1.0, 2.0, tmp_path)
    quiet_rms = rms_window(quiet, 1.0, 2.0, tmp_path)
    assert hot_rms > quiet_rms * 5          # -20 dB is a factor of 10

    faded = tmp_path / "faded.mp4"
    assemble.build_animatic(
        shots, faded, res=(320, 224), fps=12,
        cues=[assemble.AudioCue(path=tone, start=0.0, duration=4.0,
                                fade_in=2.0)])
    assert rms_window(faded, 0.0, 0.5, tmp_path) < \
        rms_window(faded, 3.0, 0.5, tmp_path)


def test_an_out_of_scope_cue_is_skipped_not_fatal(tmp_path):
    plate = make_image(tmp_path / "plate.png", 320, 224)
    tone = make_wav(tmp_path / "music.wav", seconds=1.0)
    info = assemble.build_animatic(
        [assemble.TimelineShot(sid="B01-S1", seconds=2.0, source=plate)],
        tmp_path / "cut.mp4", res=(320, 224), fps=12,
        cues=[assemble.AudioCue(path=tone, shot="B99-S9")])
    assert info["audio_items"] == 0


def test_assemble_job_mixes_the_projects_own_cue_sheet(client, film_project,
                                                       data_dir):
    """End to end: POST a cue, run the assemble handler, hear it."""
    import asyncio
    from cutroom.jobs import handlers
    from cutroom.storage import get_storage

    pid = film_project
    store = get_storage().project(pid)
    make_image(store.resolve("renders/B01-S1/stills/a.png"), 320, 224)
    client.post(f"/api/projects/{pid}/shots/B01-S1/curate",
                json={"keeper": "renders/B01-S1/stills/a.png"})
    client.post(f"/api/projects/{pid}/shots/B01-S2/curate",
                json={"keeper": "renders/B01-S1/stills/a.png"})
    make_wav(store.resolve("audio/music/theme.wav"), seconds=3.0, freq=220.0)
    r = client.post(f"/api/projects/{pid}/cues", json={
        "kind": "music", "path": "audio/music/theme.wav", "shot": "B01-S2"})
    assert r.status_code == 200, r.text

    class Ctx:
        job_id = None

        def log(self, *_a, **_k):
            pass

    info = asyncio.run(handlers.animatic_assemble(
        Ctx(), {"project": pid, "scope": "full", "res": "720"}))
    assert info["cues"] == 1
    assert info["audio_items"] == 1
    cut = store.resolve(info["take"])
    tmp = cut.parent
    assert rms_window(cut, 3.5, 1.0, tmp) > \
        rms_window(cut, 0.5, 1.0, tmp) * 20

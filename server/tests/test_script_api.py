"""Starting a film from nothing: viewer project creation (capped), the batch
script write, and lane defaults on a freshly created project.

This is the server half of workstream K — the half that lets an agent answer
"build me a comical short about the French Revolution" without an admin token.
"""
import pytest

from cutroom import demo

VIEWER = {"Authorization": "Bearer judge"}
ADMIN = {"Authorization": "Bearer boss"}


@pytest.fixture()
def demo_client(data_dir, monkeypatch):
    monkeypatch.setenv("CUTROOM_DEMO", "1")
    monkeypatch.setenv("CUTROOM_AUTH_TOKEN", "judge")
    monkeypatch.setenv("CUTROOM_ADMIN_TOKEN", "boss")
    monkeypatch.setenv("CUTROOM_LANE_STILL", "mock:tiny")
    monkeypatch.setenv("CUTROOM_LANE_VO", "mock")
    from cutroom import config
    config.reset_settings()
    demo.reset_rate_limits()
    from fastapi.testclient import TestClient
    from cutroom.main import create_app
    with TestClient(create_app()) as c:
        yield c
    demo.reset_rate_limits()
    config.reset_settings()


def shot(**kw):
    row = {"image_prompt": "A Paris street. Subject: a baker. "
                           "cinematic anime film still"}
    row.update(kw)
    return row


# ------------------------------------------------------------- creation


def test_a_viewer_can_start_a_film(demo_client):
    r = demo_client.post("/api/projects",
                         json={"id": "Revolution!", "title": "Revolution"},
                         headers=VIEWER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == "revolution"          # slugified
    assert body["label"] == "Revolution"
    assert demo_client.get("/api/projects/revolution/film",
                           headers=VIEWER).json() == []


def test_new_projects_get_the_demo_lane_defaults(demo_client):
    r = demo_client.post("/api/projects", json={"id": "lanes-test"},
                         headers=VIEWER)
    assert r.status_code == 200
    assert r.json()["lanes"]["still"] == {"backend": "mock", "model": "tiny"}
    lanes = demo_client.get("/api/projects/lanes-test/lanes",
                            headers=VIEWER).json()
    assert lanes["still"]["backend"] == "mock"
    assert lanes["still"]["model"] == "tiny"
    assert lanes["vo"]["backend"] == "mock"


def test_the_project_cap_is_per_token_and_admin_is_exempt(demo_client,
                                                          monkeypatch):
    from cutroom import config
    monkeypatch.setattr(config.get_settings(), "demo_projects_per_token", 2)
    codes = [demo_client.post("/api/projects", json={"id": f"v{i}"},
                              headers=VIEWER).status_code for i in range(3)]
    assert codes == [200, 200, 429]
    r = demo_client.post("/api/projects", json={"id": "v9"}, headers=VIEWER)
    assert "per day" in r.json()["detail"]
    # the owner is never capped, and a different token has its own bucket
    assert demo_client.post("/api/projects", json={"id": "a1"},
                            headers=ADMIN).status_code == 200
    assert demo_client.post("/api/projects", json={"id": "a2"},
                            headers=ADMIN).status_code == 200


def test_a_refused_project_does_not_burn_quota(demo_client, monkeypatch):
    from cutroom import config
    monkeypatch.setattr(config.get_settings(), "demo_projects_per_token", 1)
    assert demo_client.post("/api/projects", json={"id": "dup"},
                            headers=VIEWER).status_code == 200
    assert demo_client.post("/api/projects", json={"id": "dup"},
                            headers=VIEWER).status_code == 409
    assert demo_client.post("/api/projects", json={"id": "next"},
                            headers=VIEWER).status_code == 429


def test_off_demo_creation_is_unlimited(client):
    for i in range(5):
        assert client.post("/api/projects",
                           json={"id": f"p{i}"}).status_code == 200


# ------------------------------------------------------------- the batch write


@pytest.fixture()
def film(demo_client):
    assert demo_client.post("/api/projects", json={"id": "fr"},
                            headers=VIEWER).status_code == 200
    return "fr"


def batch(client, pid, shots, **extra):
    return client.post(f"/api/projects/{pid}/shots/batch",
                       json={"shots": shots, **extra}, headers=VIEWER)


def test_batch_assigns_sids_one_beat_per_act_and_keeps_order(demo_client, film):
    r = batch(demo_client, film, [
        shot(act=1), shot(act=1), shot(act=2), shot(act=2, beat="B07"),
    ])
    assert r.status_code == 200, r.text
    assert r.json()["sids"] == ["B01-S1", "B01-S2", "B02-S1", "B07-S1"]
    assert r.json()["count"] == 4
    order = [e["sid"] for e in
             demo_client.get(f"/api/projects/{film}/film",
                             headers=VIEWER).json()]
    assert order == ["B01-S1", "B01-S2", "B02-S1", "B07-S1"]


def test_batch_carries_every_script_field_and_defaults_seconds(demo_client, film):
    r = batch(demo_client, film, [shot(
        sid="B01-S1", type="hero", register="R2", seconds=9,
        negative="text, watermark", motion_prompt="the wig trembles",
        narration="A bad week for the aristocracy.",
        dialogue=[{"character": "BAKER", "line": "Bread first."}],
        sfx="a distant crowd", ambient="street noise", cut="hard",
        render_notes="no visible faces"), shot(sid="B01-S2")])
    assert r.status_code == 200, r.text
    assert r.json()["total_seconds"] == 15.0        # 9 + the 6s default
    got = demo_client.get(f"/api/projects/{film}/shots/B01-S1",
                          headers=VIEWER).json()
    assert got["type"] == "HERO" and got["register"] == "R2"
    assert got["seconds"] == 9
    assert got["narration"].startswith("A bad week")
    assert got["dialogue"][0]["character"] == "BAKER"
    assert got["render_notes"] == "no visible faces"


def test_batch_upserts_in_place_and_can_replace(demo_client, film):
    batch(demo_client, film, [shot(sid="B01-S1"), shot(sid="B01-S2")])
    r = batch(demo_client, film,
              [shot(sid="B01-S2", image_prompt="a rewritten street")],
              replace=True)
    assert r.status_code == 200
    film_rows = demo_client.get(f"/api/projects/{film}/film",
                                headers=VIEWER).json()
    assert [e["sid"] for e in film_rows] == ["B01-S2"]
    assert film_rows[0]["image_prompt"] == "a rewritten street"


@pytest.mark.parametrize("shots,needle", [
    ([shot(sid="S1")], "must look like"),
    ([shot(sid="B01-S1"), shot(sid="B01-S1")], "twice"),
    ([{"seconds": 5}], "image_prompt"),
    ([shot() for _ in range(41)], "cap is 40"),
    ([shot(seconds=20) for _ in range(16)], "past 300s"),
    ([], "need shots"),
])
def test_batch_validation(demo_client, film, shots, needle):
    r = batch(demo_client, film, shots)
    assert r.status_code == 400, r.text
    assert needle in r.json()["detail"]


def test_batch_clamps_seconds_into_the_2_to_20_window(demo_client, film):
    r = batch(demo_client, film,
              [shot(sid="B01-S1", seconds=0.5), shot(sid="B01-S2", seconds=90)])
    assert r.status_code == 200
    assert r.json()["total_seconds"] == 22.0        # 2 + 20
    rows = demo_client.get(f"/api/projects/{film}/film", headers=VIEWER).json()
    assert [row["seconds"] for row in rows] == [2.0, 20.0]


def test_a_viewer_may_set_the_cast_of_a_film_they_wrote(demo_client, film):
    r = demo_client.post(f"/api/projects/{film}/cast", headers=VIEWER, json={
        "characters": [{"id": "CHAR-baker",
                        "character": "Margot — the baker who starts it",
                        "aliases": ["the baker"]}]})
    assert r.status_code == 200, r.text
    cast = r.json()["cast"]
    assert cast[0]["name"] == "Margot"
    assert "baker" in cast[0]["aliases"]          # derived from the role
    assert "the baker" in cast[0]["aliases"]      # and the ones the caller knows
    stored = demo_client.get(f"/api/projects/{film}/cast",
                             headers=VIEWER).json()["cast"]
    assert stored[0]["id"] == "CHAR-baker"


# --------------------------------------------------- the narration rename

def test_narration_still_answers_to_its_old_name(demo_client, film):
    """`radio` was the field's name while the platform knew one film, whose
    narration was a broadcast. It writes and reads for one more release."""
    line = "Paris woke up hungry."
    r = batch(demo_client, film, [shot(sid="B01-S1", radio=line)])
    assert r.status_code == 200, r.text
    got = demo_client.get(f"/api/projects/{film}/shots/B01-S1",
                          headers=VIEWER).json()
    assert got["narration"] == line
    assert got["radio"] == line          # the alias reads back too


def test_narration_wins_when_a_caller_sends_both(demo_client, film):
    batch(demo_client, film, [shot(sid="B01-S1", radio="the old name",
                                   narration="the field's real name")])
    got = demo_client.get(f"/api/projects/{film}/shots/B01-S1",
                          headers=VIEWER).json()
    assert got["narration"] == "the field's real name"


def test_single_shot_upsert_takes_either_spelling(demo_client, film):
    batch(demo_client, film, [shot(sid="B01-S1")])
    demo_client.post(f"/api/projects/{film}/shots", headers=VIEWER,
                     json={"sid": "B01-S1", "radio": "written the old way"})
    got = demo_client.get(f"/api/projects/{film}/shots/B01-S1",
                          headers=VIEWER).json()
    assert got["narration"] == "written the old way"
    demo_client.post(f"/api/projects/{film}/shots", headers=VIEWER,
                     json={"sid": "B01-S1", "narration": "written the new way"})
    got = demo_client.get(f"/api/projects/{film}/shots/B01-S1",
                          headers=VIEWER).json()
    assert got["narration"] == "written the new way"


# ------------------------------------------------------- voice treatments

@pytest.fixture()
def vo_client(data_dir, monkeypatch):
    """The demo app with the free mock lane on, so a vo submission gets as far
    as the queue and we can read what was actually queued."""
    monkeypatch.setenv("CUTROOM_DEMO", "1")
    monkeypatch.setenv("CUTROOM_DEMO_MOCK", "1")
    monkeypatch.setenv("CUTROOM_AUTH_TOKEN", "judge")
    monkeypatch.setenv("CUTROOM_ADMIN_TOKEN", "boss")
    from cutroom import config
    config.reset_settings()
    demo.reset_rate_limits()
    from fastapi.testclient import TestClient
    from cutroom.main import create_app
    with TestClient(create_app()) as c:
        assert c.post("/api/projects", json={"id": "fr"},
                      headers=VIEWER).status_code == 200
        yield c
    demo.reset_rate_limits()
    config.reset_settings()


def submit_vo(client, **body):
    return client.post("/api/projects/fr/generate/vo", headers=VIEWER,
                       json={"text": "Bread first.", **body})


def payload_of(jid: str) -> dict:
    """What the API actually queued — the job row, not the HTTP echo."""
    from cutroom.db import session_scope
    from cutroom.models import Job
    with session_scope() as s:
        return dict(s.get(Job, jid).payload)


def test_vo_defaults_to_no_treatment(vo_client):
    r = submit_vo(vo_client)
    assert r.status_code == 200, r.text
    assert payload_of(r.json()["job"]).get("treatment") is None


def test_vo_takes_a_named_treatment(vo_client):
    r = submit_vo(vo_client, treatment="MEGAPHONE")
    assert r.status_code == 200, r.text
    assert payload_of(r.json()["job"])["treatment"] == "megaphone"


def test_vo_refuses_a_treatment_it_does_not_have(vo_client):
    r = submit_vo(vo_client, treatment="underwater")
    assert r.status_code == 400
    assert "megaphone" in r.text


def test_futz_is_the_old_spelling_of_the_radio_treatment(vo_client):
    r = submit_vo(vo_client, futz=True)
    assert r.status_code == 200, r.text
    p = payload_of(r.json()["job"])
    assert p["treatment"] == "radio" and "futz" not in p

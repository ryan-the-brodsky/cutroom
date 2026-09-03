"""GET /film/status — has the film changed since the last cut?

The Timeline's live preview (GET .../timeline) always reflects the current
shots/overrides/cues; only a rendered cut is frozen at whatever it looked
like when `cut_film` made it. This is the field a human or an agent reads to
tell the two apart without re-deriving it by hand.
"""
import time

from cutroom.db import session_scope
from cutroom import film
from cutroom.models import Project, Shot, Take


def _project(client, pid: str = "status-film"):
    client.post("/api/projects", json={"id": pid, "label": "S"})
    client.post(f"/api/projects/{pid}/shots", json={
        "sid": "B01-S1", "beat": "B01", "act": 1, "seconds": 3.0,
        "image_prompt": "a street"})
    return pid


def _record_animatic(pid: str, at: float | None = None) -> None:
    with session_scope() as s:
        t = Take(project_id=pid, kind="animatic",
                 path="assembly/animatic-full-720p.mp4")
        s.add(t)
        s.flush()
        if at is not None:
            t.created_at = at


# ---------------------------------------------------------------- the unit

def test_touch_caps_the_log(data_dir):
    from cutroom.db import init_db
    init_db()
    with session_scope() as s:
        s.add(Project(id="p1", label="P"))
    with session_scope() as s:
        for i in range(40):
            film.touch(s, "p1", f"change {i}")
    with session_scope() as s:
        proj = s.get(Project, "p1")
        assert len(proj.film_changes) == 30            # capped
        assert proj.film_changes[-1]["note"] == "change 39"


def test_status_never_cut_but_no_changes_either(data_dir):
    from cutroom.db import init_db
    init_db()
    with session_scope() as s:
        s.add(Project(id="p1", label="P"))
    with session_scope() as s:
        status = film.film_status(s, "p1")
    assert status == {"last_cut_at": None, "last_change_at": None,
                      "stale": False, "changes": [], "changes_count": 0}


def test_status_stale_after_a_change_with_no_cut_yet(data_dir):
    from cutroom.db import init_db
    init_db()
    with session_scope() as s:
        s.add(Project(id="p1", label="P"))
    with session_scope() as s:
        film.touch(s, "p1", "new keeper on B01-S1")
    with session_scope() as s:
        status = film.film_status(s, "p1")
    assert status["last_cut_at"] is None
    assert status["last_change_at"] is not None
    assert status["stale"] is True
    assert status["changes"] == ["new keeper on B01-S1"]


def test_status_settles_once_the_change_predates_the_cut(data_dir):
    from cutroom.db import init_db
    init_db()
    with session_scope() as s:
        s.add(Project(id="p1", label="P"))
    with session_scope() as s:
        film.touch(s, "p1", "new keeper on B01-S1")
    _record_animatic("p1")                              # cut AFTER the change
    with session_scope() as s:
        status = film.film_status(s, "p1")
    assert status["stale"] is False
    assert status["changes"] == []                      # nothing since the cut


def test_status_stale_again_after_a_change_past_the_cut(data_dir):
    from cutroom.db import init_db
    init_db()
    with session_scope() as s:
        s.add(Project(id="p1", label="P"))
    _record_animatic("p1", at=1_000.0)
    with session_scope() as s:
        proj = s.get(Project, "p1")
        proj.film_changes = [{"note": "old, pre-cut change", "at": 500.0}]
        film.touch(s, "p1", "new keeper on B01-S1")      # at ~now, way past 1000
    with session_scope() as s:
        status = film.film_status(s, "p1")
    assert status["stale"] is True
    assert status["changes"] == ["new keeper on B01-S1"]  # the pre-cut note is excluded


def test_changes_list_is_newest_first_and_capped(data_dir):
    from cutroom.db import init_db
    init_db()
    with session_scope() as s:
        s.add(Project(id="p1", label="P"))
    with session_scope() as s:
        for i in range(10):
            film.touch(s, "p1", f"change {i}")
    with session_scope() as s:
        status = film.film_status(s, "p1")
    assert len(status["changes"]) == 8                   # a tooltip's worth
    assert status["changes"][0] == "change 9"            # newest first
    assert status["changes_count"] == 10                 # the exact count, uncapped


# ---------------------------------------------------------------- the endpoint

def test_endpoint_404s_for_a_missing_project(client):
    assert client.get("/api/projects/does-not-exist/film/status").status_code == 404


def test_endpoint_reflects_a_fresh_project(client):
    pid = _project(client)
    r = client.get(f"/api/projects/{pid}/film/status")
    assert r.status_code == 200
    body = r.json()
    assert body["last_cut_at"] is None and body["last_change_at"] is None
    assert body["stale"] is False and body["changes"] == []


def test_setting_the_timeline_source_marks_the_film_stale(client):
    pid = _project(client)
    r = client.post(f"/api/projects/{pid}/shots/B01-S1/override",
                    json={"source": "renders/stills/B01-S1_0.png"})
    assert r.status_code == 200
    status = client.get(f"/api/projects/{pid}/film/status").json()
    assert status["stale"] is True
    assert status["changes_count"] == 1
    assert any("timeline source" in c and "B01-S1" in c for c in status["changes"])


def test_curating_a_keeper_marks_the_film_stale(client, tmp_path):
    from conftest import make_image
    from cutroom.storage import get_storage
    pid = _project(client)
    store = get_storage().project(pid)
    make_image(store.resolve("renders/stills/B01-S1_0.png"))
    r = client.post(f"/api/projects/{pid}/shots/B01-S1/curate",
                    json={"keeper": "renders/stills/B01-S1_0.png"})
    assert r.status_code == 200
    status = client.get(f"/api/projects/{pid}/film/status").json()
    assert status["stale"] is True
    assert any("keeper" in c and "B01-S1" in c for c in status["changes"])


def test_placing_moving_and_removing_a_cue_each_mark_the_film_stale(client, tmp_path):
    from conftest import make_wav
    from cutroom.storage import get_storage
    pid = _project(client)
    store = get_storage().project(pid)
    make_wav(store.resolve("audio/sfx/hit.wav"), seconds=0.5)

    r = client.post(f"/api/projects/{pid}/cues", json={
        "kind": "sfx", "path": "audio/sfx/hit.wav", "shot": "B01-S1"})
    assert r.status_code == 200
    cue_id = r.json()["cue"]["id"]
    status = client.get(f"/api/projects/{pid}/film/status").json()
    assert status["stale"] is True
    assert status["changes"][0] == "sfx cue placed"

    client.post(f"/api/projects/{pid}/cues/{cue_id}/move", json={"delta": 0.5})
    status = client.get(f"/api/projects/{pid}/film/status").json()
    assert status["changes"][0] == "sfx cue moved"

    client.post(f"/api/projects/{pid}/cues/{cue_id}/delete")
    status = client.get(f"/api/projects/{pid}/film/status").json()
    assert status["changes"][0] == "sfx cue removed"


def test_cutting_the_film_settles_staleness_from_earlier_changes(client, tmp_path):
    from conftest import make_image
    from cutroom.storage import get_storage
    pid = _project(client)
    store = get_storage().project(pid)
    make_image(store.resolve("renders/stills/B01-S1_0.png"))
    client.post(f"/api/projects/{pid}/shots/B01-S1/curate",
               json={"keeper": "renders/stills/B01-S1_0.png"})
    assert client.get(f"/api/projects/{pid}/film/status").json()["stale"] is True

    # `cut_film` records an `animatic` take; recording it directly is the same
    # thing this test suite already does for the screening room/public tests.
    _record_animatic(pid)
    status = client.get(f"/api/projects/{pid}/film/status").json()
    assert status["stale"] is False
    assert status["last_cut_at"] is not None
    assert status["changes"] == []

    # a change AFTER the cut goes stale again
    client.post(f"/api/projects/{pid}/shots/B01-S1/override", json={"seconds": 4.0})
    status = client.get(f"/api/projects/{pid}/film/status").json()
    assert status["stale"] is True
    assert status["changes"] == ["B01-S1 retimed"]


def test_a_new_take_from_a_generation_job_also_marks_the_film_stale(client):
    """`record_take` is the single hook every generation lane shares — a fresh
    still, i2i, motion or VO line all count, an `animatic` take never does."""
    pid = _project(client)
    from cutroom.jobs.handlers import record_take
    record_take(pid, "B01-S1", "still", "renders/stills/B01-S1_9.png")
    status = client.get(f"/api/projects/{pid}/film/status").json()
    assert status["stale"] is True
    assert status["changes"] == ["new still on B01-S1"]

    _record_animatic(pid)
    assert client.get(f"/api/projects/{pid}/film/status").json()["stale"] is False

    # recording the cut itself must never re-trigger staleness
    record_take(pid, None, "animatic", "assembly/animatic-full-720p.mp4")
    assert client.get(f"/api/projects/{pid}/film/status").json()["stale"] is False

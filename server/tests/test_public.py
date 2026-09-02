"""The public surface: `/api/public` and the film it streams to strangers.

The whole point of this router is that it answers without a token, so the tests
that matter are the ones that assert *absence* of auth — with
`CUTROOM_AUTH_TOKEN` set, and in demo mode, where every other route 401s.
"""
import pytest

from conftest import make_clip


def _client():
    from fastapi.testclient import TestClient
    from cutroom.main import create_app
    return TestClient(create_app())


@pytest.fixture()
def app_env(data_dir, monkeypatch):
    """A demo instance whose demo project is `film`, with no links configured."""
    monkeypatch.setenv("CUTROOM_DEMO_PROJECT", "film")
    monkeypatch.delenv("CUTROOM_ACCESS_FORM_URL", raising=False)
    monkeypatch.delenv("CUTROOM_DEMO_VIDEO_URL", raising=False)
    from cutroom import config, db
    config.reset_settings()
    db.init_db()          # these tests seed rows before the app is built
    yield monkeypatch
    config.reset_settings()


def add_cut(pid: str = "film", seconds: float = 2.0, total: float | None = 130.0,
            name: str = "assembly/animatic-full-720p.mp4"):
    """A project holding one animatic take whose file actually exists."""
    from cutroom.db import session_scope
    from cutroom.models import Project, Take
    from cutroom.storage import get_storage
    store = get_storage().create_project(pid)
    make_clip(store.resolve(name), seconds=seconds, size="160x96")
    with session_scope() as s:
        if not s.get(Project, pid):
            s.add(Project(id=pid, label="Two Claudes"))
        s.add(Take(project_id=pid, kind="animatic", path=name,
                   meta={"total": total} if total is not None else {}))
    return name


def test_shape_with_no_env_and_no_film(app_env):
    with _client() as c:
        r = c.get("/api/public")
    assert r.status_code == 200
    # empty strings, not nulls: "no button", not "a button with no href"
    assert r.json() == {"access_form_url": "", "video_url": "", "film": None}


def test_env_links_are_reported_and_trimmed(app_env):
    app_env.setenv("CUTROOM_ACCESS_FORM_URL", "  https://forms.gle/abc  ")
    app_env.setenv("CUTROOM_DEMO_VIDEO_URL", "https://youtu.be/dQw4w9WgXcQ")
    from cutroom import config
    config.reset_settings()
    with _client() as c:
        body = c.get("/api/public").json()
    assert body["access_form_url"] == "https://forms.gle/abc"
    assert body["video_url"] == "https://youtu.be/dQw4w9WgXcQ"


def test_film_is_null_until_a_cut_exists(app_env):
    from cutroom.db import session_scope
    from cutroom.models import Project
    with session_scope() as s:
        s.add(Project(id="film", label="Two Claudes"))
    with _client() as c:
        assert c.get("/api/public").json()["film"] is None
        # and the stream says so plainly instead of 500ing
        assert c.get("/api/public/film.mp4").status_code == 404


def test_film_is_described_and_served(app_env):
    add_cut()
    with _client() as c:
        film = c.get("/api/public").json()["film"]
        assert film == {"url": "/api/public/film.mp4",
                        "label": "Two Claudes", "seconds": 130.0}
        r = c.get(film["url"])
        assert r.status_code == 200
        assert r.headers["content-type"] == "video/mp4"
        assert len(r.content) > 500

        # <video> seeks with Range; FileResponse must answer 206 with the slice
        r = c.get(film["url"], headers={"Range": "bytes=0-99"})
        assert r.status_code == 206
        assert len(r.content) == 100
        assert r.headers["content-range"].startswith("bytes 0-99/")


def test_length_falls_back_to_the_edl_when_total_is_missing(app_env):
    from cutroom.db import session_scope
    from cutroom.models import Project, Take
    from cutroom.storage import get_storage
    store = get_storage().create_project("film")
    make_clip(store.resolve("assembly/a.mp4"), seconds=1.0, size="160x96")
    with session_scope() as s:
        s.add(Project(id="film", label="Two Claudes"))
        s.add(Take(project_id="film", kind="animatic", path="assembly/a.mp4",
                   meta={"edl": [{"start": 0.0, "seconds": 4.0},
                                 {"start": 4.0, "seconds": 2.5}]}))
    with _client() as c:
        assert c.get("/api/public").json()["film"]["seconds"] == 6.5


def test_newest_playable_cut_wins(app_env):
    """A pruned newest row must not shadow the older cut that still plays."""
    add_cut(name="assembly/old.mp4", total=100.0)
    from cutroom.db import session_scope
    from cutroom.models import Take
    with session_scope() as s:
        s.add(Take(project_id="film", kind="animatic",
                   path="assembly/pruned.mp4", meta={"total": 200.0},
                   created_at=9e9))
    with _client() as c:
        assert c.get("/api/public").json()["film"]["seconds"] == 100.0
        assert c.get("/api/public/film.mp4").status_code == 200


def test_only_the_demo_project_is_ever_public(app_env):
    """A private project's cut is not reachable, newer or not."""
    add_cut(pid="private", total=99.0)
    with _client() as c:
        assert c.get("/api/public").json()["film"] is None
        assert c.get("/api/public/film.mp4").status_code == 404


def test_no_token_needed_even_when_the_studio_is_locked(app_env):
    app_env.setenv("CUTROOM_AUTH_TOKEN", "judge")
    app_env.setenv("CUTROOM_ADMIN_TOKEN", "boss")
    app_env.setenv("CUTROOM_DEMO", "1")
    app_env.setenv("CUTROOM_ACCESS_FORM_URL", "https://forms.gle/abc")
    from cutroom import config
    config.reset_settings()
    add_cut()
    with _client() as c:
        # everything else is shut
        assert c.get("/api/system").status_code == 401
        assert c.get("/api/projects").status_code == 401
        # the public page is not
        r = c.get("/api/public")
        assert r.status_code == 200
        assert r.json()["access_form_url"] == "https://forms.gle/abc"
        assert c.get("/api/public/film.mp4").status_code == 200


def test_the_spa_catch_all_does_not_shadow_the_public_routes(app_env, tmp_path):
    """With a built SPA present, `/{path:path}` must still lose to `/api/public`."""
    from pathlib import Path
    import cutroom.main as main
    static = Path(main.__file__).parent / "static"
    if not static.is_dir():
        pytest.skip("no built SPA in this checkout")
    add_cut()
    with _client() as c:
        assert c.get("/api/public").headers["content-type"].startswith(
            "application/json")
        assert c.get("/api/public/film.mp4").headers["content-type"] == "video/mp4"

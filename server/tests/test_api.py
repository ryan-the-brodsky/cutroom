"""API tests — the full request surface against a temp data dir."""


def test_project_lifecycle(client):
    r = client.post("/api/projects", json={"id": "Film One!", "label": "Film"})
    assert r.status_code == 200
    assert r.json()["id"] == "film-one"
    assert client.post("/api/projects",
                       json={"id": "film-one"}).status_code == 409
    assert [p["id"] for p in client.get("/api/projects").json()] == ["film-one"]


def test_shot_and_override_flow(client):
    client.post("/api/projects", json={"id": "p1"})
    client.post("/api/projects/p1/shots",
                json={"sid": "B01-S1", "seconds": 5, "beat": "B01", "act": 1,
                      "image_prompt": "night street"})
    client.post("/api/projects/p1/shots",
                json={"sid": "B01-S2", "seconds": 4, "beat": "B01", "act": 1})
    film = client.get("/api/projects/p1/film").json()
    assert [s["sid"] for s in film] == ["B01-S1", "B01-S2"]

    r = client.post("/api/projects/p1/shots/B01-S1/override",
                    json={"seconds": 7.5, "note": "longer hold"})
    assert r.json()["override"]["seconds"] == 7.5
    shot = client.get("/api/projects/p1/shots/B01-S1").json()
    assert shot["seconds"] == 7.5 and shot["scripted_seconds"] == 5.0

    # clearing with null drops the key
    r = client.post("/api/projects/p1/shots/B01-S1/override",
                    json={"seconds": None})
    assert "seconds" not in r.json()["override"]

    # A bare path still adds; it comes back as a character reference, which is
    # the shape everything reads now (cutroom/refs.py, tests/test_references.py).
    r = client.post("/api/projects/p1/shots/B01-S1/refs",
                    json={"add": "renders/refs/photo/x.jpg"})
    assert r.json()["refs"] == [{"path": "renders/refs/photo/x.jpg",
                                 "role": "character"}]


def test_curation_keeps_history(client):
    from cutroom.storage import get_storage
    from conftest import make_image
    client.post("/api/projects", json={"id": "p2"})
    client.post("/api/projects/p2/shots", json={"sid": "B01-S1"})
    store = get_storage().project("p2")
    for name in ("a", "b"):
        make_image(store.resolve(f"renders/stills/{name}.png"), 320, 224)
    r = client.post("/api/projects/p2/shots/B01-S1/curate",
                    json={"keeper": "renders/stills/a.png", "note": "clean"})
    # the response echoes the pick, so a caller can confirm it landed
    assert r.json()["keeper"] == "renders/stills/a.png"
    assert r.json()["previous"] is None
    r = client.post("/api/projects/p2/shots/B01-S1/curate",
                    json={"keeper": "renders/stills/b.png"})
    assert r.json() == {"op": "set_keeper", "applied": True, "shot": "B01-S1",
                        "keeper": "renders/stills/b.png",
                        "previous": "renders/stills/a.png"}
    shot = client.get("/api/projects/p2/shots/B01-S1").json()
    assert shot["keeper"] == "renders/stills/b.png"
    assert "clean" in shot["curation_note"]


def test_curate_refuses_a_keeper_that_is_not_a_still_that_exists(client):
    """The keeper is the plate every motion / i2i / comp job starts from, so a
    path that is not there has to fail HERE — loudly, at the click — not hours
    later as a clip animated from the wrong frame."""
    from cutroom.storage import get_storage
    from conftest import make_image
    client.post("/api/projects", json={"id": "p3"})
    client.post("/api/projects/p3/shots", json={"sid": "B01-S1"})
    store = get_storage().project("p3")
    make_image(store.resolve("renders/stills/real.png"), 320, 224)

    r = client.post("/api/projects/p3/shots/B01-S1/curate",
                    json={"keeper": "renders/stills/typo.png"})
    assert r.status_code == 400
    assert "renders/stills/typo.png" in r.json()["detail"]

    # a clip is not a plate: the timeline-source override is the tool for that
    r = client.post("/api/projects/p3/shots/B01-S1/curate",
                    json={"keeper": "renders/fx/B01-S1.mp4"})
    assert r.status_code == 400
    assert "still" in r.json()["detail"]

    assert client.get("/api/projects/p3/shots/B01-S1").json()["keeper"] is None
    assert client.post("/api/projects/p3/shots/B01-S1/curate",
                       json={"keeper": "renders/stills/real.png"}
                       ).status_code == 200


def test_backend_crud_masks_keys(client):
    r = client.post("/api/backends",
                    json={"id": "myfal", "type": "fal",
                          "api_key": "secret-key-12345",
                          "options": {"model": "fal-ai/ltx-video"}})
    assert r.status_code == 200
    d = r.json()
    assert "secret-key-12345" not in str(d)
    assert d["api_key_set"] is True
    # empty api_key on update keeps the stored secret
    r = client.post("/api/backends",
                    json={"id": "myfal", "type": "fal", "api_key": "",
                          "label": "renamed"})
    assert r.json()["api_key_set"] is True
    listing = client.get("/api/backends").json()
    assert all("secret-key-12345" not in str(b) for b in listing)
    assert client.post("/api/backends",
                       json={"id": "x", "type": "bogus"}).status_code == 400


def test_lane_registry_and_config(client):
    lanes = client.get("/api/lanes").json()
    assert "still" in lanes and "motion" in lanes and "direction" in lanes
    client.post("/api/projects", json={"id": "p3"})
    r = client.post("/api/projects/p3/lanes",
                    json={"lane": "still", "backend": "local-comfyui",
                          "model": "anima-base-v1.0.safetensors"})
    assert r.status_code == 200
    assert client.get("/api/projects/p3/lanes").json()["still"]["model"] == \
        "anima-base-v1.0.safetensors"


def test_media_path_jail(client):
    client.post("/api/projects", json={"id": "p4"})
    r = client.get("/api/projects/p4/media/../../../etc/passwd")
    assert r.status_code in (403, 404)


def test_upload_and_media_roundtrip(client):
    client.post("/api/projects", json={"id": "p5"})
    png = bytes.fromhex("89504e470d0a1a0a") + b"0" * 200
    r = client.post("/api/projects/p5/upload?filename=ref one.png&kind=ref",
                    content=png)
    rel = r.json()["rel"]
    assert rel.startswith("uploads/")
    assert client.get(f"/api/projects/p5/media/{rel}").status_code == 200
    takes = client.get("/api/projects/p5/takes?kind=ref").json()
    assert takes and takes[0]["path"] == rel


def test_comp_crud(client):
    client.post("/api/projects", json={"id": "p6"})
    r = client.post("/api/projects/p6/comps",
                    json={"shot": "B04-S3", "cid": "dial",
                          "background": "renders/stills/plate.png",
                          "duration": 4.0})
    assert r.status_code == 200
    r = client.post("/api/projects/p6/comps/dial",
                    json={"duration": 6.0,
                          "layers": [{"id": "L1", "region": [0, 0, 64, 64],
                                      "clip": None, "prompt": "hand turns"}]})
    assert r.json()["duration"] == 6.0
    comps = client.get("/api/projects/p6/comps?shot=B04-S3").json()
    assert comps[0]["cid"] == "dial"
    assert comps[0]["background_kind"] == "still"
    assert client.post("/api/projects/p6/comps/dial/delete").json()["ok"]


def test_comp_on_a_video_background(client):
    """A comp may stage on a CLIP: the background moves under the cel layers.
    Restyle is a plate operation, so it is refused with a usable message."""
    client.post("/api/projects", json={"id": "p6v"})
    r = client.post("/api/projects/p6v/comps",
                    json={"shot": "B04-S3", "cid": "moving",
                          "background": "renders/motion/pan.mp4",
                          "duration": 3.0, "width": 960, "height": 544})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["background_kind"] == "video"
    assert body["width"] == 960 and body["height"] == 544

    bad = client.post("/api/projects/p6v/comps/moving/background/reroll",
                      json={"prompt": "warmer", "mode": "edit"})
    assert bad.status_code == 400
    assert "clip" in bad.json()["detail"]

    # a clip background with no declared size inherits the CLIP's geometry, not
    # the 1080p default — otherwise every frame is upscaled for nothing
    from conftest import make_clip
    from cutroom.storage import get_storage
    store = get_storage().project("p6v")
    make_clip(store.resolve("renders/motion/real.mp4"), seconds=0.5, size="640x360")
    r = client.post("/api/projects/p6v/comps",
                    json={"shot": "B04-S3", "cid": "sized",
                          "background": "renders/motion/real.mp4"})
    assert (r.json()["width"], r.json()["height"]) == (640, 360)

    # switching backgrounds keeps every earlier one toggleable, clips included
    r = client.post("/api/projects/p6v/comps/moving",
                    json={"background": "renders/stills/plate.png"})
    assert r.json()["background_history"] == ["renders/motion/pan.mp4"]
    assert r.json()["background_kind"] == "still"


def test_auth_token(data_dir, monkeypatch):
    monkeypatch.setenv("CUTROOM_AUTH_TOKEN", "tok123")
    from cutroom import config, db
    config.reset_settings()
    db.reset_db()
    from fastapi.testclient import TestClient
    from cutroom.main import create_app
    with TestClient(create_app()) as c:
        assert c.get("/api/projects").status_code == 401
        ok = c.get("/api/projects",
                   headers={"Authorization": "Bearer tok123"})
        assert ok.status_code == 200
        # media may authenticate via ?token= (for <img>/<video> tags)
        c.post("/api/projects", json={"id": "p"},
               headers={"Authorization": "Bearer tok123"})
        assert c.get("/api/projects/p/media/nope.png?token=tok123"
                     ).status_code == 404  # authed, then missing file


def test_motion_source_is_normalised_and_checked(client):
    """`source` is the one word every caller uses for "start FROM this image".

    The motion lane calls it `plate` internally; the alias is resolved at the
    API edge, and a path that is not in the project is a 400 at submit time —
    the failure this app cannot afford is a job that queues happily and comes
    back animated from the wrong frame.
    """
    from cutroom.db import session_scope
    from cutroom.models import Backend, Job
    from cutroom.storage import get_storage
    from conftest import make_image
    client.post("/api/projects", json={"id": "p4"})
    client.post("/api/projects/p4/shots", json={"sid": "B01-S1"})
    store = get_storage().project("p4")
    make_image(store.resolve("renders/stills/goodbye.png"), 320, 224)
    with session_scope() as s:
        s.get(Backend, "mock").enabled = True

    r = client.post("/api/projects/p4/generate/motion",
                    json={"shot": "B01-S1", "prompt": "the text scrolls",
                          "source": "renders/stills/goodbye.png",
                          "backend": "mock"})
    assert r.status_code == 200, r.text
    with session_scope() as s:
        payload = s.get(Job, r.json()["job"]).payload
    assert payload["plate"] == "renders/stills/goodbye.png"
    assert "source" not in payload

    # a path nobody has: refused, with the path in the message
    r = client.post("/api/projects/p4/generate/motion",
                    json={"shot": "B01-S1", "prompt": "x", "backend": "mock",
                          "plate": "renders/stills/nope.png"})
    assert r.status_code == 400
    assert "renders/stills/nope.png" in r.json()["detail"]

    # a clip is not a plate
    r = client.post("/api/projects/p4/generate/motion",
                    json={"shot": "B01-S1", "prompt": "x", "backend": "mock",
                          "source": "renders/fx/a.mp4"})
    assert r.status_code == 400 and "still" in r.json()["detail"]

    # two different sources is a caller bug, not a coin flip
    r = client.post("/api/projects/p4/generate/motion",
                    json={"shot": "B01-S1", "prompt": "x", "backend": "mock",
                          "source": "renders/stills/goodbye.png",
                          "plate": "renders/stills/other.png"})
    assert r.status_code == 400 and "pass one" in r.json()["detail"]

    # the i2i lane names the field `source` already, and gets the same check
    r = client.post("/api/projects/p4/generate/i2i",
                    json={"shot": "B01-S1", "prompt": "x", "backend": "mock",
                          "source": "renders/stills/gone.png"})
    assert r.status_code == 400 and "renders/stills/gone.png" in r.json()["detail"]

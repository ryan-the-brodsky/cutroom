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

    r = client.post("/api/projects/p1/shots/B01-S1/refs",
                    json={"add": "renders/refs/photo/x.jpg"})
    assert r.json()["refs"] == ["renders/refs/photo/x.jpg"]


def test_curation_keeps_history(client):
    client.post("/api/projects", json={"id": "p2"})
    client.post("/api/projects/p2/shots", json={"sid": "B01-S1"})
    client.post("/api/projects/p2/shots/B01-S1/curate",
                json={"keeper": "renders/stills/a.png", "note": "clean"})
    client.post("/api/projects/p2/shots/B01-S1/curate",
                json={"keeper": "renders/stills/b.png"})
    shot = client.get("/api/projects/p2/shots/B01-S1").json()
    assert shot["keeper"] == "renders/stills/b.png"
    assert "clean" in shot["curation_note"]


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
    assert client.post("/api/projects/p6/comps/dial/delete").json()["ok"]


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

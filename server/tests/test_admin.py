def test_delete_project_removes_rows_and_media(client):
    assert client.post("/api/projects", json={"id": "gone"}).status_code == 200
    assert client.post("/api/projects/gone/shots", json={"sid": "B01-S1", "image_prompt": "x"}).status_code == 200
    r = client.post("/api/projects/gone/delete")
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == "gone"
    assert r.json()["media_removed"] is True
    assert client.get("/api/projects/gone/film").status_code == 404
    assert client.post("/api/projects/gone/delete").status_code == 404


def test_purge_keeps_newest_cuts_and_drops_intermediates(client, tmp_path):
    from cutroom.db import session_scope
    from cutroom.models import Take
    from cutroom.api.deps import store_for
    assert client.post("/api/projects", json={"id": "purgeme"}).status_code == 200
    store = store_for("purgeme")
    with session_scope() as s:
        for i in range(5):
            rel = f"assembly/animatic-{i}.mp4"
            p = store.resolve(rel); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b"x" * 1000)
            s.add(Take(project_id="purgeme", kind="animatic", path=rel, created_at=1000 + i))
        rel = "renders/motion/tests/B01-S1-crop.webm"
        p = store.resolve(rel); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b"y" * 500)
        s.add(Take(project_id="purgeme", kind="crop", path=rel, created_at=999))
    r = client.post("/api/projects/purgeme/purge?keep_cuts=2")
    assert r.status_code == 200, r.text
    assert r.json()["removed"] == {"cuts": 3, "intermediates": 1, "motion": 0}
    left = client.get("/api/projects/purgeme/takes?kind=animatic&limit=50").json()
    left = left if isinstance(left, list) else left.get("takes", [])
    assert len(left) == 2
    o = client.post("/api/system/purge-orphans")
    assert o.status_code == 200


def test_purge_superseded_motion_keeps_source_and_newest(client):
    from cutroom.db import session_scope
    from cutroom.models import Take, Shot
    from cutroom.api.deps import store_for
    assert client.post("/api/projects", json={"id": "purgemo"}).status_code == 200
    store = store_for("purgemo")
    with session_scope() as s:
        s.add(Shot(project_id="purgemo", sid="B01-S1", beat="B01", seconds=5,
                   override={"source": "renders/fx/B01-S1-full-1.mp4"}))
        for i in (1, 2, 3):
            rel = f"renders/fx/B01-S1-full-{i}.mp4"
            p = store.resolve(rel); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b"m" * 100)
            s.add(Take(project_id="purgemo", shot_sid="B01-S1", kind="motion", path=rel, created_at=100 + i))
    r = client.post("/api/projects/purgemo/purge?keep_cuts=0&superseded_motion=true")
    assert r.status_code == 200, r.text
    assert r.json()["removed"]["motion"] == 1          # full-2 goes; full-1 is the source, full-3 newest
    assert store.resolve("renders/fx/B01-S1-full-1.mp4").exists()
    assert store.resolve("renders/fx/B01-S1-full-3.mp4").exists()
    assert not store.resolve("renders/fx/B01-S1-full-2.mp4").exists()

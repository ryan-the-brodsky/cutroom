def test_delete_project_removes_rows_and_media(client):
    assert client.post("/api/projects", json={"id": "gone"}).status_code == 200
    assert client.post("/api/projects/gone/shots", json={"sid": "B01-S1", "image_prompt": "x"}).status_code == 200
    r = client.post("/api/projects/gone/delete")
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == "gone"
    assert r.json()["media_removed"] is True
    assert client.get("/api/projects/gone/film").status_code == 404
    assert client.post("/api/projects/gone/delete").status_code == 404

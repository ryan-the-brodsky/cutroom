from cutroom.api.direction import _context


def test_context_carries_film_summary(client):
    assert client.post("/api/projects", json={"id": "ctxfilm"}).status_code == 200
    r = client.post("/api/projects/ctxfilm/shots", json={
        "sid": "B01-S1", "beat": "B01", "seconds": 6, "register": "wide, night",
        "dialogue": "It begins with a four-line program."})
    assert r.status_code == 200, r.text
    ctx = _context("ctxfilm", None, None)
    assert ctx["project"] == "ctxfilm"
    rows = ctx["film"]
    assert [x["sid"] for x in rows] == ["B01-S1"]
    assert rows[0]["plays"] == "still only" and rows[0]["s"] == 6.0
    assert rows[0]["line"].startswith("It begins")
    # a shot-scoped context still carries the film list plus the shot state
    ctx2 = _context("ctxfilm", "B01-S1", None)
    assert ctx2["shot"] == "B01-S1" and len(ctx2["film"]) == 1

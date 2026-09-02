"""Per-shot reference images: the shape, the endpoints, and what a request
built from them actually carries.

The gap this covers (workstream S, 2026-09-02): `generate_takes lane:"restyle"`
could edit a frame, and the project style register could attach style frames,
but there was no way to say "this is the room, this is the mug, this is her
face" and have the words reach the model with the picture. A reference with no
role sentence is read as content to copy, which is right for a setting and
wrong for a face.
"""
from pathlib import Path

import pytest

from cutroom import refs
from cutroom.adapters.base import BackendConfig, GenRequest
from cutroom.adapters.http_images import OpenRouterImageAdapter, content_parts
from conftest import make_image


# ------------------------------------------------------------------- the shape

def test_a_bare_string_migrates_to_a_character_reference():
    """`override.refs` used to be a list of paths. Those rows still exist."""
    rows = refs.normalize(["renders/stills/her.png",
                           {"path": "renders/stills/room.png", "role": "setting"}])
    assert rows[0] == {"path": "renders/stills/her.png", "role": "character"}
    assert rows[1]["role"] == "setting"


def test_roles_are_coerced_not_rejected():
    assert refs.role_of("SETTING") == "setting"
    assert refs.role_of("location") == "setting"      # a director's word
    assert refs.role_of("object") == "prop"
    assert refs.role_of("nonsense") == "character"    # never reject
    assert refs.role_of(None) == "character"


def test_paths_that_climb_out_of_the_project_are_dropped():
    assert refs.normalize([{"path": "../../etc/passwd"}]) == []
    assert refs.normalize([{"path": ""}]) == []
    assert refs.normalize("not a list") == []


def test_duplicates_collapse_and_four_is_the_cap():
    rows = refs.normalize([f"a/{i}.png" for i in range(6)])
    assert len(rows) == refs.MAX_REFS
    twice = refs.normalize(["a/1.png", {"path": "a/1.png", "role": "prop"}])
    assert len(twice) == 1


def test_merge_puts_the_shots_own_references_first_and_caps_at_four():
    merged = refs.merge(["a/1.png", "a/2.png", "a/3.png"],
                        [{"path": "a/4.png", "role": "prop"},
                         {"path": "a/5.png", "role": "prop"}])
    assert [r["path"] for r in merged] == ["a/1.png", "a/2.png", "a/3.png", "a/4.png"]


def test_every_role_has_a_sentence():
    for role in refs.ROLES:
        assert refs.ROLE_SENTENCE[role].strip().endswith(".")
    assert "face" in refs.ROLE_SENTENCE["character"]
    assert "architecture" in refs.ROLE_SENTENCE["setting"]
    assert "do not copy content" in refs.ROLE_SENTENCE["style"]


# ------------------------------------------------------------------- the API

def _project(client, pid="refproj"):
    client.post("/api/projects", json={"id": pid, "label": pid})
    client.post(f"/api/projects/{pid}/shots",
                json={"sid": "B01-S1", "image_prompt": "a dorm at night",
                      "seconds": 4})
    return pid


def test_add_and_remove_references_with_roles(client, data_dir):
    pid = _project(client)
    r = client.post(f"/api/projects/{pid}/shots/B01-S1/refs",
                    json={"add": {"path": "uploads/room.png", "role": "setting",
                                  "note": "the dorm"}})
    assert r.status_code == 200, r.text
    assert r.json()["refs"] == [{"path": "uploads/room.png", "role": "setting",
                                 "note": "the dorm"}]
    # role may ride alongside a bare path, which is what the tool layer sends
    client.post(f"/api/projects/{pid}/shots/B01-S1/refs",
                json={"add": "uploads/mug.png", "role": "prop"})
    rows = client.post(f"/api/projects/{pid}/shots/B01-S1/refs", json={}).json()
    assert [r["role"] for r in rows["refs"]] == ["setting", "prop"]
    assert rows["roles"] == ["prop", "setting"]
    # remove by role, then by "all"
    out = client.post(f"/api/projects/{pid}/shots/B01-S1/refs",
                      json={"remove": "prop"}).json()
    assert [r["path"] for r in out["refs"]] == ["uploads/room.png"]
    out = client.post(f"/api/projects/{pid}/shots/B01-S1/refs",
                      json={"remove": "all"}).json()
    assert out["refs"] == []


def test_a_fifth_reference_is_refused_rather_than_silently_dropped(client):
    pid = _project(client, "refcap")
    for i in range(4):
        client.post(f"/api/projects/{pid}/shots/B01-S1/refs",
                    json={"add": f"uploads/r{i}.png"})
    r = client.post(f"/api/projects/{pid}/shots/B01-S1/refs",
                    json={"add": "uploads/r5.png"})
    assert r.status_code == 400
    assert "at most 4" in r.json()["detail"]


def test_old_string_refs_migrate_the_first_time_the_shot_is_read(client, data_dir):
    """A row written before roles existed reads back as a character ref, and
    the shot detail carries the migrated shape."""
    from sqlalchemy import select
    from cutroom.db import session_scope
    from cutroom.models import Shot
    pid = _project(client, "refmigrate")
    with session_scope() as s:
        shot = s.execute(select(Shot).where(
            Shot.project_id == pid, Shot.sid == "B01-S1")).scalar_one()
        shot.override = {"refs": ["uploads/old.png"], "seconds": 3}
    detail = client.get(f"/api/projects/{pid}/shots/B01-S1").json()
    assert detail["references"] == [{"path": "uploads/old.png",
                                     "role": "character"}]
    # a write migrates the stored row too, and leaves the rest of the override
    out = client.post(f"/api/projects/{pid}/shots/B01-S1/refs",
                      json={"add": "uploads/new.png", "role": "prop"}).json()
    assert out["refs"][0] == {"path": "uploads/old.png", "role": "character"}
    with session_scope() as s:
        shot = s.execute(select(Shot).where(
            Shot.project_id == pid, Shot.sid == "B01-S1")).scalar_one()
        assert shot.override["seconds"] == 3
        assert shot.override["refs"][1]["role"] == "prop"


def test_unknown_shot_is_a_404(client):
    pid = _project(client, "ref404")
    assert client.post(f"/api/projects/{pid}/shots/NOPE/refs",
                       json={"add": "uploads/x.png"}).status_code == 404


# --------------------------------------------------------------- url fetching

def test_only_http_urls_are_accepted():
    for bad in ("file:///etc/passwd", "data:image/png;base64,AAAA", "", "ftp://x/y.png"):
        with pytest.raises(refs.RefError):
            refs.check_url(bad)


def test_private_network_hosts_are_refused():
    """The dangerous url is the one that points back at the box we run on."""
    for bad in ("http://127.0.0.1/x.png", "http://localhost:8770/x.png",
                "http://169.254.169.254/latest/meta-data",
                "http://10.0.0.5/x.png", "http://[::1]/x.png"):
        with pytest.raises(refs.RefError):
            refs.check_url(bad)


def test_a_public_url_passes_the_host_check():
    assert refs.check_url("https://example.com/a.png").startswith("https://")


def test_non_image_content_is_refused_and_oversize_too():
    with pytest.raises(refs.RefError):
        refs.check_response("text/html", 10)
    with pytest.raises(refs.RefError):
        refs.check_response("application/json", 10)
    with pytest.raises(refs.RefError):
        refs.check_response("image/svg+xml", 10)          # markup, not pixels
    with pytest.raises(refs.RefError):
        refs.check_response("image/png", refs.MAX_FETCH_BYTES + 1)
    refs.check_response("image/png; charset=binary", 1000)  # fine


def test_fetched_files_get_a_safe_name_with_a_real_extension():
    assert refs.filename_for("https://x.com/a b/../room.PNG") == "room.PNG"
    assert refs.filename_for("https://x.com/img?id=3", "image/jpeg") == "img.jpg"
    assert refs.filename_for("https://x.com/", "image/webp") == "reference.webp"


def test_the_fetch_endpoint_rejects_a_private_host(client):
    pid = _project(client, "reffetch")
    r = client.post(f"/api/projects/{pid}/refs/fetch",
                    json={"url": "http://127.0.0.1:9/x.png"})
    assert r.status_code == 400
    assert "private network" in r.json()["detail"]


def test_the_fetch_endpoint_rejects_a_non_image(client, monkeypatch):
    pid = _project(client, "refhtml")

    async def fake_fetch(url):
        raise refs.RefError("that url is text/html, not an image")
    monkeypatch.setattr(refs, "fetch", fake_fetch)
    r = client.post(f"/api/projects/{pid}/refs/fetch",
                    json={"url": "https://example.com/page"})
    assert r.status_code == 400
    assert "not an image" in r.json()["detail"]


def test_a_fetched_image_lands_in_refs_and_becomes_a_take(client, monkeypatch,
                                                          tmp_path):
    pid = _project(client, "refok")
    png = make_image(tmp_path / "room.png", 64, 48).read_bytes()

    async def fake_fetch(url):
        return png, "room.png"
    monkeypatch.setattr(refs, "fetch", fake_fetch)
    r = client.post(f"/api/projects/{pid}/refs/fetch",
                    json={"url": "https://example.com/room.png",
                          "role": "setting", "shot": "B01-S1"})
    assert r.status_code == 200, r.text
    rel = r.json()["rel"]
    assert rel.startswith("refs/") and rel.endswith(".png")
    assert r.json()["role"] == "setting"
    takes = client.get(f"/api/projects/{pid}/takes?kind=ref").json()
    assert [t["path"] for t in takes] == [rel]
    # and it streams back through the media route like any other take
    assert client.get(f"/api/projects/{pid}/media/{rel}").status_code == 200


# ------------------------------------------------- what the request carries

def _req(tmp_path, n_refs=1, roles=("setting",), source=False, style_refs=0):
    images = [make_image(tmp_path / f"ref{i}.png", 32, 24) for i in range(n_refs)]
    style = [make_image(tmp_path / f"style{i}.jpg", 32, 24) for i in range(style_refs)]
    return GenRequest(
        lane="still", workdir=tmp_path, prompt="the dorm at dawn",
        negative="text, watermark",
        source=make_image(tmp_path / "src.png", 32, 24) if source else None,
        references=[(p, roles[i % len(roles)]) for i, p in enumerate(images)],
        refs=style), style


def test_references_come_first_then_style_then_the_prompt(tmp_path):
    req, style = _req(tmp_path, n_refs=2, roles=("setting", "prop"),
                      source=True, style_refs=1)
    parts = content_parts(req, style)
    texts = [p["text"] for p in parts if p["type"] == "text"]
    assert texts[0] == refs.ROLE_SENTENCE["setting"]
    assert texts[1] == refs.ROLE_SENTENCE["prop"]
    assert "Match the visual style" in texts[2]        # the film's own frames
    assert texts[3] == "The image to work from follows."
    # the shot prompt is LAST — that is the part the model renders
    assert texts[-1].startswith("the dorm at dawn")
    assert texts[-1].endswith("Avoid: text, watermark.")
    # every role sentence is immediately followed by its image
    kinds = [p["type"] for p in parts]
    assert kinds[:4] == ["text", "image_url", "text", "image_url"]
    assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_no_references_leaves_the_request_exactly_as_it_was(tmp_path):
    req, _ = _req(tmp_path, n_refs=0)
    parts = content_parts(req, [])
    assert len(parts) == 1 and parts[0]["type"] == "text"


def test_a_fifth_reference_never_reaches_the_model(tmp_path):
    req, _ = _req(tmp_path, n_refs=6, roles=("character",))
    parts = content_parts(req, [])
    assert sum(1 for p in parts if p["type"] == "image_url") == refs.MAX_REFS


def test_the_openrouter_adapter_advertises_reference_support():
    a = OpenRouterImageAdapter(BackendConfig(id="or", type="openrouter-image"))
    assert a.accepts_references is True


def test_the_comfyui_adapter_does_not(tmp_path):
    from cutroom.adapters.registry import ADAPTER_TYPES
    assert ADAPTER_TYPES["comfyui"].accepts_references is False


# ------------------------------------------------- the job handler's choice

def test_the_handler_skips_references_on_a_backend_that_cannot_take_images(
        client, data_dir, tmp_path):
    """A ComfyUI still must not pay to build a request that drops them; it
    logs and goes on."""
    from cutroom.jobs.handlers import shot_references
    from cutroom.storage import get_storage
    pid = _project(client, "refskip")
    store = get_storage().project(pid)
    make_image(Path(store.resolve("uploads/room.png")), 32, 24)
    client.post(f"/api/projects/{pid}/shots/B01-S1/refs",
                json={"add": "uploads/room.png", "role": "setting"})

    class NoImages:
        cfg = BackendConfig(id="local-comfyui", type="comfyui")
        accepts_references = False

    lines: list[str] = []
    got, used = shot_references(pid, "B01-S1", NoImages(), {}, store, lines.append)
    assert got == [] and used == []
    assert "skipped" in lines[0]

    class WithImages(NoImages):
        accepts_references = True

    got, used = shot_references(pid, "B01-S1", WithImages(), {}, store)
    assert [role for _, role in got] == ["setting"]
    assert used == [{"path": "uploads/room.png", "role": "setting"}]


def test_one_off_references_ride_along_with_the_shots_own(client, data_dir):
    from cutroom.jobs.handlers import shot_references
    from cutroom.storage import get_storage
    pid = _project(client, "refoneoff")
    store = get_storage().project(pid)
    for name in ("room.png", "mug.png", "gone.png"):
        if name != "gone.png":
            make_image(Path(store.resolve(f"uploads/{name}")), 32, 24)
    client.post(f"/api/projects/{pid}/shots/B01-S1/refs",
                json={"add": "uploads/room.png", "role": "setting"})

    class WithImages:
        cfg = BackendConfig(id="or", type="openrouter-image")
        accepts_references = True

    got, used = shot_references(
        pid, "B01-S1", WithImages(),
        {"references": [{"image": "uploads/mug.png", "role": "prop"},
                        {"path": "uploads/gone.png", "role": "prop"}]},
        store)
    # the missing file is skipped, never fatal
    assert [role for _, role in got] == ["setting", "prop"]
    assert [r["path"] for r in used] == ["uploads/room.png", "uploads/mug.png"]

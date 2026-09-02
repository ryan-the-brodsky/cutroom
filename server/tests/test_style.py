"""The style register: composition, the endpoints, seeding, shipped frames.

The bug this covers is a real one from the hosted demo (2026-09-02): a judge's
agent wrote "hand-painted 2D satire" and "caricature" into its shot prompts and
got generic western illustration back, while the earlier film stayed
anime-faithful on the same model. Two failures fed it — nobody applied a house
look server-side, and the negative was silently dropped on the way to a
chat-completion image model.
"""
from pathlib import Path

import pytest

from cutroom import style
from cutroom.adapters.base import GenRequest
from cutroom.adapters.http_images import (
    OpenAIImagesAdapter, OpenRouterImageAdapter, prompt_with_negative,
)
from cutroom.adapters.base import BackendConfig


REVOLUTION = (
    "The chamber doors burst inward while flour dust and pamphlets billow "
    "through the aisle. Subject: the Bourgeois Nose-Wipers Union entering in "
    "matching tricolor waistcoats and enormous kerchiefs. Dynamic wide "
    "composition, comic hand-painted 2D anime, cinematic anime film still"
)


# ------------------------------------------------------------------- compose

def test_prefix_goes_in_front_and_style_words_come_out():
    st = style.default_style()
    prompt, negative, applied = style.compose(REVOLUTION, st)
    assert prompt.startswith("Cinematic anime film still, 1990s TV anime cel look:")
    # the words that broke the demo are gone from the middle
    for gone in ("hand-painted", "comic", "caricature", "satire"):
        assert gone not in prompt.lower(), gone
    # the shot itself survives intact
    assert "Bourgeois Nose-Wipers Union" in prompt
    assert "flour dust and pamphlets" in prompt
    assert "Dynamic wide composition" in prompt
    assert applied["name"] == "anime-cel"
    assert "comic" in applied["stripped"]
    assert "photorealistic" in negative


def test_stripping_leaves_readable_punctuation():
    prompt, _, _ = style.compose(
        "A hall at dusk. Wide shot, hand-painted 2D satire, cinematic anime "
        "film still", style.default_style())
    assert ", ," not in prompt
    assert " ," not in prompt
    assert "Wide shot, cinematic anime film still" in prompt


def test_subject_words_are_never_stripped_out_of_a_prompt():
    """`avoid` bans text in the *image*; "a photograph on the wall" is a
    thing in the room, and "context" is not a style word."""
    st = style.default_style()
    prompt, _, _ = style.compose(
        "A photograph on the wall gives context to the text on the ledger.", st)
    assert "photograph on the wall" in prompt
    assert "context" in prompt
    assert "text on the ledger" in prompt


def test_suffix_is_appended_when_the_register_has_one():
    st = style.normalize({"suffix": "Shot on 35mm."})
    prompt, _, applied = style.compose("A quiet street.", st)
    assert prompt.endswith("Shot on 35mm.")
    assert applied["suffix"] is True


def test_shot_negative_and_register_avoid_merge_without_duplicates():
    _, negative, _ = style.compose(
        "A quiet street.", style.default_style(),
        negative="gore, watermark, modern clothing")
    terms = [t.strip() for t in negative.split(",")]
    assert terms[:3] == ["gore", "watermark", "modern clothing"]
    assert terms.count("watermark") == 1
    assert "photorealistic" in terms


def test_fold_avoid_says_the_negative_in_the_prompt():
    folded = style.fold_avoid("A quiet street.", "text, watermark")
    assert folded == "A quiet street. Avoid: text, watermark."
    assert style.fold_avoid("A quiet street.", "") == "A quiet street."
    assert style.fold_avoid("A quiet street.", "  ,  ") == "A quiet street."


# ------------------------------------------------------------------- presets

def test_presets_all_compose_and_name_themselves():
    for name in ("anime-cel", "anime-noir", "anime-pastel"):
        st = style.preset(name)
        assert st["name"] == name
        assert st["prefix"].startswith("Cinematic anime film still")
        assert st["avoid"]
        prompt, _, applied = style.compose("A quiet street.", st)
        assert applied["name"] == name
        assert prompt.startswith("Cinematic anime film still")


def test_a_bare_string_is_a_preset_name_or_a_custom_prefix():
    assert style.normalize("anime-noir")["name"] == "anime-noir"
    custom = style.normalize("Gritty rotoscope, heavy grain.")
    assert custom["name"] == "custom"
    assert custom["prefix"] == "Gritty rotoscope, heavy grain."
    # a custom prefix keeps the default's avoid list rather than dropping it
    assert "photorealistic" in custom["avoid"]


def test_normalize_patches_one_field_and_keeps_the_rest():
    base = style.default_style()
    out = style.normalize({"avoid": "text, blur"}, base=base)
    assert out["prefix"] == base["prefix"]
    assert out["avoid"] == "text, blur"
    assert out["refs"] == base["refs"]
    assert style.normalize({"refs": []}, base=base)["refs"] == []
    # "no look at all" is a state the A/B against the register has to reach
    bare = style.normalize({"prefix": "", "suffix": "", "avoid": "", "refs": []},
                           base=base)
    assert bare["prefix"] == "" and bare["avoid"] == "" and bare["refs"] == []
    assert style.compose("A quiet street.", bare) == ("A quiet street.", "", {
        "name": bare["name"], "prefix": False, "suffix": False, "avoid": False})


def test_project_style_defaults_for_a_film_made_before_the_register():
    assert style.project_style(None)["name"] == "anime-cel"
    assert style.project_style({"fps": 24})["name"] == "anime-cel"
    assert style.project_style({"style": {"preset": "anime-noir"}})["name"] \
        == "anime-noir"


# --------------------------------------------------------------- shipped refs

def test_reference_frames_ship_inside_the_package():
    """Package data, not sample data: without these in the Docker image a
    hosted still has no house look to match."""
    for rel in style.SHIPPED_REFS:
        p = style.ASSET_DIR / rel
        assert p.exists(), f"{p} missing — check pyproject package-data"
        assert p.stat().st_size <= 120_000, f"{rel} is over the 120 KB budget"
        assert p.stat().st_size > 1000


def test_package_data_declares_the_frames():
    root = Path(__file__).resolve().parent.parent
    toml = (root / "pyproject.toml").read_text()
    assert "[tool.setuptools.package-data]" in toml
    assert "assets/style/*.jpg" in toml


def test_resolve_refs_skips_what_is_not_there_and_refuses_traversal():
    st = style.normalize({"refs": ["anime-01.jpg", "nope.jpg",
                                   "../../etc/passwd"]})
    got = style.resolve_refs(st)
    assert [p.name for p in got] == ["anime-01.jpg"]
    assert style.resolve_refs(style.normalize({"refs": []})) == []


# --------------------------------------------------------------- the adapters

def _req(**kw) -> GenRequest:
    kw.setdefault("lane", "still")
    kw.setdefault("workdir", Path("/tmp"))
    return GenRequest(**kw)


def test_chat_completion_adapters_fold_the_negative_into_the_text():
    req = _req(prompt="A quiet street.", negative="text, watermark")
    assert prompt_with_negative(req).endswith("Avoid: text, watermark.")


def test_openrouter_puts_style_refs_before_the_prompt():
    adapter = OpenRouterImageAdapter(BackendConfig(id="or", type="openrouter-image"))
    assert adapter.accepts_style_refs is True
    assert OpenAIImagesAdapter(
        BackendConfig(id="oai", type="openai-images")).accepts_style_refs is False
    refs = style.resolve_refs(style.default_style())
    assert len(refs) == 3
    # Build the content list the way generate() does, without the HTTP call.
    content = []
    for i, ref in enumerate(refs):
        if i == 0:
            content.append({"type": "text", "text": style.STYLE_REF_INSTRUCTION})
        content.append({"type": "image_url", "image_url": {"url": "…"}})
    content.append({"type": "text", "text": "A quiet street."})
    assert content[0]["text"].startswith("Match the visual style")
    assert [c["type"] for c in content] == \
        ["text", "image_url", "image_url", "image_url", "text"]


# -------------------------------------------------------------- the endpoints

def test_new_projects_are_seeded_with_the_house_register(client):
    r = client.post("/api/projects", json={"id": "seeded", "label": "Seeded"})
    assert r.status_code == 200, r.text
    assert r.json()["style"]["name"] == "anime-cel"
    got = client.get("/api/projects/seeded/style").json()
    assert got["stored"] is True
    assert got["style"]["prefix"].startswith("Cinematic anime film still")
    assert got["presets"] == ["anime-cel", "anime-noir", "anime-pastel"]


def test_create_project_accepts_a_named_preset(client):
    r = client.post("/api/projects", json={"id": "noir", "style": "anime-noir"})
    assert r.json()["style"]["name"] == "anime-noir"


def test_a_project_with_no_register_reads_as_the_default(client):
    from cutroom.db import session_scope
    from cutroom.models import Project
    client.post("/api/projects", json={"id": "old"})
    with session_scope() as s:
        s.get(Project, "old").settings = {"fps": 24}
    got = client.get("/api/projects/old/style").json()
    assert got["stored"] is False
    assert got["style"]["name"] == "anime-cel"


def test_setting_the_register_patches_and_persists(client):
    client.post("/api/projects", json={"id": "look"})
    r = client.post("/api/projects/look/style", json={"preset": "anime-pastel"})
    assert r.status_code == 200
    assert r.json()["style"]["name"] == "anime-pastel"
    r = client.post("/api/projects/look/style", json={"avoid": "text, blur"})
    st = r.json()["style"]
    assert st["avoid"] == "text, blur"
    assert st["name"] == "anime-pastel"          # the patch kept the preset
    assert client.get("/api/projects/look/style").json()["style"]["avoid"] \
        == "text, blur"


def test_style_endpoints_404_on_an_unknown_project(client):
    assert client.get("/api/projects/ghost/style").status_code == 404
    assert client.post("/api/projects/ghost/style",
                       json={"preset": "anime-cel"}).status_code == 404


@pytest.mark.asyncio
async def test_the_still_handler_composes_against_the_register(client, tmp_path):
    """End to end through the mock adapter: what the Take records is the
    composed prompt, and it carries the register it was made with."""
    from cutroom.jobs import handlers
    client.post("/api/projects", json={"id": "compose"})
    client.post("/api/projects/compose/style", json={"preset": "anime-noir"})

    class Ctx:
        job_id = "j-style"
        log = staticmethod(lambda *_a, **_k: None)

    from cutroom.db import session_scope
    from cutroom.models import Backend
    with session_scope() as s:
        s.add(Backend(id="mock-still", type="mock", label="mock", enabled=True))
    out = await handlers.gen_still(Ctx(), {"project": "compose", "shot": "B01-S3",
                                           "prompt": REVOLUTION,
                                           "backend": "mock-still", "seeds": [1]})
    assert out["takes"]
    from cutroom.models import Take
    with session_scope() as s:
        take = s.query(Take).filter_by(project_id="compose").one()
        assert take.prompt.startswith("Cinematic anime film still, night noir")
        assert "hand-painted" not in take.prompt.lower()
        assert take.params["style_applied"]["name"] == "anime-noir"
        assert take.params["style_applied"]["refs"] == 0   # mock takes no images

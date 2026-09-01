"""Cast index — parsing prompts/characters.jsonl into resolvable aliases.

The alias rules exist so a director can say "the David Ross close-up" or
"the veteran catcher" and mean the same person. Pinned against the real
game7 characters.jsonl when it is on this machine.
"""
from pathlib import Path

import pytest

from cutroom.importer.game7 import (build_cast, cast_entry, reimport_cast,
                                    _read_jsonl)

REAL = Path("/Users/ryan-the-brodsky/Documents/programming/game7/"
            "prompts/characters.jsonl")


def test_name_and_role_aliases():
    e = cast_entry({"id": "CHAR-ross",
                    "character": "David Ross — the veteran catcher"})
    assert e["id"] == "CHAR-ross"
    assert e["name"] == "David Ross"
    assert e["descriptor"] == "David Ross — the veteran catcher"
    for alias in ("david ross", "david", "ross", "veteran catcher", "catcher"):
        assert alias in e["aliases"], alias


def test_role_qualifiers_are_trimmed_to_a_head_noun():
    e = cast_entry({"id": "CHAR-frank",
                    "character": "Frank — the son at the grave"})
    assert e["aliases"] == ["frank", "son at the grave", "son"]


def test_parenthetical_and_missing_role():
    e = cast_entry({"id": "CHAR-father", "character": "The father (flashback)"})
    assert e["name"] == "The father"
    assert "father" in e["aliases"]


def test_hyphenated_role_keeps_its_head():
    e = cast_entry({"id": "CHAR-montgomery",
                    "character": "Mike Montgomery — the final-out closer"})
    assert "final-out closer" in e["aliases"]
    assert "closer" in e["aliases"]


def test_ignores_rows_without_a_character():
    assert cast_entry({"id": "CHAR-x"}) is None
    assert build_cast([{"id": "CHAR-x"}, {"character": "Ann — the cook"}]) \
        [0]["name"] == "Ann"


@pytest.mark.skipif(not REAL.exists(), reason="game7 repo not on this machine")
def test_the_real_characters_jsonl():
    cast = build_cast(_read_jsonl(REAL))
    assert len(cast) == 17
    by_id = {c["id"]: c for c in cast}
    ross = by_id["CHAR-ross"]
    assert ross["name"] == "David Ross"
    assert {"david", "ross", "david ross", "veteran catcher", "catcher"} \
        <= set(ross["aliases"])
    # every alias is lower-case, non-trivial and unique within its member
    for c in cast:
        assert c["aliases"], c["id"]
        assert len(set(c["aliases"])) == len(c["aliases"])
        for a in c["aliases"]:
            assert a == a.lower() and len(a) >= 3


# ------------------------------------------------------------------ the route


def _tiny_project(tmp_path: Path) -> Path:
    src = tmp_path / "src"
    (src / "prompts").mkdir(parents=True)
    (src / "prompts/shots.jsonl").write_text(
        '{"id": "B01-S1", "beat": "B01", "act": 1, "type": "HERO", '
        '"seconds": 4, "image_prompt": "a dugout. A veteran catcher waits."}\n')
    (src / "prompts/characters.jsonl").write_text(
        '{"id": "CHAR-ross", "character": "David Ross — the veteran catcher"}\n')
    return src


def test_cast_route_and_reimport(client, tmp_path):
    src = _tiny_project(tmp_path)
    from cutroom.importer.game7 import import_game7
    import_game7(str(src), "tiny", log=lambda m: None)

    r = client.get("/api/projects/tiny/cast")
    assert r.status_code == 200
    cast = r.json()["cast"]
    assert cast[0]["id"] == "CHAR-ross"
    assert "catcher" in cast[0]["aliases"]

    # a rename in the source, refreshed without touching media
    (src / "prompts/characters.jsonl").write_text(
        '{"id": "CHAR-ross", "character": "David Ross — the backstop"}\n')
    out = reimport_cast("tiny", str(src), log=lambda m: None)
    assert out == {"cast": 1, "characters": ["CHAR-ross"]}
    assert "backstop" in client.get("/api/projects/tiny/cast").json()["cast"][0]["aliases"]


def test_cast_route_404s_for_unknown_project(client):
    assert client.get("/api/projects/nope/cast").status_code == 404

"""Direction tests: the deterministic grammar, plan validation, plan apply."""
import pytest

from cutroom.director import grammar
from cutroom.director.ops import PlanError, validate_plan


def test_grammar_keep_first_second():
    plan = grammar.parse("keep the first second, freeze the rest",
                         {"asset": "renders/fx/dial.mp4"})
    assert plan["ops"][0]["op"] == "freeze_tail"
    assert plan["ops"][0]["live"] == 1.0
    assert plan["ops"][0]["clip"] == "renders/fx/dial.mp4"


def test_grammar_freeze_from_mark():
    plan = grammar.parse("freeze from the 1.5 second mark onward",
                         {"asset": "a.webm"})
    assert plan["ops"][0]["live"] == 1.5


def test_grammar_rest_of_line_uses_vo_duration():
    plan = grammar.parse(
        "keep the first second and hold his pose for the rest of the line",
        {"asset": "a.webm", "shot": "B10-S2", "vo_duration": 4.2})
    op = plan["ops"][0]
    assert op["op"] == "freeze_tail"
    assert op["total"] == pytest.approx(4.5)


def test_grammar_timing_and_source():
    plan = grammar.parse("make it 6 seconds", {"shot": "B01-S1"})
    assert plan["ops"][0] == {"op": "set_seconds", "shot": "B01-S1",
                              "seconds": 6.0}
    plan = grammar.parse("use this as the timeline source",
                         {"shot": "B01-S1", "asset": "renders/fx/x.mp4"})
    assert plan["ops"][0]["op"] == "set_source"


def test_grammar_assemble():
    plan = grammar.parse("cut the film, act 2 at 1080", {})
    assert plan["ops"][0] == {"op": "assemble", "scope": "act2", "res": "1080"}


def test_grammar_returns_none_for_rich_instructions():
    assert grammar.parse("give the crowd more energy and re-time the swing "
                         "to land on the crack of the bat", {}) is None


def test_validate_plan_rejects_unknown_ops():
    with pytest.raises(PlanError):
        validate_plan({"ops": [{"op": "explode_stadium"}]})
    with pytest.raises(PlanError):
        validate_plan({"ops": [{"op": "freeze_tail"}]})   # missing clip
    with pytest.raises(PlanError):
        validate_plan({"ops": [{"op": "freeze_tail", "clip": "a",
                                "zoom": 2}]})             # unknown arg (banned)


def test_apply_plan_state_and_jobs(client):
    client.post("/api/projects", json={"id": "d1"})
    client.post("/api/projects/d1/shots", json={"sid": "B01-S1"})
    r = client.post("/api/projects/d1/plan/apply", json={"ops": [
        {"op": "set_seconds", "shot": "B01-S1", "seconds": 8},
        {"op": "freeze_tail", "clip": "renders/fx/x.mp4", "live": 1.0},
        {"op": "assemble", "scope": "full", "res": "720"},
    ]})
    assert r.status_code == 200
    results = r.json()["results"]
    assert results[0]["applied"] is True
    assert results[1]["job"] and results[1]["pool"] == "cpu"
    assert results[2]["job"]
    jobs = client.get("/api/jobs?project=d1").json()
    assert {j["type"] for j in jobs} == {"gen.freeze", "animatic.assemble"}
    shot = client.get("/api/projects/d1/shots/B01-S1").json()
    assert shot["seconds"] == 8


def test_direct_endpoint_uses_grammar(client):
    client.post("/api/projects", json={"id": "d2"})
    client.post("/api/projects/d2/shots", json={"sid": "B01-S1"})
    r = client.post("/api/projects/d2/direct",
                    json={"instruction": "make it 6 seconds",
                          "shot": "B01-S1"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "grammar"
    assert body["plan"]["ops"][0]["op"] == "set_seconds"


def test_direct_endpoint_422_without_planner(client):
    client.post("/api/projects", json={"id": "d3"})
    r = client.post("/api/projects/d3/direct",
                    json={"instruction": "make the crowd feel alive"})
    assert r.status_code == 422   # no LLM backend enabled in a bare test env

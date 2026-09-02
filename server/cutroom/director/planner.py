"""LLM planning — richer instructions → validated EditPlans.

Providers are Backend rows of type `anthropic` or `openai-chat`; the planner
speaks both protocols over httpx directly (no SDK weight). The grammar runs
first; the LLM only sees instructions the grammar couldn't compile.
"""
from __future__ import annotations

import json
import re

import httpx

from .ops import ops_documentation, validate_plan

ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5"

SYSTEM = """You compile a film director's instruction into an EditPlan for an
AI-anime production platform (limited-animation cel pipeline).

Doctrine that binds your plans:
- Clips PLAY IN FULL at the motion backend's own clip length; never add a
  freeze_after "for safety". Freeze-tail and chain-stitching are SURGICAL
  repair tools: when a clip is good for its first N seconds and then drifts,
  keep the good frames and hold or continue from them instead of rerolling the
  whole clip. They are not defaults. The historical FIRST-SECOND LAW (2026-07)
  applied to the local LTX lane only.
- Holds are TRUE freezes. Never propose zooms, Ken Burns, or ambient wobble.
- Cel discipline: animate regions (gen_motion with region), never regenerate
  the whole plate for a local change.
- INK-FIRST: elements entering frame must exist in the start image
  (start_frame) or they render off-style.
- Never overwrite existing takes; ops always create new outputs.

Available ops (args with ? are optional):
{ops}

Context (the shot/asset the director is looking at) is given as JSON. Use
project-relative paths from the context verbatim. If the instruction cannot
be expressed with these ops, return an empty ops list and explain in note."""


class PlannerError(RuntimeError):
    pass


def _plan_tool() -> dict:
    return {
        "name": "emit_plan",
        "description": "Emit the compiled EditPlan.",
        "input_schema": {
            "type": "object",
            "properties": {
                "ops": {"type": "array", "items": {"type": "object"}},
                "note": {"type": "string"},
            },
            "required": ["ops"],
        },
    }


async def plan_with_anthropic(instruction: str, context: dict,
                              backend) -> dict:
    key = backend.api_key
    if not key:
        raise PlannerError("anthropic backend has no api key")
    model = (backend.options or {}).get("model", DEFAULT_ANTHROPIC_MODEL)
    base = (backend.base_url or "https://api.anthropic.com").rstrip("/")
    body = {
        "model": model,
        "max_tokens": 2000,
        "system": SYSTEM.format(ops=ops_documentation()),
        "messages": [{"role": "user", "content":
                      f"CONTEXT:\n{json.dumps(context, indent=1)}\n\n"
                      f"DIRECTOR: {instruction}"}],
        "tools": [_plan_tool()],
        "tool_choice": {"type": "tool", "name": "emit_plan"},
    }
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(base + "/v1/messages", json=body,
                         headers={"x-api-key": key,
                                  "anthropic-version": ANTHROPIC_VERSION})
    if r.status_code != 200:
        raise PlannerError(f"anthropic [{r.status_code}]: {r.text[:400]}")
    for block in r.json().get("content", []):
        if block.get("type") == "tool_use" and block.get("name") == "emit_plan":
            return validate_plan(block["input"])
    raise PlannerError("anthropic returned no plan")


async def plan_with_openai(instruction: str, context: dict, backend) -> dict:
    base = (backend.base_url or "").rstrip("/")
    if not base:
        raise PlannerError("openai-chat backend has no base_url")
    model = (backend.options or {}).get("model", "")
    sys_prompt = SYSTEM.format(ops=ops_documentation()) + \
        "\nRespond with ONLY a JSON object: {\"ops\": [...], \"note\": \"...\"}"
    body = {"model": model or "default",
            "messages": [{"role": "system", "content": sys_prompt},
                         {"role": "user", "content":
                          f"CONTEXT:\n{json.dumps(context)}\n\n"
                          f"DIRECTOR: {instruction}"}],
            "max_tokens": 2000, "temperature": 0}
    headers = {}
    if backend.api_key:
        headers["Authorization"] = f"Bearer {backend.api_key}"
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(base + "/chat/completions", json=body, headers=headers)
    if r.status_code != 200:
        raise PlannerError(f"openai-chat [{r.status_code}]: {r.text[:400]}")
    text = r.json()["choices"][0]["message"]["content"] or ""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise PlannerError(f"no JSON in planner response: {text[:200]}")
    return validate_plan(json.loads(m.group(0)))


async def plan(instruction: str, context: dict, backend) -> dict:
    if backend.type == "anthropic":
        return await plan_with_anthropic(instruction, context, backend)
    if backend.type == "openai-chat":
        return await plan_with_openai(instruction, context, backend)
    raise PlannerError(f"backend type {backend.type} cannot plan")

"""Director chat providers.

anthropic   — hosted-safe agent loop: Claude gets function tools scoped to the
              project (inspect the film, compile & run EditPlans). No shell.
openai-chat — advisory (LM Studio / mlx / OpenRouter / any compatible server).
claude-cli  — self-host power mode: spawns `claude -p` in the project
              workspace (enabled only by CUTROOM_ALLOW_CLAUDE_CLI).

All providers yield SSE-able event dicts: {kind: text|tool|plan|done|error}.
"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncGenerator

import httpx

from ..config import get_settings
from ..db import session_scope
from ..storage import get_storage
from .. import film
from .apply import apply_plan
from .ops import ops_documentation
from .planner import ANTHROPIC_VERSION, DEFAULT_ANTHROPIC_MODEL

MAX_TURNS = 8

CHAT_SYSTEM = """You are the on-call film technician for an AI-anime
production running on the Cutroom platform. The director speaks from the
production UI; you inspect the project with your tools and execute edits by
compiling them into EditPlans and running them.

Doctrine (binding):
- Clips PLAY IN FULL at the motion backend's own clip length. Freeze-tail and
  chain-stitching are SURGICAL repair tools: when a clip is good for its first
  N seconds and then drifts, keep the good frames and hold or continue from
  them instead of rerolling. They are not defaults. The historical
  FIRST-SECOND LAW (2026-07) applied to the local LTX lane only.
- Holds are TRUE freezes — never zooms, never Ken Burns, never wobble.
- Cel discipline: animate regions, not whole plates, for local motion.
- INK-FIRST: entering elements must exist in the start frame.
- Never overwrite takes; every op creates new outputs.
- Report exactly what you ran and where outputs will land.

Ops vocabulary:
{ops}

When the director's instruction maps to ops, call run_plan. Jobs run async —
report the job ids. Keep replies terse and concrete."""


def _tools() -> list[dict]:
    return [
        {"name": "get_film",
         "description": "Compact film overview: every shot's sid, seconds, "
                        "active source, keeper, vo presence.",
         "input_schema": {"type": "object", "properties": {}}},
        {"name": "get_shot",
         "description": "Full state for one shot: prompts, takes, comps, "
                        "override.",
         "input_schema": {"type": "object",
                          "properties": {"sid": {"type": "string"}},
                          "required": ["sid"]}},
        {"name": "run_plan",
         "description": "Validate and execute an EditPlan "
                        "({ops:[{op,...}], note}). State ops apply "
                        "immediately; generative ops return job ids.",
         "input_schema": {"type": "object",
                          "properties": {"ops": {"type": "array",
                                                 "items": {"type": "object"}},
                                         "note": {"type": "string"}},
                          "required": ["ops"]}},
        {"name": "list_backends",
         "description": "Enabled generation backends and the lanes they serve.",
         "input_schema": {"type": "object", "properties": {}}},
    ]


def _tool_result(project: str, name: str, args: dict) -> dict:
    store = get_storage().project(project)
    if name == "get_film":
        with session_scope() as s:
            shots = film.shots_ordered(s, project)
            takes = film.takes_by_shot(s, project)
            return {"shots": [
                {"sid": sh.sid, "beat": sh.beat, "act": sh.act,
                 "seconds": (sh.override or {}).get("seconds", sh.seconds),
                 "type": sh.type, "keeper": sh.keeper,
                 "active_source": film.active_source(store, sh,
                                                     takes.get(sh.sid, [])),
                 "vo": bool(film.vo_paths(store, sh.sid, sh.beat,
                                          takes.get(sh.sid, [])))}
                for sh in shots]}
    if name == "get_shot":
        with session_scope() as s:
            shots = {sh.sid: sh for sh in film.shots_ordered(s, project)}
            sh = shots.get(args.get("sid", ""))
            if not sh:
                return {"error": f"no shot {args.get('sid')}"}
            takes = film.takes_by_shot(s, project).get(sh.sid, [])
            entry = film.film_entry(store, sh, takes)
            from ..models import Comp
            comps = s.query(Comp).filter_by(project_id=project,
                                            shot_sid=sh.sid).all()
            entry["comps"] = [{"cid": c.cid, "background": c.background,
                               "layers": c.layers} for c in comps]
            return entry
    if name == "run_plan":
        try:
            return apply_plan(project, args)
        except Exception as e:
            return {"error": str(e)}
    if name == "list_backends":
        from ..models import Backend
        from ..adapters.registry import ADAPTER_TYPES
        with session_scope() as s:
            return {"backends": [
                {"id": b.id, "type": b.type, "label": b.label,
                 "lanes": sorted(getattr(ADAPTER_TYPES.get(b.type), "lanes",
                                         set()))}
                for b in s.query(Backend).filter_by(enabled=True)]}
    return {"error": f"unknown tool {name}"}


async def stream_anthropic(project: str, message: str, backend,
                           context: dict) -> AsyncGenerator[dict, None]:
    key = backend.api_key
    if not key:
        yield {"kind": "error", "text": "anthropic backend has no API key"}
        return
    model = (backend.options or {}).get("model", DEFAULT_ANTHROPIC_MODEL)
    base = (backend.base_url or "https://api.anthropic.com").rstrip("/")
    messages = [{"role": "user", "content":
                 f"CONTEXT: {json.dumps(context)}\n\nDIRECTOR: {message}"}]
    final_text = []
    async with httpx.AsyncClient(timeout=180) as c:
        for _turn in range(MAX_TURNS):
            r = await c.post(base + "/v1/messages", json={
                "model": model, "max_tokens": 3000,
                "system": CHAT_SYSTEM.format(ops=ops_documentation()),
                "messages": messages, "tools": _tools()},
                headers={"x-api-key": key,
                         "anthropic-version": ANTHROPIC_VERSION})
            if r.status_code != 200:
                yield {"kind": "error",
                       "text": f"anthropic [{r.status_code}]: {r.text[:300]}"}
                return
            data = r.json()
            content = data.get("content", [])
            tool_uses = []
            for block in content:
                if block["type"] == "text" and block.get("text"):
                    final_text.append(block["text"])
                    yield {"kind": "text", "text": block["text"]}
                elif block["type"] == "tool_use":
                    tool_uses.append(block)
                    yield {"kind": "tool",
                           "text": f"{block['name']} "
                                   f"{json.dumps(block['input'])[:200]}"}
            if data.get("stop_reason") != "tool_use" or not tool_uses:
                break
            messages.append({"role": "assistant", "content": content})
            results = []
            for tu in tool_uses:
                out = await asyncio.to_thread(_tool_result, project,
                                              tu["name"], tu["input"])
                if tu["name"] == "run_plan" and "results" in out:
                    yield {"kind": "plan", "text": json.dumps(out)}
                results.append({"type": "tool_result",
                                "tool_use_id": tu["id"],
                                "content": json.dumps(out)[:8000]})
            messages.append({"role": "user", "content": results})
    yield {"kind": "done", "text": "\n".join(final_text)[-4000:]}


async def stream_openai(project: str, message: str, backend,
                        context: dict) -> AsyncGenerator[dict, None]:
    base = (backend.base_url or "").rstrip("/")
    if not base:
        yield {"kind": "error", "text": "openai-chat backend has no base_url"}
        return
    sys_prompt = ("You are a production advisor for an AI-anime film on the "
                  "Cutroom platform (cel pipeline: still plates + region i2v "
                  "+ freeze/chain edits). You cannot run tools; give concrete, "
                  f"terse guidance. Context: {json.dumps(context)[:2000]}")
    body = {"model": (backend.options or {}).get("model") or "default",
            "messages": [{"role": "system", "content": sys_prompt},
                         {"role": "user", "content": message}],
            "max_tokens": 900}
    headers = {}
    if backend.api_key:
        headers["Authorization"] = f"Bearer {backend.api_key}"
    try:
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(base + "/chat/completions", json=body,
                             headers=headers)
        if r.status_code == 200:
            msg = r.json()["choices"][0]["message"]
            # reasoning models (GLM 5.3 Flash) can spend the whole budget on
            # thinking and return a null content — say so instead of "null"
            text = msg.get("content") or msg.get("reasoning") or \
                "[no content — raise max_tokens on this provider]"
        else:
            text = f"[provider error {r.status_code}]"
    except Exception as e:
        text = f"[provider error: {e}]"
    yield {"kind": "text", "text": text}
    yield {"kind": "done", "text": text[-4000:]}


async def stream_claude_cli(project: str, message: str, backend,
                            context: dict) -> AsyncGenerator[dict, None]:
    settings = get_settings()
    if not settings.allow_claude_cli:
        yield {"kind": "error",
               "text": "claude-cli provider is disabled "
                       "(set CUTROOM_ALLOW_CLAUDE_CLI=1 on a self-host)"}
        return
    store = get_storage().project(project)
    api = f"http://{settings.host}:{settings.port}"
    auth = (f" -H 'Authorization: Bearer {settings.auth_token}'"
            if settings.auth_token else "")
    prompt = f"""You are the on-call film technician for the Cutroom project
'{project}'. Its media workspace is this directory. The platform API is at
{api} (curl{auth}). Key routes: GET /api/projects/{project}/film ·
POST /api/projects/{project}/direct {{"instruction": ...}} (plan only) ·
POST /api/projects/{project}/plan/apply {{"ops": [...]}} · POST
/api/projects/{project}/generate/<still|i2i|motion|chain|freeze|vo> ·
GET /api/jobs. Ops vocabulary:\n{ops_documentation()}\n
Rules: never overwrite renders; verify results by extracting and VIEWING
frames before declaring success; report what you changed and where outputs
live.\nCONTEXT: {json.dumps(context)}\nDIRECTOR: {message}"""
    argv = [settings.claude_cli_bin, "-p", prompt,
            "--model", (backend.options or {}).get("model", "opus"),
            "--output-format", "stream-json", "--verbose",
            "--dangerously-skip-permissions"]
    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=str(store.root),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    full = []
    assert proc.stdout is not None
    async for raw in proc.stdout:
        line = raw.decode(errors="replace").strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            yield {"kind": "raw", "text": line}
            continue
        if ev.get("type") == "assistant":
            for blk in ev.get("message", {}).get("content", []):
                if blk.get("type") == "text":
                    full.append(blk["text"])
                    yield {"kind": "text", "text": blk["text"]}
                elif blk.get("type") == "tool_use":
                    yield {"kind": "tool",
                           "text": f"{blk.get('name')} "
                                   f"{json.dumps(blk.get('input', {}))[:200]}"}
        elif ev.get("type") == "result":
            yield {"kind": "done", "text": (ev.get("result") or "")[:4000]}
    await proc.wait()


def stream_for(backend):
    return {"anthropic": stream_anthropic,
            "openai-chat": stream_openai,
            "claude-cli": stream_claude_cli}.get(backend.type)

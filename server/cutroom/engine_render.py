"""Drive the lifted FreeCut render engine as a co-process.

The engine is a node + Playwright + built-harness bundle (the FreeCut clone).
We shell out to `render-cutroom.mjs`, which serves the dist harness + the
project's media from one COEP-isolated origin and renders a compiler-produced
timeline input to a video file. Kept a subprocess (the license firewall + the
"engine is swappable" seam): our server never imports the engine's code.

Configure via env (session/deploy):
  CUTROOM_ENGINE_DIR   the built FreeCut clone (needs dist/ + render-cutroom.mjs)
  CUTROOM_NODE_BIN     node binary (default: "node" on PATH)
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Callable


class EngineError(RuntimeError):
    pass


def engine_dir() -> Path | None:
    d = os.environ.get("CUTROOM_ENGINE_DIR")
    return Path(d) if d else None


def node_bin() -> str:
    return os.environ.get("CUTROOM_NODE_BIN", "node")


def engine_available() -> bool:
    d = engine_dir()
    return bool(d and (d / "render-cutroom.mjs").exists()
               and (d / "dist" / "headless.html").exists())


def render_timeline_input(project_root: str | Path, input_dict: dict,
                          out_path: str | Path, *, scope_sec: float | None = None,
                          log: Callable[[str], None] = lambda s: None,
                          timeout: int = 1200) -> dict:
    """Render a `to_freecut_render_input` dict to `out_path` via the engine."""
    d = engine_dir()
    if not engine_available():
        raise EngineError(
            "render engine unavailable — set CUTROOM_ENGINE_DIR to a built "
            "FreeCut clone (with dist/ and render-cutroom.mjs) and CUTROOM_NODE_BIN")
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    job = {"input": input_dict, "root": str(project_root), "out": str(out_path)}
    if scope_sec:
        job["scopeSec"] = float(scope_sec)

    fd, jobfile = tempfile.mkstemp(suffix=".json", prefix="cutroom_render_")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(job, f)
        log(f"engine render → {out_path.name}"
            + (f" (first {scope_sec}s)" if scope_sec else " (full)"))
        proc = subprocess.run(
            [node_bin(), str(d / "render-cutroom.mjs"), jobfile],
            capture_output=True, text=True, timeout=timeout, cwd=str(d))
        if proc.stderr:
            for line in proc.stderr.strip().splitlines()[-8:]:
                log(f"  {line}")
        if proc.returncode != 0:
            raise EngineError(f"engine exited {proc.returncode}: "
                              f"{proc.stderr[-1500:] or proc.stdout[-1500:]}")
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip().startswith("{")]
        if not lines:
            raise EngineError(f"no result from engine: {proc.stdout[-500:]}")
        result = json.loads(lines[-1])
        if not result.get("ok"):
            raise EngineError(f"engine reported failure: {result.get('error')}")
        if not out_path.exists():
            raise EngineError("engine reported success but produced no file")
        log(f"engine render done: {out_path.stat().st_size // 1000} KB")
        return result
    finally:
        try:
            os.unlink(jobfile)
        except OSError:
            pass

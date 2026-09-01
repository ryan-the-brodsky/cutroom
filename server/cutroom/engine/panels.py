"""Panel screens — the Ping Pong / Dezaki manga-screen grammar.

Thin wrapper over the vendored, self-contained panel_engine (the
anime-panel-shot skill's engine): polygonal manga panels entering over a base
in a designed rhythm, video-in-panel, border-break figures, speed-line fields,
composed collapses. Output is the clip plus a .cues.json sidecar — one SFX
tick per panel entry (the audio contract).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from . import panel_engine


def render_panel_script(spec: dict, out: str | Path,
                        asset_dirs: list[str | Path] | None = None,
                        webm_sibling: bool = True,
                        log: Callable[[str], None] = lambda s: None) -> dict:
    """Render a panel spec (fx-script form or bare {"panels": [...]}) to mp4
    + cues sidecar. asset_dirs are searched for panel sources."""
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # panel_engine resolves assets via a module-level dir list.
    old_dirs = list(panel_engine.ASSET_DIRS)
    try:
        for d in (asset_dirs or []):
            panel_engine.ASSET_DIRS.append(str(d))
        panel_engine.run_script(spec, str(out), webm=webm_sibling)
    finally:
        panel_engine.ASSET_DIRS[:] = old_dirs
    cues_path = Path(str(out).rsplit(".", 1)[0] + ".cues.json")
    cues = []
    if cues_path.exists():
        try:
            data = json.loads(cues_path.read_text())
            cues = data.get("cues", []) if isinstance(data, dict) else data
        except Exception:
            cues = []
    log(f"panel screen rendered -> {out} ({len(cues)} cues)")
    return {"out": str(out), "cues": cues, "cues_path": str(cues_path)}

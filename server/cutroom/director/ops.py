"""The EditPlan ops vocabulary — natural-language direction compiles to this.

A plan is {"ops": [{"op": <name>, ...args}], "note": str}. Ops either mutate
project state directly (set_*) or submit jobs (gen_*, render_*, freeze_tail,
assemble). The vocabulary is the same one the original single-machine pipeline
documented for its own director grammar, now a validated, previewable schema.
"""
from __future__ import annotations

from typing import Any

# op name → {arg: (required, description)}
OPS: dict[str, dict[str, tuple[bool, str]]] = {
    "freeze_tail": {
        "clip": (True, "project-relative clip path"),
        "live": (False, "seconds of live motion kept (default 1.0)"),
        "total": (False, "output duration; default source duration"),
        "name": (False, "output name"),
    },
    "trim": {
        "clip": (True, "project-relative clip path"),
        "start": (False, "trim start seconds (default 0)"),
        "end": (False, "trim end seconds"),
        "name": (False, "output name"),
    },
    "chain": {
        "plate": (True, "anchor still (project-relative)"),
        "beats": (True, "[{prompt, live, breath}] — front-load each action; "
                        "≤1.2s live, 0.3–0.6s breath, end in a holdable pose"),
        "name": (False, "output name"),
        "shot": (False, "shot sid"),
    },
    "gen_still": {
        "prompt": (True, "image prompt"),
        "shot": (False, "shot sid"),
        "name": (False, "output name"),
        "seeds": (False, "list of seeds"),
        "width": (False, ""), "height": (False, ""),
        "backend": (False, "backend id"), "model": (False, "model override"),
        "negative": (False, ""),
    },
    "gen_i2i": {
        "source": (True, "source image (project-relative)"),
        "prompt": (True, ""),
        "denoise": (False, "0.55 keeps layout, 0.85 restyles (default 0.85)"),
        "shot": (False, ""), "name": (False, ""), "seeds": (False, ""),
        "backend": (False, ""), "model": (False, ""),
    },
    "gen_motion": {
        "plate": (True, "the approved still (project-relative)"),
        "prompt": (True, "motion prompt — name only what moves"),
        "region": (False, "[l,t,r,b] px or 0..1 — omit for full-frame"),
        "frames": (False, "8k+1 (97 ≈ 4s)"), "steps": (False, ""),
        "cfg": (False, ""), "seed": (False, ""),
        "feather": (False, ""), "matte": (False, "window|figure"),
        "start_frame": (False, "INK-FIRST staged start image"),
        "freeze_after": (False, "seconds — freeze-tail the result. Only for "
                         "a model that drifts after N seconds; omit and the "
                         "clip plays in full"),
        "shot": (False, ""), "name": (False, ""),
        "backend": (False, ""), "model": (False, ""),
    },
    "gen_vo": {
        "text": (True, "line text; ElevenLabs v3 tags pass through"),
        "voice": (False, "voice id"),
        "treatment": (False, "voice chain the line is heard through: "
                      "radio|phone|megaphone|hall (default none)"),
        "shot": (False, ""), "name": (False, ""),
        "backend": (False, ""),
        "stability": (False, ""), "style": (False, ""), "speed": (False, ""),
    },
    "set_keeper": {
        "shot": (True, "shot sid"),
        "path": (True, "project-relative still path"),
        "note": (False, "curation note"),
    },
    "set_source": {
        "shot": (True, ""),
        "source": (True, "project-relative playing source (or null to clear)"),
    },
    "set_seconds": {"shot": (True, ""), "seconds": (True, "")},
    "set_vo": {
        "shot": (True, ""),
        "file": (False, "project-relative VO file"),
        "offset": (False, "seconds"), "mute": (False, "bool"),
    },
    "attach_ref": {"shot": (True, ""), "path": (True, "reference image")},
    "create_comp": {
        "shot": (False, ""), "background": (True, "plate (project-relative)"),
        "duration": (False, ""), "cid": (False, "comp id"),
    },
    "add_layer": {
        "comp": (True, "comp id"),
        "region": (True, "[l,t,r,b]"),
        "prompt": (True, "motion prompt for the cel"),
        "feather": (False, ""), "matte": (False, ""),
        "frames": (False, ""), "steps": (False, ""), "cfg": (False, ""),
    },
    "reroll_layer": {
        "comp": (True, ""), "layer": (True, "layer id"),
        "prompt": (False, "new prompt (default: layer's)"),
    },
    "reroll_background": {
        "comp": (True, ""), "prompt": (True, ""),
        "denoise": (False, "0.55 keeps the staged geometry (default)"),
    },
    "render_comp": {"comp": (True, "")},
    "render_panels": {
        "spec": (True, "panel-screen spec dict (fx-script form)"),
        "name": (False, ""), "shot": (False, ""),
    },
    "assemble": {
        "scope": (False, "full | act1..act4 (default full)"),
        "res": (False, "720 | 1080 (default 720)"),
    },
}

STATE_OPS = {"set_keeper", "set_source", "set_seconds", "set_vo", "attach_ref",
             "create_comp", "add_layer"}


class PlanError(ValueError):
    pass


def validate_plan(plan: Any) -> dict:
    if not isinstance(plan, dict) or not isinstance(plan.get("ops"), list):
        raise PlanError("plan must be {'ops': [...], 'note': str}")
    if not plan["ops"]:
        raise PlanError("plan has no ops")
    norm = []
    for i, op in enumerate(plan["ops"]):
        if not isinstance(op, dict) or "op" not in op:
            raise PlanError(f"op {i} missing 'op'")
        name = op["op"]
        schema = OPS.get(name)
        if schema is None:
            raise PlanError(f"unknown op '{name}' (know: {sorted(OPS)})")
        for arg, (required, _desc) in schema.items():
            if required and op.get(arg) in (None, ""):
                raise PlanError(f"op {i} ({name}) missing required '{arg}'")
        unknown = set(op) - set(schema) - {"op"}
        if unknown:
            raise PlanError(f"op {i} ({name}) unknown args {sorted(unknown)}")
        norm.append(op)
    return {"ops": norm, "note": str(plan.get("note", ""))}


def ops_documentation() -> str:
    """The vocabulary rendered for LLM planners."""
    lines = []
    for name, schema in OPS.items():
        args = ", ".join(
            f"{a}{'' if req else '?'}" + (f" ({d})" if d else "")
            for a, (req, d) in schema.items())
        lines.append(f"- {name}: {args}")
    return "\n".join(lines)

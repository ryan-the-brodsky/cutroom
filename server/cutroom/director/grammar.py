"""Deterministic director grammar — the FIRST-SECOND-LAW edit language,
parsed without any LLM (the product works with zero API keys).

Ported from the director-cut skill's command table:
  "keep the first second"                → freeze_tail live=1.0
  "keep the first 1.5 seconds"           → freeze_tail live=1.5
  "freeze from the 2 second mark"        → freeze_tail live=2.0
  "…for the rest of the line"            → total = VO duration + 0.3 pad
  "hold his pose for the remainder…"     → same
  "make it 6 seconds / hold for 6s"      → set_seconds
  "use this as the (timeline) source"    → set_source (context asset)
  "mute the vo"                          → set_vo mute
  "this is the keeper / pick this one"   → set_keeper (context asset)
  "cut the film / assemble (act 2)"      → assemble
  "trim to the first 2 seconds"          → trim

Context dict: {shot, asset (selected project-relative path), vo_duration}.
Returns a validated plan or None (→ hand to the LLM planner).
"""
from __future__ import annotations

import re

from .ops import validate_plan

NUM = r"(\d+(?:\.\d+)?)"


def _num(m: re.Match, group: int = 1, default: float | None = None) -> float | None:
    try:
        return float(m.group(group))
    except Exception:
        return default


CLIP_EXTS = (".mp4", ".webm", ".mov")


def parse(instruction: str, ctx: dict | None = None) -> dict | None:
    ctx = ctx or {}
    text = instruction.strip().lower()
    asset = ctx.get("asset")
    clip = asset if asset and asset.lower().endswith(CLIP_EXTS) else None
    shot = ctx.get("shot")
    vo_dur = ctx.get("vo_duration")
    ops: list[dict] = []
    notes: list[str] = []

    wants_line_length = bool(re.search(
        r"(rest|remainder|duration|length) of (the|his|her|their) line", text))
    total = None
    if wants_line_length:
        if vo_dur:
            total = round(float(vo_dur) + 0.3, 3)
            notes.append(f"total = VO line {vo_dur}s + 0.3s tail pad")
        else:
            notes.append("wanted line duration but no VO on this shot — "
                         "total left as source duration")

    # --- freeze family -----------------------------------------------------
    m = (re.search(rf"keep (?:the |only the )?first {NUM}\s*(?:s\b|sec|second)", text)
         or re.search(rf"freeze (?:from|at) (?:the )?{NUM}", text)
         or re.search(rf"first {NUM}\s*(?:s\b|sec|second)s?,? (?:then )?(?:freeze|hold)", text))
    if m or re.search(r"keep (?:the )?first second\b", text) or \
            re.search(r"\bfreeze (?:the )?(rest|tail)\b", text) or \
            (wants_line_length and re.search(r"\b(hold|freeze|extend|pose)\b", text)):
        live = _num(m) if m else 1.0
        if not clip:
            return None  # freeze needs a CLIP in context (stills can't freeze)
        op = {"op": "freeze_tail", "clip": clip, "live": live or 1.0}
        if total:
            op["total"] = total
        ops.append(op)

    # --- trim ---------------------------------------------------------------
    m = re.search(rf"(?:trim|cut) (?:it |the clip )?(?:to|at) (?:the )?(?:first )?{NUM}\s*(?:s\b|sec|second)", text)
    if m and clip and not ops:
        ops.append({"op": "trim", "clip": clip, "end": _num(m)})

    # --- timing -------------------------------------------------------------
    m = re.search(rf"(?:make (?:it|the shot)|hold (?:it|the shot)? ?for|set (?:it|the duration) to) {NUM}\s*(?:s\b|sec|second)", text)
    if m and shot:
        ops.append({"op": "set_seconds", "shot": shot, "seconds": _num(m)})

    # --- source / curation ---------------------------------------------------
    if re.search(r"use (?:this|it|the selected|that) as (?:the )?(?:timeline )?source", text):
        if asset and shot:
            ops.append({"op": "set_source", "shot": shot, "source": asset})
    if re.search(r"(this is the keeper|make (?:this|it) the keeper|pick this (?:one|still))", text):
        if asset and shot:
            ops.append({"op": "set_keeper", "shot": shot, "path": asset})

    # --- vo -----------------------------------------------------------------
    if re.search(r"mute the (vo|voice|line)", text) and shot:
        ops.append({"op": "set_vo", "shot": shot, "mute": True})
    m = re.search(rf"(?:nudge|offset|delay) the (?:vo|line) (?:by )?{NUM}", text)
    if m and shot:
        ops.append({"op": "set_vo", "shot": shot, "offset": _num(m)})

    # --- assemble -------------------------------------------------------------
    if re.search(r"(cut the film|assemble|build the animatic|render the film)", text):
        scope = "full"
        m = re.search(r"act ?([1-4])", text)
        if m:
            scope = f"act{m.group(1)}"
        res = "1080" if re.search(r"1080|final", text) else "720"
        ops.append({"op": "assemble", "scope": scope, "res": res})

    if not ops:
        return None
    try:
        return validate_plan({"ops": ops, "note": "; ".join(notes) or
                              "parsed by the deterministic director grammar"})
    except Exception:
        return None

"""The motion model registry — what a shot can be animated with, and why.

A `motion_profile` (see `motion_profiles.py`) answers "how long a clip does
this backend make, and what does it cost". This registry answers the question
above it: *which model should this shot use*. One record per hosted i2v model,
carrying the price, the ceiling, what it was measured to be good at, and the
request shape its endpoint wants.

Records are ordered by `rank` (1 first). An agent with budget takes rank 1; an
agent running thin, or animating a register a lower-ranked model actually won,
takes that one instead. `pick_model()` is that decision, and it is the same
decision the `plan_motion` tool makes per shot.

Seeded from the bake-off in `docs/research/motion-bakeoff/RESULTS.md`
(2026-09-02, 12 clips, $1.45): four models on three plates from the two-claudes
film. PixVerse v4.5 and v6 were measured and rejected — v4.5's `style: "anime"`
overrode the plate outright, v6 invented camera moves and broke a shot's stated
rule — and they are deliberately absent here. The history stays in RESULTS.md.

Prices are what each model's fal page publishes; the request shapes are from
each endpoint's OpenAPI schema, verified 2026-09-02.
"""
from __future__ import annotations

import os

#: The registers a director actually asks for. A model claims the ones it was
#: measured to win, and `pick_model` gives those first refusal.
REGISTERS = ("dialogue_closeup", "wide_tableau", "effects_burst", "legible_text")

MOTION_MODELS: list[dict] = [
    {
        "id": "fal-ai/bytedance/seedance/v1/pro/fast/image-to-video",
        "key": "seedance",
        "label": "Seedance 1.0 pro fast",
        "rank": 1,
        "note": "best when budget allows",
        "cost": {"per_second_usd": 0.0216, "resolution": "720p"},
        "seconds_max": 12.0,
        "fps": 24,
        "strengths": [
            "holds legible screen text for a full 5s (camera_fixed)",
            "the most real movement of the two",
            "duration is a real parameter, 2-12s",
        ],
        "limits": [
            "grade runs away on high-contrast wides",
            "can abandon a very dark close-up",
        ],
        "failure_modes": ("may replace dark close-ups with a brighter room; "
                          "grade drifts warm on wides"),
        "fallback": "wan",
        "registers": ["legible_text", "effects_burst", "wide_tableau"],
        "enabled": True,
        "payload_map": {
            "image_key": "image_url", "prompt_key": "prompt",
            "duration_key": "duration", "duration_type": "str",
            "duration_range": [2, 12],
            "resolution_key": "resolution",
            "resolutions": ["480p", "720p", "1080p"],
            "aspect_key": "aspect_ratio", "negative_key": None,
            "seed_key": "seed",
            "defaults": {"resolution": "720p", "camera_fixed": True,
                         "generate_audio": False},
        },
    },
    {
        "id": "fal-ai/wan/v2.2-a14b/image-to-video/turbo",
        "key": "wan",
        "label": "Wan 2.2 A14B turbo",
        "rank": 2,
        "note": "cheap fallback, best plate fidelity in dark close-ups",
        "cost": {"per_clip_usd": 0.05, "resolution": "480p"},
        "seconds_max": 5.0,
        "fps": 16,
        "strengths": [
            "never invents a camera move",
            "best plate fidelity in dark close-ups",
            "cheapest and fastest (17-27s per clip)",
        ],
        "limits": [
            "smallest motion amplitude",
            "drops fine screen text after ~2s",
            "fixed ~5s clip: no duration parameter",
        ],
        "failure_modes": "small motion amplitude; drops fine text after ~2s",
        "fallback": "seedance",
        "registers": ["dialogue_closeup", "wide_tableau"],
        "enabled": True,
        "payload_map": {
            "image_key": "image_url", "prompt_key": "prompt",
            "duration_key": None, "resolution_key": "resolution",
            "resolutions": ["480p", "580p", "720p"],
            "aspect_key": "aspect_ratio", "negative_key": None,
            "seed_key": "seed",
            "defaults": {"resolution": "480p",
                         "enable_prompt_expansion": False},
        },
    },
]

#: The floor the demo runs on: judges who never open the planner still get a
#: model that costs five cents and respects the plate. Documented in
#: docs/BACKENDS.md; `CUTROOM_FAL_MOTION_MODEL` overrides it.
DEFAULT_MODEL_KEY = "wan"


def all_models(include_disabled: bool = False) -> list[dict]:
    """Registry records, rank order. `CUTROOM_MOTION_MODELS` (comma-separated
    keys or ids) narrows it; a key that is not in the registry is ignored."""
    rows = [dict(m) for m in MOTION_MODELS]
    allow = [s.strip() for s in
             os.environ.get("CUTROOM_MOTION_MODELS", "").split(",") if s.strip()]
    if allow:
        for r in rows:
            r["enabled"] = r["enabled"] and (r["key"] in allow or r["id"] in allow)
    if not include_disabled:
        rows = [r for r in rows if r.get("enabled")]
    return sorted(rows, key=lambda r: (r.get("rank", 99), r["id"]))


def get_model(ref: str | None) -> dict | None:
    """Look a model up by short key ("seedance") or full endpoint id."""
    if not ref:
        return None
    ref = ref.strip()
    for m in all_models(include_disabled=True):
        if ref in (m["key"], m["id"]):
            return m
    return None


def resolve_id(ref: str | None) -> str | None:
    """A registry key becomes an endpoint id; anything else passes through, so
    an operator can still name a model the registry has never heard of."""
    m = get_model(ref)
    return m["id"] if m else (ref or None)


def cost_for(model: dict, seconds: float | None = None) -> float:
    """Dollars for one clip of `seconds` on this model."""
    cost = model.get("cost") or {}
    secs = float(seconds if seconds is not None else min(
        5.0, float(model.get("seconds_max") or 5.0)))
    secs = max(0.1, min(secs, float(model.get("seconds_max") or 5.0)))
    if cost.get("per_second_usd") is not None:
        return round(float(cost["per_second_usd"]) * secs, 4)
    return round(float(cost.get("per_clip_usd") or 0.0), 4)


def pick_model(remaining_usd: float, seconds: float | None = None,
               register: str | None = None,
               models: list[dict] | None = None) -> tuple[dict | None, str]:
    """The highest-ranked model that fits the money left.

    A register a model was *measured* to win gets first refusal, which is how
    a dark close-up lands on Wan even when Seedance is affordable. Everything
    else falls to rank order, so Seedance is the default and Wan is what a
    thin budget buys. Returns (record | None, one-line reason).
    """
    rows = models if models is not None else all_models()
    if not rows:
        return None, "no motion model is enabled"
    wins = [m for m in rows if register and register in (m.get("registers") or [])]
    rest = [m for m in rows if m not in wins]
    ordered = sorted(wins, key=lambda r: (r.get("rank", 99), r["id"])) + \
        sorted(rest, key=lambda r: (r.get("rank", 99), r["id"]))

    cheapest = min(cost_for(m, seconds) for m in rows)
    for m in ordered:
        usd = cost_for(m, seconds)
        if usd > remaining_usd + 1e-9:
            continue
        if register and register in (m.get("registers") or []) and \
                m is not ordered[0]:
            why = f"{m['label']} — measured best for {register}"
        elif wins and m in wins:
            why = f"{m['label']} — {m.get('note', '')}".strip(" —")
        elif m.get("rank") == 1:
            why = f"{m['label']} — {m.get('note', '')}".strip(" —")
        else:
            why = f"{m['label']} — fits the ${remaining_usd:.2f} left"
        return m, f"{why} (${usd:.3f})"
    return None, (f"${remaining_usd:.2f} left will not buy a clip "
                  f"(cheapest is ${cheapest:.3f})")


def payload_maps() -> dict[str, dict]:
    """endpoint id -> request shape, for the fal adapter."""
    return {m["id"]: dict(m["payload_map"]) for m in
            all_models(include_disabled=True) if m.get("payload_map")}


def public(model: dict) -> dict:
    """The record as the API serves it — payload_map is adapter plumbing."""
    return {k: v for k, v in model.items() if k != "payload_map"}


#: The sentence every motion tool carries. Faithfulness is a model property:
#: a plate that got replaced is not a prompt that was worded badly.
UNFAITHFUL_DOCTRINE = (
    "Faithfulness problems are usually the model, not the prompt: switch to "
    "the registry's fallback and rerun before rewriting the sentence.")


def fallback_for(ref: str | None) -> dict | None:
    """The model to rerun on when a clip comes back unfaithful to the plate."""
    m = get_model(ref)
    return get_model(m.get("fallback")) if m else None


def unfaithful_hint(ref: str | None, register: str | None = None) -> str | None:
    """One line an agent can act on when a take does not match its plate."""
    m = get_model(ref)
    fb = fallback_for(ref)
    if not m or not fb:
        return None
    symptom = m.get("failure_modes") or "the clip drifted off the plate"
    reason = fb.get("note") or fb.get("label")
    where = f" for {register}" if register else ""
    return (f"If the plate was not respected ({symptom}), rerun{where} with "
            f'model:"{fb["key"]}" ({reason}).')

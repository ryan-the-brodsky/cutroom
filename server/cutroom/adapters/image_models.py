"""The image model registry: what a still can be drawn with, and why.

The motion lane has had this since the bake-off (`motion_models.py`): one
record per hosted model, carrying price, strengths, failure modes and a
fallback, so an agent picks per shot instead of taking whatever the backend
was configured with. Stills had no such thing. A director asked for two
monitors showing the word GOODBYE in perfectly legible letters and the agent
used the default model, because it had no way to know that text legibility is
a place these models differ, and no way to choose.

This is that list for `openrouter-image`. Records are ordered by `rank`
(1 first). Rank 1 is the cheap default the demo runs on; a shot that needs
readable text, real typography or a crowded composition asks for `pro`.

Seeded from the bake-off in `docs/research/image-models/RESULTS.md`
(2026-09-02, 9 stills, $0.58): two plates, the same 16:9 request on every
model, cost read from OpenRouter's own `usage.cost`. Prices below are
MEASURED, not quoted. `openai/gpt-5-image` was measured and rejected: it
refused the plate on policy ("I can't create images that include extensive
on-screen text"), billed $0.021 and returned no picture. `gpt-5-image-mini`
ignored the 16:9 request and drew photoreal. Both are deliberately absent; the
evidence stays in RESULTS.md.
"""
from __future__ import annotations

import os
import re

#: The registers a director actually asks a still for. A model claims the ones
#: it was measured to win.
REGISTERS = ("legible_text", "typography", "complex_composition",
             "cheap_default")

IMAGE_MODELS: list[dict] = [
    {
        "key": "flash",
        "id": "google/gemini-2.5-flash-image",
        "label": "Gemini 2.5 Flash Image (Nano Banana)",
        "rank": 1,
        "note": "the cheap default",
        "cost_per_still_usd": 0.0387,
        "seconds_typical": 8,
        "strengths": [
            "cheapest of the three, and by far the fastest (~8 s)",
            "one short word on a screen comes out legible and well set",
        ],
        "limits": [
            "misspells once a frame carries more than one string "
            "(\"SYSTEM OFLINE\", measured)",
            "drifts photoreal on a text-heavy plate and loses the anime "
            "register",
        ],
        "failure_modes": ("drops a letter when the frame carries several "
                          "strings; loses the anime register on text-heavy "
                          "plates"),
        "fallback": "pro",
        "registers": ["cheap_default"],
        "enabled": True,
    },
    {
        "key": "pro",
        "id": "google/gemini-3-pro-image",
        "label": "Gemini 3 Pro Image (Nano Banana Pro)",
        "rank": 2,
        "note": "the one to use when the text has to be readable",
        "cost_per_still_usd": 0.1387,
        "seconds_typical": 50,
        "strengths": [
            "the only model that got BOTH text plates perfect: one word "
            "repeated, and four different strings in one frame",
            "cleanest anime register of the three, unprompted",
            "crowded compositions keep their geometry",
        ],
        "limits": [
            "3.6x the price of flash",
            "slowest by far (41-65 s measured)",
            "bakes its own letterbox bars into the 16:9 canvas",
        ],
        "failure_modes": ("bakes letterbox bars into the frame; costs three "
                          "and a half flash stills and takes a minute"),
        "fallback": "flash3",
        "registers": ["legible_text", "typography", "complex_composition"],
        "enabled": True,
    },
    {
        "key": "flash3",
        "id": "google/gemini-3.1-flash-image",
        "label": "Gemini 3.1 Flash Image (Nano Banana 2)",
        "rank": 3,
        "note": "middle rung: spells like pro at half the price",
        "cost_per_still_usd": 0.0672,
        "seconds_typical": 13,
        "strengths": [
            "spelled all four strings on the hard plate, in the anime register",
            "half the price of pro and three times faster",
        ],
        "limits": [
            "a repeated line ghosts into the one below it (measured on the "
            "GOODBYE plate, where pro was clean)",
            "adds people and set dressing the prompt never mentioned",
        ],
        "failure_modes": ("repeated lines ghost into each other; invents "
                          "characters the shot did not ask for"),
        "fallback": "pro",
        "registers": ["typography", "complex_composition"],
        "enabled": True,
    },
]

#: The floor the demo runs on. A judge who never picks a model gets the
#: four-cent still. Documented in docs/BACKENDS.md; the backend's
#: `options.model` overrides it per install.
DEFAULT_MODEL_KEY = "flash"

#: The model a shot with readable text should use.
TEXT_MODEL_KEY = "pro"


def all_models(include_disabled: bool = False) -> list[dict]:
    """Registry records, rank order. `CUTROOM_IMAGE_MODELS` (comma-separated
    keys or ids) narrows it; a key that is not in the registry is ignored."""
    rows = [dict(m) for m in IMAGE_MODELS]
    allow = [s.strip() for s in
             os.environ.get("CUTROOM_IMAGE_MODELS", "").split(",") if s.strip()]
    if allow:
        for r in rows:
            r["enabled"] = r["enabled"] and (r["key"] in allow or r["id"] in allow)
    if not include_disabled:
        rows = [r for r in rows if r.get("enabled")]
    return sorted(rows, key=lambda r: (r.get("rank", 99), r["id"]))


def get_model(ref: str | None) -> dict | None:
    """Look a model up by short key ("pro") or full OpenRouter id."""
    if not ref:
        return None
    ref = ref.strip()
    for m in all_models(include_disabled=True):
        if ref in (m["key"], m["id"]):
            return m
    return None


def resolve_id(ref: str | None) -> str | None:
    """A registry key becomes an OpenRouter id; anything else passes through,
    so an operator can still name a model the registry has never heard of."""
    m = get_model(ref)
    return m["id"] if m else (ref or None)


def cost_for(ref: str | None, default: float = 0.0) -> float:
    """Measured dollars for one still on this model."""
    m = get_model(ref)
    if not m:
        return round(float(default), 4)
    return round(float(m.get("cost_per_still_usd") or default), 4)


def default_model() -> dict | None:
    return get_model(DEFAULT_MODEL_KEY) or (all_models() or [None])[0]


def text_model() -> dict | None:
    """The model to reach for when the letters have to be readable."""
    return get_model(TEXT_MODEL_KEY) or default_model()


def public(model: dict) -> dict:
    """The record as the API serves it. Nothing here is adapter plumbing, so
    this is a copy; it exists so the shape matches motion_models.public."""
    return dict(model)


def as_choices() -> list[dict]:
    """The registry as `GET /api/backends/<id>/models` serves it: the id the
    picker submits, a label carrying the price, and the key an agent types."""
    out = []
    for m in all_models():
        usd = float(m.get("cost_per_still_usd") or 0.0)
        good = ", ".join(m.get("registers") or []) or m.get("note", "")
        out.append({
            "id": m["id"],
            "key": m["key"],
            "label": f"{m['label']}, ${usd:.3f}/still, {good}",
            "cost_per_still_usd": round(usd, 4),
            "registers": list(m.get("registers") or []),
            "rank": m.get("rank", 99),
        })
    return out


# ------------------------------------------------------------------ doctrine

#: The sentence every still tool and every director prompt carries. Legibility
#: is a model property: text that came out as texture is not a prompt that was
#: worded badly.
TEXT_DOCTRINE = (
    "Text that must be readable (signs, screens, titles) needs the "
    "text-capable model: pass model:\"pro\". The default is the cheap model; "
    "it misspells the moment a frame carries more than one string.")

#: Words in a prompt that mean the frame has letters someone must read.
TEXT_WORDS = ("text", "word", "words", "letter", "letters", "lettering",
              "sign", "signs", "signage", "title", "titles", "caption",
              "captions", "subtitle", "headline", "label", "labels",
              "banner", "logo", "typography", "spells", "spelling",
              "readable", "legible", "screen text", "handwriting",
              "written", "writing", "poster", "newspaper", "graffiti")

_TEXT_RE = re.compile(
    r"\b(" + "|".join(re.escape(w) for w in TEXT_WORDS) + r")\b", re.I)


def wants_text(*prompts: str | None) -> bool:
    """True when a prompt is asking for letters a viewer has to read."""
    for p in prompts:
        if p and _TEXT_RE.search(str(p)):
            return True
    return False


def text_hint(ref: str | None) -> str | None:
    """One line an agent can act on when a still with readable text was drawn
    on the cheap model. None when the model already handles text."""
    m = get_model(ref) or default_model()
    if m and "legible_text" in (m.get("registers") or []):
        return None
    pro = text_model()
    if not pro:
        return None
    usd = float(pro.get("cost_per_still_usd") or 0.0)
    return (f"This shot asks for readable text: consider "
            f"model:\"{pro['key']}\" (≈${usd:.2f} per still).")

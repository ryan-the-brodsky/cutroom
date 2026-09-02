"""The project style register — house style as data, not as prompt discipline.

A film has one look. Asking every agent that writes a script to remember it
does not work: the *Two Claudes* prompts carried a long style tail and stayed
anime-faithful, while a judge's agent wrote "hand-painted 2D satire" and
"caricature" into a French Revolution script and got generic western
illustration back. The words an LLM reaches for when it improvises a style are
not the words this pipeline needs.

So the look moves out of the prompt and into the project:

    project.settings.style = {name, prefix, suffix, avoid, refs}

`compose` is the whole contract. It puts the register's prefix in front of the
shot prompt, strips the style words the register bans out of the middle, and
appends the suffix. `avoid` rides along as the negative; adapters with a real
negative field use it as one, and adapters without (every chat-completion image
model) fold it into the text as a final "Avoid: …" sentence.

`refs` are style-reference frames — relative paths, resolved against this
package's shipped assets first and the project's own storage second — attached
ahead of the prompt on backends that take image input.
"""
from __future__ import annotations

import re
from pathlib import Path

ASSET_DIR = Path(__file__).parent / "assets" / "style"

#: Shipped reference frames, in the order they are attached. Relative paths so
#: a project can name its own frames the same way.
SHIPPED_REFS = ("anime-01.jpg", "anime-02.jpg", "anime-03.jpg")

AVOID_DEFAULT = (
    "text, lettering, signage, watermark, caption, photorealistic, "
    "photograph, 3D render, CGI, western cartoon, caricature, painterly, "
    "chibi, moe, sparkling eyes, extra limbs"
)

PRESETS: dict[str, dict] = {
    "anime-cel": {
        "name": "anime-cel",
        "prefix": (
            "Cinematic anime film still, 1990s TV anime cel look: clean ink "
            "outlines, flat cel shading, restrained palette, soft film grain, "
            "no painterly brushwork."
        ),
        "suffix": "",
        "avoid": AVOID_DEFAULT,
        "refs": list(SHIPPED_REFS),
    },
    "anime-noir": {
        "name": "anime-noir",
        "prefix": (
            "Cinematic anime film still, night noir cel look: clean ink "
            "outlines, flat cel shading, deep blacks with one cold key light, "
            "hard shadow shapes, soft film grain, no painterly brushwork."
        ),
        "suffix": "",
        "avoid": AVOID_DEFAULT + ", daylight, bright saturated color",
        "refs": list(SHIPPED_REFS),
    },
    "anime-pastel": {
        "name": "anime-pastel",
        "prefix": (
            "Cinematic anime film still, daytime pastel cel look: clean ink "
            "outlines, flat cel shading, chalky pastel palette, gentle "
            "diffuse light, soft film grain, no painterly brushwork."
        ),
        "suffix": "",
        "avoid": AVOID_DEFAULT + ", heavy shadow, neon oversaturation",
        "refs": list(SHIPPED_REFS),
    },
}

DEFAULT_PRESET = "anime-cel"

#: Phrases a shot prompt should never carry, whatever the register says. These
#: are the ones an LLM writes on its own and the ones that broke the demo: they
#: are stripped out of the middle of the prompt before the prefix goes on.
STRIP_ALWAYS = (
    "hand-painted", "hand painted", "handpainted", "caricature", "cartoon",
    "watercolor", "watercolour", "oil painting", "painterly", "comic",
    "satire", "sketch", "storybook", "illustration style", "photorealistic",
    "photoreal", "3d render", "cgi", "digital painting", "concept art",
)

#: Words in `avoid` too generic to strip out of a shot prompt: "text" would eat
#: "context", "gore" is a subject note, and removing "photograph" from "a
#: photograph on the wall" changes what is in the frame, not how it looks.
NEVER_STRIP = {"text", "lettering", "signage", "caption", "watermark", "gore",
               "extra limbs", "malformed hands", "logos", "signature",
               "letters", "numbers", "crowd", "modern clothing", "daylight",
               "photograph", "visible face"}

STYLE_REF_INSTRUCTION = (
    "Match the visual style of these reference frames exactly: line, shading, "
    "palette discipline. Do not copy their content."
)

MAX_REFS = 4


# ------------------------------------------------------------------ normalize

def _text(v, fallback: str = "") -> str:
    return str(v).strip() if isinstance(v, str) and v.strip() else fallback


def _avoid_terms(avoid: str) -> list[str]:
    return [t.strip().lower() for t in re.split(r"[,\n]", avoid or "") if t.strip()]


def preset(name: str | None) -> dict:
    """A preset by name, deep-copied. Unknown names fall back to the default."""
    row = PRESETS.get(_text(name).lower() or DEFAULT_PRESET) or PRESETS[DEFAULT_PRESET]
    return {**row, "refs": list(row["refs"])}


def default_style() -> dict:
    return preset(DEFAULT_PRESET)


def normalize(raw, *, base: dict | None = None) -> dict:
    """Coerce anything an API caller sends into a full register.

    A bare string is a preset name if we know it, otherwise a custom prefix —
    that is what "style": "anime-noir" and "style": "gritty rotoscope, …" both
    mean to an agent, and guessing wrong is worse than accepting both.
    """
    if isinstance(raw, str):
        text = _text(raw)
        if not text:
            return dict(base or default_style())
        if text.lower() in PRESETS:
            return preset(text)
        raw = {"prefix": text}
    if not isinstance(raw, dict):
        return dict(base or default_style())

    start = preset(raw["preset"]) if _text(raw.get("preset")) else dict(
        base or default_style())
    out = {
        "name": _text(raw.get("name"), start.get("name") or DEFAULT_PRESET),
        "prefix": _text(raw.get("prefix"), start.get("prefix", "")),
        "suffix": _text(raw.get("suffix"), start.get("suffix", "")),
        "avoid": _text(raw.get("avoid"), start.get("avoid", "")),
        "refs": start.get("refs") or [],
    }
    # An explicit empty string clears a field. "No look at all" is a real
    # state — it is what an A/B against the register has to be able to ask for.
    for field in ("prefix", "suffix", "avoid"):
        if field in raw and not _text(raw.get(field)):
            out[field] = ""
    if "refs" in raw:
        refs = raw.get("refs")
        if refs in (None, False):
            out["refs"] = []
        elif isinstance(refs, list):
            out["refs"] = [str(r).strip() for r in refs if str(r).strip()][:MAX_REFS]
    # A custom prefix with no name of its own is "custom", not "anime-cel":
    # the header should not claim a register the film is no longer in.
    if _text(raw.get("prefix")) and not _text(raw.get("name")) \
            and not _text(raw.get("preset")) \
            and out["prefix"] != start.get("prefix"):
        out["name"] = "custom"
    return out


def project_style(settings: dict | None) -> dict:
    """The effective register for a project. Projects made before the register
    existed have none; they get the house default at read time rather than
    generating in whatever style their prompts happen to ask for."""
    raw = (settings or {}).get("style")
    if not raw:
        return default_style()
    return normalize(raw)


# ------------------------------------------------------------------- compose

def strip_style_words(prompt: str, avoid: str = "") -> tuple[str, list[str]]:
    """Take the style words out of the middle of a shot prompt.

    Only style words: the register's `avoid` list also holds subject bans
    ("text", "gore") that mean something different inside a prompt, so those
    are left alone (NEVER_STRIP). Returns the cleaned prompt and what went.
    """
    terms = list(STRIP_ALWAYS)
    for t in _avoid_terms(avoid):
        if t not in NEVER_STRIP and t not in terms and len(t) > 3:
            terms.append(t)
    # Longest first so "hand-painted 2D" loses the whole phrase, not half of it.
    terms.sort(key=len, reverse=True)
    out, removed = prompt or "", []
    for term in terms:
        pat = re.compile(
            r"(?<![A-Za-z])" + re.escape(term).replace(r"\ ", r"[\s-]+")
            + r"(\s+(?:2d|3d|style|look|art))?(?![A-Za-z])",
            re.IGNORECASE)
        if pat.search(out):
            out = pat.sub(" ", out)
            removed.append(term)
    # Tidy the holes: ", ," -> ", ", " ." -> ".", runs of spaces -> one.
    out = re.sub(r"\s+", " ", out)
    out = re.sub(r"(?:,\s*){2,}", ", ", out)
    out = re.sub(r"\s+([,.;:])", r"\1", out)
    out = re.sub(r"^[\s,;:.]+", "", out)
    return out.strip().strip(",").strip(), removed


def compose(prompt: str, style: dict | None,
            *, negative: str = "") -> tuple[str, str, dict]:
    """prefix + stripped shot prompt + suffix, and the negative to send with it.

    Returns (prompt, negative, style_applied) where `style_applied` is the row
    recorded on the Take, so a still can always be traced back to the register
    that shaped it.
    """
    st = style or default_style()
    cleaned, removed = strip_style_words(prompt or "", st.get("avoid", ""))
    parts = [_text(st.get("prefix")), cleaned, _text(st.get("suffix"))]
    final = " ".join(p for p in parts if p).strip()

    seen, merged = set(), []
    for term in _avoid_terms(negative) + _avoid_terms(st.get("avoid", "")):
        if term not in seen:
            seen.add(term)
            merged.append(term)
    applied = {"name": st.get("name") or DEFAULT_PRESET,
               "prefix": bool(_text(st.get("prefix"))),
               "suffix": bool(_text(st.get("suffix"))),
               "avoid": bool(merged)}
    if removed:
        applied["stripped"] = removed
    return final, ", ".join(merged), applied


def fold_avoid(prompt: str, negative: str) -> str:
    """For adapters with no negative field: say it in the prompt instead.

    Gemini-class image models are reached through chat/completions, which has
    nowhere to put a negative — before this, "text, watermark, photorealistic"
    was collected, stored on the Take and then silently dropped on the floor.
    """
    neg = ", ".join(_avoid_terms(negative))
    if not neg:
        return prompt or ""
    body = (prompt or "").rstrip()
    return f"{body} Avoid: {neg}." if body else f"Avoid: {neg}."


# ---------------------------------------------------------------------- refs

def resolve_refs(style: dict | None, store=None) -> list[Path]:
    """Reference frames as absolute paths. Shipped assets win; anything else is
    looked up in the project's storage. Missing files are skipped, never fatal —
    a style register must not be able to break generation."""
    out: list[Path] = []
    for rel in (style or {}).get("refs") or []:
        rel = str(rel).strip().lstrip("/")
        if not rel or ".." in rel:
            continue
        cand = ASSET_DIR / rel
        if not cand.exists() and store is not None:
            try:
                cand = Path(store.resolve(rel))
            except Exception:
                continue
        if cand.exists() and cand.is_file():
            out.append(cand)
        if len(out) >= MAX_REFS:
            break
    return out

"""Motion profiles — the live window is a property of the backend.

History in one sentence: the FIRST-SECOND LAW was measured, not decreed — the
local LTX-class i2v model holds anime coherence for about a second and then
drifts photoreal, so the grammar became "a burst of motion, then the held cel".

Hosted Wan-class models hold 3-5 s, so that law was never a law — it was one
model's ceiling. Baking it into the tools would cap every backend at the
weakest one. Instead each motion backend carries a `motion_profile` in
`options`, and a clip plays for that profile's default length, in full.
Freezing is a repair tool now, not a default (2026-09-02 doctrine change).

Shape (every key optional; `profile_for` fills the gaps):

    {
      "seconds_default": 5.0,          # clip length when the caller omits it
      "seconds_max": 5.0,              # longest clip the model will make
      "seconds_options": [5, 8],       # discrete durations, when the API has them
      "live_seconds_default": 3.0,     # how long it holds before it drifts;
                                       #   advisory for freeze_tail, NOT applied
      "live_seconds_max": 5.0,
      "fps": 16,                       # frames <-> seconds
      "frames_options": [81, 121],     # frame counts the model accepts
      "resolutions": ["480p", "720p"],
      "cost_per_clip_usd": 0.20,       # one of these two; per_second wins if both
      "cost_per_second_usd": 0.04,
    }

Nothing here freezes anything. `live_seconds_default` is advice an agent can
act on when a clip actually degrades; `freeze_after` is applied only when a
caller asks for it.
"""
from __future__ import annotations

import json
import os

#: The local rig: LTX-class i2v on ComfyUI. One second of live motion, then a
#: true freeze. 8k+1 frame counts are an LTX requirement, not a preference.
LTX_PROFILE: dict = {
    "seconds_default": 2.0,
    "seconds_max": 5.0,
    "live_seconds_default": 1.0,
    "live_seconds_max": 1.5,
    "fps": 24,
    "frames_options": [25, 49, 73, 97, 121],
    "resolutions": ["768x432", "960x544", "1024x576"],
    "cost_per_clip_usd": 0.0,
    "note": "LTX holds about 1s before it drifts photoreal — if a clip "
            "degrades, freeze_tail at ~1s rather than rerolling it.",
}

#: Hosted queue models. Keyed by an endpoint-id prefix, longest match wins.
#: Prices are the vendor's published rate at the time of the bake-off; a
#: backend row's own `motion_profile` always overrides what is here.
HOSTED_PROFILES: dict[str, dict] = {
    "fal-ai/wan/v2.2-a14b/image-to-video/turbo": {
        "seconds_default": 5.0,
        "seconds_max": 5.0,
        "seconds_options": [5.0],
        "live_seconds_default": 5.0,
        "live_seconds_max": 5.0,
        "fps": 16,
        "frames_options": [81],
        "resolutions": ["480p", "580p", "720p"],
        "cost_per_clip_usd": 0.05,
        "note": "fixed ~5s / 81f: the turbo endpoint has no duration field. "
                "$0.05 per video at 480p, $0.075 at 580p, $0.10 at 720p.",
    },
    "fal-ai/bytedance/seedance/v1/pro/fast/image-to-video": {
        "seconds_default": 5.0,
        "seconds_max": 12.0,
        "live_seconds_default": 5.0,
        "live_seconds_max": 12.0,
        "fps": 24,
        "resolutions": ["480p", "720p", "1080p"],
        "cost_per_second_usd": 0.0216,
        "note": "token-priced; ~$0.108 for 5s at 720p. camera_fixed locks the "
                "frame so only the character moves.",
    },
    "fal-ai/wan": {
        "seconds_default": 5.0,
        "seconds_max": 5.0,
        "live_seconds_default": 5.0,
        "live_seconds_max": 5.0,
        "fps": 16,
        "frames_options": [81, 121],
        "resolutions": ["480p", "720p"],
        "cost_per_clip_usd": 0.05,
    },
    "fal-ai/ltx-video": {
        "seconds_default": 4.0,
        "seconds_max": 5.0,
        "live_seconds_default": 1.0,
        "live_seconds_max": 1.5,
        "fps": 24,
        "frames_options": [97, 121],
        "resolutions": ["768x512"],
        "cost_per_clip_usd": 0.04,
    },
}

#: What a motion backend gets when nothing else is known: assume it behaves
#: like the local rig, because that is the assumption that cannot waste money.
GENERIC_PROFILE: dict = dict(LTX_PROFILE, note="unknown motion model; "
                             "assuming the local rig's ceiling")


def _by_model(model: str | None) -> dict | None:
    if not model:
        return None
    # "seedance" and "wan" are registry keys; resolve before prefix-matching
    from . import motion_models
    m = (motion_models.resolve_id(model) or model).strip()
    best: tuple[int, dict] | None = None
    for prefix, prof in HOSTED_PROFILES.items():
        if m.startswith(prefix) and (best is None or len(prefix) > best[0]):
            best = (len(prefix), prof)
    return dict(best[1]) if best else None


def profile_for(options: dict | None = None, backend_type: str = "",
                model: str | None = None) -> dict:
    """The effective profile: stored row > model table > type default.

    `options.motion_profile` is a partial override, so an admin can raise just
    the live window without restating the whole shape.
    """
    opts = options or {}
    if backend_type in ("comfyui", "mock"):
        base = dict(LTX_PROFILE)
        if backend_type == "mock":
            base = dict(base, cost_per_clip_usd=0.0,
                        note="test mode: existing footage, instant and free")
    else:
        base = _by_model(model or opts.get("model")) or dict(GENERIC_PROFILE)
    stored = opts.get("motion_profile")
    if isinstance(stored, dict):
        base.update({k: v for k, v in stored.items() if v is not None})
    # a row's own cost_usd is the authority the spend ledger already uses
    if "cost_usd" in opts and "cost_per_second_usd" not in base:
        try:
            base["cost_per_clip_usd"] = max(0.0, float(opts["cost_usd"]))
        except (TypeError, ValueError):
            pass
    return base


def env_profile(backend_id: str) -> dict | None:
    """`CUTROOM_MOTION_PROFILE_<BACKEND_ID>` as JSON, dashes to underscores."""
    raw = os.environ.get(
        "CUTROOM_MOTION_PROFILE_" + backend_id.upper().replace("-", "_"))
    if not raw:
        return None
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else None
    except ValueError:
        return None


def default_profile_for_row(backend_id: str, backend_type: str,
                            model: str | None) -> dict | None:
    """The profile `seed_backends` writes onto a motion-capable row."""
    env = env_profile(backend_id)
    if env is not None:
        return env
    if backend_type in ("comfyui",):
        return dict(LTX_PROFILE)
    prof = _by_model(model)
    return prof


# ------------------------------------------------------------------ maths

def fps_of(profile: dict) -> int:
    try:
        return max(1, int(profile.get("fps") or 24))
    except (TypeError, ValueError):
        return 24


def seconds_max(profile: dict) -> float:
    try:
        return max(0.1, float(profile.get("seconds_max") or 5.0))
    except (TypeError, ValueError):
        return 5.0


def seconds_default(profile: dict) -> float:
    """The clip length this backend produces when nobody says otherwise."""
    raw = profile.get("seconds_default")
    if raw is None:
        opts = profile.get("frames_options")
        if isinstance(opts, list) and opts:
            raw = seconds_for_frames(profile, min(int(o) for o in opts))
        else:
            raw = 2.0
    return clamp_seconds(profile, raw)


def live_default(profile: dict) -> float:
    """How long this backend holds before it drifts. ADVICE, not a default —
    nothing applies it unless a caller explicitly asks to freeze."""
    try:
        v = float(profile.get("live_seconds_default", 1.0))
    except (TypeError, ValueError):
        v = 1.0
    return max(0.0, min(v, seconds_max(profile)))


def clamp_live(profile: dict, live: float) -> float:
    try:
        v = float(live)
    except (TypeError, ValueError):
        return live_default(profile)
    hi = profile.get("live_seconds_max")
    try:
        hi = float(hi) if hi is not None else seconds_max(profile)
    except (TypeError, ValueError):
        hi = seconds_max(profile)
    return max(0.0, min(v, min(hi, seconds_max(profile))))


def clamp_seconds(profile: dict, seconds: float) -> float:
    try:
        v = float(seconds)
    except (TypeError, ValueError):
        v = float(profile.get("seconds_default") or 2.0)
    v = max(0.1, min(v, seconds_max(profile)))
    opts = profile.get("seconds_options")
    if isinstance(opts, list) and opts:
        try:
            return float(min(opts, key=lambda o: abs(float(o) - v)))
        except (TypeError, ValueError):
            pass
    return round(v, 3)


def frames_for_seconds(profile: dict, seconds: float) -> int:
    """Seconds -> a frame count this model will actually accept."""
    fps = fps_of(profile)
    want = max(1, round(clamp_seconds(profile, seconds) * fps))
    opts = profile.get("frames_options")
    if isinstance(opts, list) and opts:
        try:
            return int(min((int(o) for o in opts), key=lambda o: abs(o - want)))
        except (TypeError, ValueError):
            pass
    # LTX-class models want 8k+1
    return int(max(9, round((want - 1) / 8) * 8 + 1))


def seconds_for_frames(profile: dict, frames: int) -> float:
    try:
        return round(max(1, int(frames)) / fps_of(profile), 3)
    except (TypeError, ValueError):
        return live_default(profile)


def clip_cost(profile: dict, seconds: float | None = None) -> float:
    """Dollars for one clip of `seconds` at this profile."""
    per_s = profile.get("cost_per_second_usd")
    if per_s is not None:
        try:
            s = clamp_seconds(profile, seconds if seconds is not None
                              else live_default(profile))
            return round(max(0.0, float(per_s)) * s, 4)
        except (TypeError, ValueError):
            pass
    try:
        return round(max(0.0, float(profile.get("cost_per_clip_usd") or 0.0)), 4)
    except (TypeError, ValueError):
        return 0.0


def describe(profile: dict) -> str:
    """One line for a tool result."""
    return (f"{seconds_default(profile):g}s clips (max {seconds_max(profile):g}s) "
            f"at {fps_of(profile)} fps, holds ~{live_default(profile):g}s")


def backend_profile(backend_id: str | None, model: str | None = None) -> dict:
    """Read a backend row and return its effective motion profile.

    `model` is the per-request override (a registry key is fine): a fal row
    serves any model in the registry, and they do not share a clip length or
    a price, so the profile has to follow the model actually chosen."""
    if not backend_id:
        return dict(GENERIC_PROFILE)
    from ..db import session_scope
    from ..models import Backend
    try:
        with session_scope() as s:
            row = s.get(Backend, backend_id)
            if row is None:
                return dict(GENERIC_PROFILE)
            opts = row.options or {}
            if model:
                # the row's stored profile describes its OWN model; a request
                # for another one must not inherit it
                opts = {k: v for k, v in opts.items() if k != "motion_profile"}
            return profile_for(opts, row.type, model or opts.get("model"))
    except Exception:
        return dict(GENERIC_PROFILE)

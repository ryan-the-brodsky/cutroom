"""Spend cap for the hosted demo — a rolling 24h ledger of estimated cost.

Every backend carries `options.cost_usd` (dollars per produced take), seeded
from `CUTROOM_COST_<BACKEND_ID>` at boot. A job's estimate is
`cost_usd × takes`; free backends (mock, local ComfyUI, anything at 0) never
count. Submissions on a paid lane are refused with HTTP 402 once the rolling
24h total would pass `CUTROOM_DEMO_BUDGET_USD` (default 10).

The ledger is a small JSON file in the data dir — no migration, survives
restarts, and is trivially inspectable (`cat $CUTROOM_DATA/spend-ledger.json`).
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from fastapi import HTTPException

from .config import get_settings
from .db import session_scope
from .models import Backend

WINDOW = 24 * 3600.0

#: per-take dollar estimates used when a backend has no `options.cost_usd`
#: and no `CUTROOM_COST_<ID>` env override. Keyed by backend id first, then
#: adapter type.
DEFAULT_COSTS: dict[str, float] = {
    "mock": 0.0,
    "comfyui": 0.0,
    "local-comfyui": 0.0,
    "openrouter": 0.001,          # GLM 5.3 Flash, a planning turn
    "openai-chat": 0.001,
    "openrouter-image": 0.04,     # gemini-2.5-flash-image, per image
    "openai-images": 0.04,
    "fal": 0.05,                  # Wan 2.2 A14B turbo i2v @480p, per clip
    "replicate": 0.05,
    "elevenlabs": 0.02,           # one VO line
    "anthropic": 0.01,
}

_lock = threading.Lock()


class BudgetExceeded(Exception):
    """402 — the rolling 24h estimate would pass the demo cap.

    Rendered flat (`{detail, spent, budget, …}`) by the handler installed in
    main.create_app, because the agent tools relay those numbers verbatim.
    """

    def __init__(self, spent: float, budget: float, estimate: float = 0.0,
                 backend: str | None = None):
        self.spent, self.budget = round(spent, 4), round(budget, 2)
        self.estimate, self.backend = round(estimate, 4), backend
        self.detail = (
            f"demo budget exhausted — ${spent:.2f} of ${budget:.2f} estimated "
            "spend used in the last 24h. The mock backend still works: submit "
            "with backend 'mock' and everything runs instantly and free.")
        super().__init__(self.detail)

    def body(self) -> dict:
        return {"detail": self.detail, "spent": self.spent,
                "budget": self.budget, "estimate": self.estimate,
                "backend": self.backend}


def _ledger_path() -> Path:
    return get_settings().data_dir / "spend-ledger.json"


def _read() -> list[dict]:
    try:
        rows = json.loads(_ledger_path().read_text())
        return rows if isinstance(rows, list) else []
    except Exception:
        return []


def _write(rows: list[dict]) -> None:
    p = _ledger_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows))
    tmp.replace(p)


def default_cost(backend_id: str, backend_type: str = "") -> float:
    """Env override > per-id default > per-type default > 0."""
    import os
    env = "CUTROOM_COST_" + backend_id.upper().replace("-", "_")
    raw = os.environ.get(env)
    if raw:
        try:
            return float(raw)
        except ValueError:
            pass
    if backend_id in DEFAULT_COSTS:
        return DEFAULT_COSTS[backend_id]
    return DEFAULT_COSTS.get(backend_type, 0.0)


def cost_usd(backend_id: str | None) -> float:
    """Per-take cost of a backend, from its options (seeded at boot)."""
    if not backend_id:
        return 0.0
    with session_scope() as s:
        row = s.get(Backend, backend_id)
        if row is None:
            return 0.0
        opts = row.options or {}
        if "cost_usd" in opts:
            try:
                return max(0.0, float(opts["cost_usd"]))
            except (TypeError, ValueError):
                return 0.0
        return default_cost(row.id, row.type)


def is_paid(backend_id: str | None) -> bool:
    return cost_usd(backend_id) > 0


def spent_24h() -> float:
    cutoff = time.time() - WINDOW
    return round(sum(float(r.get("usd", 0)) for r in _read()
                     if float(r.get("t", 0)) >= cutoff), 4)


def state() -> dict:
    s = get_settings()
    return {"spent": spent_24h(), "limit": round(s.demo_budget_usd, 2)}


def charge(backend_id: str | None, takes: int = 1, project: str | None = None,
           job: str | None = None) -> float:
    """Record estimated spend. Free backends are not written to the ledger."""
    usd = cost_usd(backend_id) * max(0, int(takes))
    if usd <= 0:
        return 0.0
    cutoff = time.time() - WINDOW
    with _lock:
        rows = [r for r in _read() if float(r.get("t", 0)) >= cutoff]
        rows.append({"t": time.time(), "usd": round(usd, 6),
                     "backend": backend_id, "project": project, "job": job})
        _write(rows)
    return usd


def resolve_backend_id(project: str | None, lane: str,
                       backend_id: str | None = None) -> str | None:
    """The backend a submission on this lane would actually use. Never
    raises — an unresolvable lane is somebody else's 400."""
    from .jobs.handlers import pick_backend         # circular at import time
    try:
        return pick_backend(project, lane, backend_id).cfg.id
    except Exception:
        return None


def check_submission(project: str | None, lane: str | None,
                     backend_id: str | None = None, takes: int = 1) -> None:
    """402 when a paid submission would push the rolling 24h spend past the
    cap. Free lanes (and non-demo servers) always pass."""
    settings = get_settings()
    if not settings.demo or not lane:
        return
    bid = resolve_backend_id(project, lane, backend_id)
    per = cost_usd(bid)
    if per <= 0:
        return
    spent = spent_24h()
    estimate = per * max(1, int(takes))
    limit = settings.demo_budget_usd
    if spent + estimate > limit:
        raise BudgetExceeded(spent=spent, budget=limit, estimate=estimate,
                             backend=bid)

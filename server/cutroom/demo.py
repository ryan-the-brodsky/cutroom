"""Hosted demo mode: roles, rate limits, bundle build, boot-time import.

`CUTROOM_DEMO=1` splits the single bearer token into two roles:

  * **admin**  — `CUTROOM_ADMIN_TOKEN`. Configures backends, lane defaults,
    imports and deletes projects, pauses the server.
  * **viewer** — `CUTROOM_AUTH_TOKEN` (the judge link's `?token=`). May do
    everything *creative*: generate, freeze, trim, curate, cut the film.

Outside demo mode (or with no admin token configured) every request is admin,
so a self-host behaves exactly as it did before.

The demo dataset ships as a tarball built from a game7-layout repo:

    cutroom demo-bundle ~/src/game7 /tmp/bundle.tar.zst

`CUTROOM_DEMO_BUNDLE=<url>` downloads and imports it at boot when the
instance has no projects yet (idempotent; progress lands in
`$CUTROOM_DATA/logs/boot.log`).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tarfile
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

import httpx
from fastapi import HTTPException, Request

from .config import get_settings

ROLE_ADMIN = "admin"
ROLE_VIEWER = "viewer"

ADMIN_ONLY_MESSAGE = (
    "this is the hosted demo — {what} is reserved for the studio owner. "
    "Everything creative is open to you: generate takes, freeze, trim, pick "
    "keepers, direct shots and cut the film.")

# ------------------------------------------------------------------ roles


def demo_mode() -> bool:
    return bool(get_settings().demo)


def token_of(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if header.startswith("Bearer "):
        return header[7:]
    return request.query_params.get("token", "") or ""


def role_for(request: Request) -> str:
    """admin unless demo mode is on AND an admin token is configured AND the
    caller did not present it."""
    settings = get_settings()
    if not settings.demo or not settings.admin_token:
        return ROLE_ADMIN
    return ROLE_ADMIN if token_of(request) == settings.admin_token \
        else ROLE_VIEWER


def is_admin(request: Request) -> bool:
    return role_for(request) == ROLE_ADMIN


def require_admin(what: str = "this"):
    """FastAPI dependency factory: 403 with a friendly detail for viewers."""
    async def _dep(request: Request) -> None:
        if not is_admin(request):
            raise HTTPException(403, ADMIN_ONLY_MESSAGE.format(what=what))
    return _dep


# ------------------------------------------------------- rate limiting

_hits: dict[str, deque] = defaultdict(deque)
_hits_lock = threading.Lock()


def reset_rate_limits() -> None:
    with _hits_lock:
        _hits.clear()


def _bucket_key(request: Request, kind: str) -> str:
    tok = token_of(request) or (request.client.host if request.client else "?")
    return f"{kind}:{tok}"


def rate_limit(request: Request, paid: bool = False) -> None:
    """12 paid jobs/hour and 60 jobs/minute per token (in-memory, per node)."""
    settings = get_settings()
    if not settings.demo:
        return
    now = time.time()
    checks = [("min", 60.0, settings.demo_jobs_per_min,
               "job submissions")]
    if paid:
        checks.append(("paid", 3600.0, settings.demo_paid_jobs_per_hour,
                       "paid-backend jobs"))
    with _hits_lock:
        for kind, window, cap, label in checks:
            key = _bucket_key(request, kind)
            q = _hits[key]
            while q and q[0] < now - window:
                q.popleft()
            if len(q) >= cap:
                wait = int(window - (now - q[0])) + 1
                raise HTTPException(429, (
                    f"demo rate limit: {cap} {label} per "
                    f"{'hour' if window > 100 else 'minute'}. Try again in "
                    f"{wait}s, or submit with backend 'mock' — mock jobs are "
                    "instant, free and uncapped."))
        for kind, window, cap, label in checks:
            _hits[_bucket_key(request, kind)].append(now)


# ------------------------------------------------------- bundle building

BUNDLE_FILES = [
    "prompts/shots.jsonl",
    "prompts/characters.jsonl",
    "renders/curation.json",
    "audio/sfx-cues.jsonl",
    "audio/music-cues.jsonl",
    "audio/mix-overrides.jsonl",
]
BUNDLE_GLOBS = [
    "dashboard/state/overrides*.json",
    "dashboard/state/comps-*.json",
]
BUNDLE_TREES = ["renders", "audio"]          # assembly/ is deliberately out
MAX_FILE_BYTES = 25 * 1024 * 1024
SKIP_DIR_PARTS = {".git", "__pycache__", ".DS_Store", "assembly"}


def bundle_members(src: Path, max_bytes: int = MAX_FILE_BYTES,
                   skip_motion_tests: bool = False) -> list[tuple[Path, str]]:
    """(absolute path, arcname) pairs the bundle should carry."""
    out: list[tuple[Path, str]] = []
    seen: set[str] = set()

    def add(p: Path, essential: bool = False) -> None:
        if not p.is_file():
            return
        rel = p.relative_to(src).as_posix()
        if rel in seen:
            return
        if any(part in SKIP_DIR_PARTS for part in Path(rel).parts):
            return
        if p.name == ".DS_Store":
            return
        # The manifests are the spine of the import — dropping one for size
        # would produce a bundle that boots into an empty project. Only media
        # is subject to the per-file cap.
        if not essential and p.stat().st_size > max_bytes:
            return
        if skip_motion_tests and rel.startswith("renders/motion/tests/"):
            return
        seen.add(rel)
        out.append((p, rel))

    for rel in BUNDLE_FILES:
        add(src / rel, essential=True)
    for pattern in BUNDLE_GLOBS:
        for p in sorted(src.glob(pattern)):
            add(p, essential=True)
    for tree in BUNDLE_TREES:
        d = src / tree
        if d.is_dir():
            for p in sorted(d.rglob("*")):
                add(p)
    return out


def build_bundle(src_root: str, out_path: str,
                 log=print) -> dict:
    """Pack a game7 tree into a demo bundle. Falls back to .tar.gz when the
    zstd binary is unavailable (Railway's slim images often lack it)."""
    src = Path(src_root).expanduser().resolve()
    if not (src / "prompts/shots.jsonl").exists():
        raise RuntimeError(f"{src} is not a game7-layout repo "
                           "(no prompts/shots.jsonl)")
    out = Path(out_path).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    members = bundle_members(src)
    raw = sum(p.stat().st_size for p, _ in members)
    log(f"packing {len(members)} files ({raw / 1e6:.0f} MB raw) from {src}")

    zstd = shutil.which("zstd") if out.suffix == ".zst" else None
    if out.suffix == ".zst" and not zstd:
        out = out.with_suffix("").with_suffix(".tar.gz") \
            if out.name.endswith(".tar.zst") else out.with_suffix(".gz")
        log(f"zstd not found — writing {out.name} instead")

    def _write(fileobj=None, name=None, mode="w|"):
        with tarfile.open(fileobj=fileobj, name=name, mode=mode) as tf:
            for p, arc in members:
                tf.add(p, arcname=arc, recursive=False)

    if zstd and out.name.endswith(".zst"):
        proc = subprocess.Popen([zstd, "-T0", "-9", "-q", "-f", "-o", str(out)],
                                stdin=subprocess.PIPE)
        assert proc.stdin is not None
        try:
            _write(fileobj=proc.stdin)
        finally:
            proc.stdin.close()
            if proc.wait() != 0:
                raise RuntimeError("zstd failed")
    else:
        _write(name=str(out), mode="w:gz")

    size = out.stat().st_size
    log(f"bundle: {out} — {size / 1e6:.1f} MB "
        f"({len(members)} files, {raw / 1e6:.0f} MB raw)")
    return {"path": str(out), "bytes": size, "files": len(members),
            "raw_bytes": raw}


def extract_bundle(archive: Path, dest: Path, log=print) -> Path:
    """Unpack a .tar.zst / .tar.gz / .tar bundle into dest."""
    dest.mkdir(parents=True, exist_ok=True)
    name = archive.name
    if name.endswith(".zst"):
        zstd = shutil.which("zstd")
        if not zstd:
            raise RuntimeError("bundle is .zst but no zstd binary is "
                               "installed — rebuild the bundle as .tar.gz")
        proc = subprocess.Popen([zstd, "-d", "-c", str(archive)],
                                stdout=subprocess.PIPE)
        assert proc.stdout is not None
        with tarfile.open(fileobj=proc.stdout, mode="r|") as tf:
            tf.extractall(dest)
        proc.wait()
    else:
        mode = "r:gz" if name.endswith((".gz", ".tgz")) else "r:*"
        with tarfile.open(archive, mode) as tf:
            tf.extractall(dest)
    log(f"extracted {archive.name} -> {dest}")
    return dest


def download_bundle(url: str, dest: Path, token: str = "", log=print) -> Path:
    """Stream a bundle url to disk. GitHub Release assets on a private repo
    need `Accept: application/octet-stream` plus a bearer token."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    headers = {"Accept": "application/octet-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    tmp = dest.with_suffix(dest.suffix + ".part")
    got = 0
    with httpx.stream("GET", url, headers=headers, follow_redirects=True,
                      timeout=600) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
                got += len(chunk)
                if got % (32 << 20) < (1 << 20):
                    log(f"  … {got / 1e6:.0f} MB")
    tmp.replace(dest)
    log(f"downloaded {got / 1e6:.1f} MB -> {dest}")
    return dest


# ------------------------------------------------------- boot-time import


def _boot_log():
    path = get_settings().logs_dir / "boot.log"
    path.parent.mkdir(parents=True, exist_ok=True)

    def log(msg: str) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True)
        with open(path, "a") as f:
            f.write(line + "\n")
    return log


def apply_lane_env(project_id: str, log=print) -> dict:
    """`CUTROOM_LANE_<LANE>=<backend>[:<model>]` -> LaneConfig rows.
    Unset lanes are left alone (they fall through to the first enabled
    backend, which is `mock` on the demo)."""
    from .db import session_scope
    from .models import LaneConfig, Project
    from sqlalchemy import select
    lanes = ("still", "i2i", "motion", "vo", "sfx", "music", "direction")
    applied: dict[str, dict] = {}
    with session_scope() as s:
        if not s.get(Project, project_id):
            return applied
        for lane in lanes:
            raw = os.environ.get(f"CUTROOM_LANE_{lane.upper()}", "").strip()
            if not raw:
                continue
            backend, _, model = raw.partition(":")
            lc = s.execute(select(LaneConfig).where(
                LaneConfig.project_id == project_id,
                LaneConfig.lane == lane)).scalar_one_or_none()
            if not lc:
                lc = LaneConfig(project_id=project_id, lane=lane)
                s.add(lc)
            lc.backend_id = backend or None
            lc.model = model or None
            applied[lane] = {"backend": backend or None, "model": model or None}
            log(f"lane {lane} -> {backend}{':' + model if model else ''}")
    return applied


def enable_backend(bid: str, log=print) -> None:
    from .db import session_scope
    from .models import Backend
    with session_scope() as s:
        row = s.get(Backend, bid)
        if row and not row.enabled:
            row.enabled = True
            log(f"enabled backend {bid}")


def boot_import(force: bool = False) -> dict:
    """Download + extract + import the demo bundle when this instance is
    empty. Safe to call on every boot."""
    settings = get_settings()
    log = _boot_log()
    if not settings.demo_bundle:
        return {"skipped": "no CUTROOM_DEMO_BUNDLE"}
    from .db import session_scope
    from .models import Project
    with session_scope() as s:
        if s.query(Project).count() and not force:
            log("projects already present — skipping demo bundle import")
            return {"skipped": "projects exist"}

    src_dir = settings.demo_src_dir
    marker = src_dir / ".imported"
    url = settings.demo_bundle
    log(f"demo bundle: {url}")
    try:
        if not (src_dir / "prompts/shots.jsonl").exists():
            name = url.split("?")[0].rsplit("/", 1)[-1] or "bundle.tar.zst"
            archive = settings.data_dir / name
            if not archive.exists():
                download_bundle(url, archive, settings.demo_bundle_token, log)
            extract_bundle(archive, src_dir, log)
        from .importer.game7 import import_game7
        pid = settings.demo_project
        log(f"importing {src_dir} as project {pid} …")
        stats = import_game7(str(src_dir), pid, label=pid, log=log)
        enable_backend("mock", log)
        apply_lane_env(pid, log)
        from .db import session_scope as _ss
        from .jobs.queue import submit_job
        with _ss() as s:
            submit_job(s, "thumbs.warm", {"project": pid}, pid, "cpu",
                       f"warm thumbnails: {pid}")
        marker.write_text(json.dumps(stats))
        log(f"demo ready: {stats}")
        return {"imported": stats, "project": pid}
    except Exception as e:                          # never block the server
        log(f"demo bundle import FAILED: {type(e).__name__}: {e}")
        return {"error": str(e)}


def boot_import_async() -> None:
    """Run boot_import off the event loop; the API serves while it copies."""
    if not get_settings().demo_bundle:
        return
    threading.Thread(target=boot_import, name="demo-boot",
                     daemon=True).start()

"""Import an existing game7-layout production repo into a Cutroom project.

Media trees are copied verbatim (renders/, audio/, assembly/), so every path
recorded in curation/overrides keeps working. Shots come from
prompts/shots.jsonl; keeper picks from renders/curation.json; timeline edits
from dashboard/state/overrides-<id>.json; comps from dashboard/state/
comps-<id>.json. Takes are then indexed from the copied trees.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Callable

from sqlalchemy import select

from ..db import session_scope
from ..models import Comp, Project, Shot, Take
from ..storage import get_storage

SID_RE = re.compile(r"^(B\d\d-S\d+)$")
SID_PREFIX_RE = re.compile(r"^(B\d\d-S\d+)")
SID_OR_BEAT_RE = re.compile(r"(B\d\d-S\d+|B\d\d)")
SEED_RE = re.compile(r"_s(\d+)")

MEDIA_TREES = ["renders", "audio", "assembly"]

SCAN_RULES: list[tuple[str, str, str]] = [
    # (glob under project root, take kind, sid-regex mode)
    ("renders/stills/*.png", "still", "prefix"),
    ("renders/characters/*.png", "still", "none"),
    ("renders/motion/*.webm", "motion", "prefix"),
    ("renders/motion/tests/*.webm", "crop", "prefix"),
    ("renders/motion/tests/*.mp4", "motion", "prefix"),
    ("renders/motion/ambient/*.webm", "motion", "none"),
    ("renders/fx/*.mp4", "fx", "prefix"),
    ("renders/motion-stress/*.mp4", "chain", "prefix"),
    ("renders/tests/field-geometry/*.png", "i2i", "prefix"),
    ("renders/refs/photo/*.jpg", "ref", "none"),
    ("renders/refs/photo/*.png", "ref", "none"),
    ("audio/generated/*.wav", "vo", "loose"),
    ("audio/generated/*.mp3", "vo", "loose"),
    ("assembly/*.mp4", "animatic", "none"),
]


# ------------------------------------------------------------------ cast index

DASHES = ("\u2014", "\u2013", " - ")          # em dash, en dash, spaced hyphen
ARTICLES = ("the ", "a ", "an ")
PREPOSITIONS = (" at ", " of ", " in ", " on ", " with ", " from ", " for ",
                " who ", " and ")
NAME_STOPWORDS = {"the", "a", "an", "and", "flashback", "young", "old"}


def _role_aliases(role: str) -> list[str]:
    """'the veteran catcher' -> ['veteran catcher', 'catcher'];
    'the son at the grave' -> ['son at the grave', 'son']."""
    role = role.strip().strip(".").lower()
    for a in ARTICLES:
        if role.startswith(a):
            role = role[len(a):]
            break
    if not role:
        return []
    out = [role]
    head = role
    for prep in PREPOSITIONS:                       # cut trailing qualifiers
        if prep in head:
            head = head.split(prep)[0].strip()
    if head != role and head:
        out.append(head)
    last = head.split()[-1] if head.split() else ""
    if len(last) >= 3 and last != head:
        out.append(last)
    elif len(head) >= 3 and head not in out:
        out.append(head)
    return out


def cast_entry(rec: dict) -> dict | None:
    """One characters.jsonl row -> {id, name, aliases[], descriptor}."""
    descriptor = str(rec.get("character") or "").strip()
    cid = str(rec.get("id") or "").strip()
    if not descriptor:
        return None
    name, role = descriptor, ""
    for d in DASHES:
        if d in descriptor:
            name, role = descriptor.split(d, 1)
            break
    name = re.sub(r"\(.*?\)", "", name).strip().strip(",")
    aliases: list[str] = []

    def add(a: str) -> None:
        a = a.strip().lower()
        if len(a) >= 3 and a not in aliases:
            aliases.append(a)

    if name:
        add(name)
        tokens = [w for w in re.split(r"[^A-Za-z0-9'-]+", name) if w]
        if len(tokens) > 1:
            for w in tokens:
                if w.lower() not in NAME_STOPWORDS:
                    add(w)
    for a in _role_aliases(role):
        add(a)
    if not cid:
        cid = "CHAR-" + (re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
                         or "unknown")
    return {"id": cid, "name": name or descriptor, "aliases": aliases,
            "descriptor": descriptor}


def build_cast(rows: list[dict]) -> list[dict]:
    out = []
    for rec in rows:
        e = cast_entry(rec)
        if e:
            out.append(e)
    return out


def reimport_cast(project_id: str, src_root: str,
                  log: Callable[[str], None] = print) -> dict:
    """Refresh project.settings['cast'] from a game7 tree — no media copy."""
    src = Path(src_root).expanduser().resolve()
    rows = _read_jsonl(src / "prompts/characters.jsonl")
    cast = build_cast(rows)
    with session_scope() as s:
        proj = s.get(Project, project_id)
        if proj is None:
            raise RuntimeError(f"no project {project_id}")
        settings = dict(proj.settings or {})
        settings["characters"] = rows
        settings["cast"] = cast
        proj.settings = settings
    log(f"cast: {len(cast)} characters from {src}")
    return {"cast": len(cast), "characters": [c["id"] for c in cast]}


def _read_jsonl(path: Path) -> list[dict]:
    out = []
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def _load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def import_game7(src_root: str, project_id: str, label: str | None = None,
                 log: Callable[[str], None] = print,
                 copy_media: bool = True) -> dict:
    src = Path(src_root).expanduser().resolve()
    shots_jsonl = src / "prompts/shots.jsonl"
    if not shots_jsonl.exists():
        raise RuntimeError(f"{src} is not a game7-layout repo "
                           "(no prompts/shots.jsonl)")
    store = get_storage().create_project(project_id)

    # ---- media trees -------------------------------------------------------
    copied = 0
    if copy_media:
        for tree in MEDIA_TREES:
            s_dir = src / tree
            if not s_dir.is_dir():
                continue
            log(f"copying {tree}/ …")
            shutil.copytree(s_dir, store.root / tree, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns(".DS_Store",
                                                          "__pycache__"))
            copied += 1
    store.ensure_layout()

    curation = _load_json(src / "renders/curation.json", {}).get("shots", {})
    overrides = {}
    ov_dir = src / "dashboard/state"
    if ov_dir.is_dir():
        candidates = sorted(ov_dir.glob("overrides-*.json")) + \
            [ov_dir / "overrides.json"]
        for c in candidates:
            if c.exists():
                overrides = _load_json(c, {})
                log(f"overrides from {c.name}: {len(overrides)} shots")
                break

    def resolve_keeper(sid: str, entry) -> str | None:
        entry = entry if isinstance(entry, dict) else {}
        for cand in (entry.get("keeper"),
                     f"{sid}_{entry['seed']}.png" if entry.get("seed") else None):
            if cand and store.exists(f"renders/stills/{cand}"):
                return f"renders/stills/{cand}"
        return None

    # ---- shots ---------------------------------------------------------------
    n_shots = n_skipped = 0
    with session_scope() as s:
        if not s.get(Project, project_id):
            s.add(Project(id=project_id, label=label or project_id))
        # idempotency: a re-import replaces shots/takes/comps
        for model in (Shot, Take, Comp):
            for row in s.execute(select(model).where(
                    model.project_id == project_id)).scalars():
                s.delete(row)
        s.flush()
        for i, rec in enumerate(_read_jsonl(shots_jsonl)):
            sid = rec.get("id", "")
            if not SID_RE.match(sid):
                n_skipped += 1
                continue
            cur = curation.get(sid)
            cur = cur if isinstance(cur, dict) else {}
            s.add(Shot(
                project_id=project_id, sid=sid, beat=rec.get("beat", ""),
                act=int(rec.get("act", 0)), type=rec.get("type", "STILL"),
                seconds=float(rec.get("seconds", 4)),
                register=rec.get("register", ""),
                image_prompt=rec.get("image_prompt", ""),
                negative=rec.get("negative", ""),
                motion_prompt=rec.get("motion_prompt"),
                pan=rec.get("pan"), radio=rec.get("radio"),
                dialogue=rec.get("dialogue") or [],
                sfx=rec.get("sfx"), ambient=rec.get("ambient"),
                cut=rec.get("cut"), render_notes=rec.get("render_notes"),
                note=rec.get("note"), order_idx=i,
                keeper=resolve_keeper(sid, cur),
                curation_note=cur.get("note"),
                override=overrides.get(sid, {}) or {}))
            n_shots += 1

        # ---- takes from the copied trees ----------------------------------
        n_takes = 0
        for pattern, kind, mode in SCAN_RULES:
            for rel in store.listdir(str(Path(pattern).parent),
                                     Path(pattern).name):
                name = Path(rel).name
                sid = None
                if mode == "prefix":
                    m = SID_PREFIX_RE.match(Path(rel).stem)
                    sid = m.group(1) if m else None
                elif mode == "loose":
                    m = SID_OR_BEAT_RE.search(Path(rel).stem)
                    sid = m.group(1) if m else None
                seed_m = SEED_RE.search(name)
                s.add(Take(project_id=project_id, shot_sid=sid, kind=kind,
                           path=rel,
                           seed=int(seed_m.group(1)) if seed_m and
                           len(seed_m.group(1)) < 10 else None,
                           meta={"imported": True}))
                n_takes += 1

        # ---- comps ---------------------------------------------------------
        n_comps = 0
        if ov_dir.is_dir():
            for cf in sorted(ov_dir.glob("comps-*.json")):
                comps = _load_json(cf, {}).get("comps", {})
                for cid, c in comps.items():
                    s.add(Comp(project_id=project_id, cid=cid,
                               shot_sid=c.get("shot_id"),
                               background=c.get("background", ""),
                               duration=float(c.get("duration", 4.0)),
                               layers=c.get("layers", []),
                               background_history=c.get("background_history",
                                                        [])))
                    n_comps += 1
                break

        # ---- project settings (cues, characters — kept for the assembler) --
        proj = s.get(Project, project_id)
        settings = dict(proj.settings or {})
        settings["imported_from"] = str(src)
        char_rows = _read_jsonl(src / "prompts/characters.jsonl")
        settings["characters"] = char_rows
        settings["cast"] = build_cast(char_rows)
        settings["sfx_cues"] = _read_jsonl(src / "audio/sfx-cues.jsonl")
        settings["music_cues"] = _read_jsonl(src / "audio/music-cues.jsonl")
        settings["mix_overrides"] = _read_jsonl(src / "audio/mix-overrides.jsonl")
        proj.settings = settings
        if label:
            proj.label = label

    log(f"imported: {n_shots} shots ({n_skipped} audit records skipped), "
        f"{n_takes} takes, {n_comps} comps, {copied} media trees")
    return {"shots": n_shots, "skipped": n_skipped, "takes": n_takes,
            "comps": n_comps}

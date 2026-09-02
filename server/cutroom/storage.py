"""Project media storage.

Every project gets a directory following the studio folder layout (see
docs/ARCHITECTURE.md), which keeps the engine, the importer, and human
inspection all trivially compatible.
All API paths are project-relative and resolved through `ProjectStore.resolve`,
which jails them to the project root (no traversal).

The `Storage` class is the seam for other backends (S3/GCS): implement the same
resolve/open semantics against object keys and hand media URLs to the API layer.
"""
from __future__ import annotations

import shutil
from pathlib import Path

LAYOUT = [
    "renders/stills",
    "renders/i2i",
    "renders/motion",
    "renders/motion/tests",
    "renders/chains",
    "renders/fx",
    "renders/fx/specs",
    "renders/refs",
    "audio/generated",
    "audio/sfx",
    "audio/music",
    "assembly",
    "uploads",
    "logs",
    ".cache/thumbs",
    ".cache/frames",
]

MEDIA_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov",
              ".wav", ".mp3", ".m4a", ".json"}


class StorageError(Exception):
    pass


class ProjectStore:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def ensure_layout(self) -> None:
        for rel in LAYOUT:
            (self.root / rel).mkdir(parents=True, exist_ok=True)

    def resolve(self, rel: str) -> Path:
        p = (self.root / rel).resolve()
        if p != self.root and self.root not in p.parents:
            raise StorageError(f"path escapes project root: {rel}")
        return p

    def rel(self, p: Path) -> str:
        return str(Path(p).resolve().relative_to(self.root))

    def exists(self, rel: str) -> bool:
        return self.resolve(rel).exists()

    def write_bytes(self, rel: str, data: bytes) -> Path:
        p = self.resolve(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def copy_in(self, src: Path, rel: str) -> Path:
        p = self.resolve(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, p)
        return p

    def listdir(self, rel: str, pattern: str = "*") -> list[str]:
        d = self.resolve(rel)
        if not d.is_dir():
            return []
        return sorted(self.rel(f) for f in d.glob(pattern) if f.is_file())

    def unique_rel(self, rel: str) -> str:
        """Never overwrite: suffix -2, -3… if the target exists."""
        p = self.resolve(rel)
        if not p.exists():
            return rel
        stem, suffix = p.stem, p.suffix
        i = 2
        while (p.parent / f"{stem}-{i}{suffix}").exists():
            i += 1
        return self.rel(p.parent / f"{stem}-{i}{suffix}")


class Storage:
    def __init__(self, projects_dir: Path):
        self.projects_dir = Path(projects_dir)

    def project(self, project_id: str) -> ProjectStore:
        if not project_id or "/" in project_id or project_id.startswith("."):
            raise StorageError(f"bad project id: {project_id}")
        return ProjectStore(self.projects_dir / project_id)

    def create_project(self, project_id: str) -> ProjectStore:
        store = self.project(project_id)
        store.root.mkdir(parents=True, exist_ok=True)
        store.ensure_layout()
        return store


def get_storage() -> Storage:
    from .config import get_settings
    return Storage(get_settings().projects_dir)

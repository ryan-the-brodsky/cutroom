"""Cutroom settings — everything the old pipeline hard-coded, now env-driven.

CUTROOM_DATA          root for all project stores, DB, logs   (default ~/.cutroom)
CUTROOM_DATABASE_URL  SQLAlchemy URL (default sqlite under data dir)
CUTROOM_AUTH_TOKEN    bearer token; empty disables auth (local dev)
CUTROOM_WORKER_TOKEN  token remote workers use to claim jobs
CUTROOM_RUN_WORKERS   "0" turns off in-process pool workers (API-only node)
CUTROOM_ALLOW_CLAUDE_CLI  enable the self-host `claude -p` direction provider

Hosted demo (see cutroom/demo.py and docs/BACKENDS.md "Hosted demo"):

CUTROOM_DEMO          "1" → demo mode: admin/viewer split, rate limits, spend cap
CUTROOM_ADMIN_TOKEN   bearer token with full rights (backends, lanes, import, pause)
CUTROOM_AUTH_TOKEN    viewer/judge token — may generate and edit, may not configure
CUTROOM_DEMO_BUDGET_USD       rolling-24h estimated spend ceiling (default 10)
CUTROOM_DEMO_PAID_JOBS_PER_HOUR   per-token paid job cap (default 12)
CUTROOM_DEMO_JOBS_PER_MIN         per-token any-job cap (default 60)
CUTROOM_DEMO_BUNDLE       url of a demo bundle tarball; imported at boot if empty
CUTROOM_DEMO_BUNDLE_TOKEN bearer token for that url (private GitHub Release asset)
CUTROOM_DEMO_PROJECT      project id the bundle imports as (default next-year)
CUTROOM_OPENROUTER_MODEL        direction model (default z-ai/glm-5.3-flash)
CUTROOM_OPENROUTER_IMAGE_MODEL  still/i2i model (default google/gemini-2.5-flash-image)
CUTROOM_FAL_MOTION_MODEL        fal i2v model (default Wan 2.2 A14B turbo i2v)
CUTROOM_LANE_<LANE>=<backend>[:<model>]   demo project lane default
CUTROOM_COST_<BACKEND_ID>=<usd>           per-take cost estimate for the spend cap
"""
from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CUTROOM_", extra="ignore")

    # The documented env is CUTROOM_DATA, but the prefix would map this field to
    # CUTROOM_DATA_DIR — so bind it explicitly. Using an alias (not an
    # import-time default) means every Settings() re-reads the current env, which
    # is what makes per-test data-dir isolation actually work.
    data_dir: Path = Field(default_factory=lambda: Path("~/.cutroom"),
                           validation_alias="CUTROOM_DATA")

    @field_validator("data_dir", mode="after")
    @classmethod
    def _expand_data_dir(cls, v: Path) -> Path:
        return v.expanduser()
    database_url: str = ""
    auth_token: str = ""
    worker_token: str = ""
    host: str = "127.0.0.1"
    port: int = 8770
    run_workers: bool = True
    cpu_pool_size: int = 2
    api_pool_size: int = 4
    allow_claude_cli: bool = False
    claude_cli_bin: str = "claude"
    cors_origins: str = "*"          # comma-separated; SPA dev server needs this
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"

    # ---- hosted demo -----------------------------------------------------
    demo: bool = False
    admin_token: str = ""
    demo_budget_usd: float = 10.0
    demo_paid_jobs_per_hour: int = 12
    demo_jobs_per_min: int = 60
    demo_bundle: str = ""
    demo_bundle_token: str = ""
    demo_project: str = "next-year"
    openrouter_model: str = "z-ai/glm-5.3-flash"
    openrouter_image_model: str = "google/gemini-2.5-flash-image"
    fal_motion_model: str = "fal-ai/wan/v2.2-a14b/image-to-video/turbo"

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{self.data_dir / 'cutroom.db'}"

    @property
    def demo_src_dir(self) -> Path:
        return self.data_dir / "demo-src"

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.projects_dir, self.logs_dir):
            d.mkdir(parents=True, exist_ok=True)


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
        _settings.ensure_dirs()
    return _settings


def reset_settings() -> None:
    """Test hook."""
    global _settings
    _settings = None

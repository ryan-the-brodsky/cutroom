"""Cutroom settings — everything the old pipeline hard-coded, now env-driven.

CUTROOM_DATA          root for all project stores, DB, logs   (default ~/.cutroom)
CUTROOM_DATABASE_URL  SQLAlchemy URL (default sqlite under data dir)
CUTROOM_AUTH_TOKEN    bearer token; empty disables auth (local dev)
CUTROOM_WORKER_TOKEN  token remote workers use to claim jobs
CUTROOM_RUN_WORKERS   "0" turns off in-process pool workers (API-only node)
CUTROOM_ALLOW_CLAUDE_CLI  enable the self-host `claude -p` direction provider
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

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{self.data_dir / 'cutroom.db'}"

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

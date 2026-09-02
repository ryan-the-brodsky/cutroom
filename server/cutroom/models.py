from __future__ import annotations

import time
import uuid

from sqlalchemy import (JSON, Boolean, Float, ForeignKey, Integer, String,
                        Text, UniqueConstraint)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now() -> float:
    return time.time()


def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:12]


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    label: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[float] = mapped_column(Float, default=now)
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    # e.g. {"fps": 24, "style": {...}, "cast": [...], "characters": [...]}
    settings: Mapped[dict] = mapped_column(JSON, default=dict)


class Shot(Base):
    """One script row. Prompts are the guaranteed deliverable; the override
    column is the non-destructive timeline edit layer (the old overrides.json)."""
    __tablename__ = "shots"
    __table_args__ = (UniqueConstraint("project_id", "sid"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    sid: Mapped[str] = mapped_column(String(64), index=True)
    beat: Mapped[str] = mapped_column(String(32), default="")
    act: Mapped[int] = mapped_column(Integer, default=0)
    type: Mapped[str] = mapped_column(String(32), default="STILL")
    seconds: Mapped[float] = mapped_column(Float, default=4.0)
    register: Mapped[str] = mapped_column(String(200), default="")
    image_prompt: Mapped[str] = mapped_column(Text, default="")
    negative: Mapped[str] = mapped_column(Text, default="")
    motion_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    pan: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The narration lane: what a voice says over the shot, as written.
    # Called `radio` before Cutroom knew more than one film; the API still
    # reads and writes that spelling for one release.
    narration: Mapped[str | None] = mapped_column(Text, nullable=True)
    dialogue: Mapped[list] = mapped_column(JSON, default=list)
    sfx: Mapped[str | None] = mapped_column(Text, nullable=True)
    ambient: Mapped[str | None] = mapped_column(Text, nullable=True)
    cut: Mapped[str | None] = mapped_column(Text, nullable=True)
    render_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    order_idx: Mapped[int] = mapped_column(Integer, default=0)
    keeper: Mapped[str | None] = mapped_column(String(500), nullable=True)
    curation_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # {seconds, source, vo_file, vo_offset, mute_vo, note, refs: []}
    override: Mapped[dict] = mapped_column(JSON, default=dict)
    extra: Mapped[dict] = mapped_column(JSON, default=dict)


class Take(Base):
    """Any produced or imported asset, with lineage as first-class columns."""
    __tablename__ = "takes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    shot_sid: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    # still | i2i | motion | crop | fx | comp | chain | panel | vo | sfx | music |
    # ref | animatic | upload
    kind: Mapped[str] = mapped_column(String(32), index=True)
    path: Mapped[str] = mapped_column(String(500))          # project-relative
    backend_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    sources: Mapped[list] = mapped_column(JSON, default=list)  # parent rel-paths
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    job_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[float] = mapped_column(Float, default=now)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)


class Comp(Base):
    """The cel model as data: background plate + z-ordered animated layers."""
    __tablename__ = "comps"
    __table_args__ = (UniqueConstraint("project_id", "cid"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    cid: Mapped[str] = mapped_column(String(96), index=True)
    shot_sid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    background: Mapped[str] = mapped_column(String(500))
    width: Mapped[int] = mapped_column(Integer, default=1920)
    height: Mapped[int] = mapped_column(Integer, default=1080)
    duration: Mapped[float] = mapped_column(Float, default=4.0)
    # [{id, clip, region[l,t,r,b], feather, matte, media{loop,speed,start},
    #   opacity, z, prompt, frames, steps, cfg, start_frame, pending_clip}]
    layers: Mapped[list] = mapped_column(JSON, default=list)
    background_history: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[float] = mapped_column(Float, default=now)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    type: Mapped[str] = mapped_column(String(64))
    pool: Mapped[str] = mapped_column(String(96), index=True)
    title: Mapped[str] = mapped_column(String(300), default="")
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    log_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[float] = mapped_column(Float, default=now)
    started_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    finished_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    worker: Mapped[str | None] = mapped_column(String(96), nullable=True)
    # optional follow-up submitted on success: {"type":..., "payload":...}
    chain: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class Backend(Base):
    """A pluggable generation backend (adapter instance)."""
    __tablename__ = "backends"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # comfyui | openai-images | openrouter-image | fal | replicate |
    # elevenlabs | anthropic | openai-chat | claude-cli
    type: Mapped[str] = mapped_column(String(32))
    label: Mapped[str] = mapped_column(String(200), default="")
    base_url: Mapped[str] = mapped_column(String(500), default="")
    api_key: Mapped[str] = mapped_column(String(500), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # adapter-specific config; for comfyui: workflow param blocks per lane,
    # concurrency, free_after. For others: model defaults, voices, etc.
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[float] = mapped_column(Float, default=now)

    def masked(self) -> dict:
        key = self.api_key or ""
        return {
            "id": self.id, "type": self.type, "label": self.label,
            "base_url": self.base_url, "enabled": self.enabled,
            "options": self.options, "created_at": self.created_at,
            "api_key_set": bool(key),
            "api_key_hint": (key[:3] + "…" + key[-2:]) if len(key) > 8 else ("set" if key else ""),
        }


class LaneConfig(Base):
    """Per-project default backend/model/params for a lane."""
    __tablename__ = "lane_configs"
    __table_args__ = (UniqueConstraint("project_id", "lane"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    lane: Mapped[str] = mapped_column(String(32))  # still|i2i|motion|vo|direction
    backend_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    params: Mapped[dict] = mapped_column(JSON, default=dict)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    role: Mapped[str] = mapped_column(String(32))       # director | assistant | tool
    provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    ts: Mapped[float] = mapped_column(Float, default=now)

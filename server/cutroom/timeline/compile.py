"""Compile the film (shots + takes + overrides + curation) into a real
Timeline, and project that Timeline onto the FreeCut engine's render input.

This is the bridge from the shot-slot model to the clip model. Each shot becomes
a clip on V1 (using the same `film.active_source` precedence the assembler
honors); its VO becomes an audio clip on A1 placed at head_pad +
offset. Stills hold true-still (image clips). Generation lineage rides along in
each clip's `cutroom` block.

Enrichments (Phase 5):
- ALL VO lines for a shot are laid sequentially on A1 (never overlapping),
  the first at head_pad + offset, each subsequent butted against the previous.
- Music / SFX cues in Project.settings compile onto dedicated MUSIC / SFX
  audio tracks, anchored to their shot/beat (or an absolute `start`).
- `scope="act1".."act4"` compiles only that act, re-based to frame 0.

Known v1 simplification (tracked in PLAN.md):
- a video shorter than its shot plays its full length; the freeze-tail *hold*
  that fills the remainder is not yet emitted as a second item (so total runtime
  can be slightly under the audio-fit assembler's).
"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

from sqlalchemy import func, select

from .. import film
from ..engine import ffmpeg as ff
from ..models import Project, Shot, Take
from ..storage import ProjectStore
from . import model as m

CLIP_EXTS = (".mp4", ".webm", ".mov")
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
HEAD_PAD = 0.3  # seconds — the VO breath before a line, matching the assembler

# cue records (from audio/*-cues.jsonl → Project.settings) use varied keys;
# accept every shape the importer preserves plus the plain {path, start} form.
_CUE_SRC_KEYS = ("path", "file", "source", "sfx-file", "sfx_file",
                 "music-file", "music_file")
_CUE_DUR_KEYS = ("duration_s", "duration", "duration_seconds")
_CUE_GAIN_KEYS = ("gain", "gain-hint", "gain_hint")


def _cue_get(cue: dict, keys: tuple[str, ...]):
    for k in keys:
        v = cue.get(k)
        if v not in (None, ""):
            return v
    return None


def _cue_start_frame(cue: dict, shot_starts: dict[str, int],
                     beat_starts: dict[str, int], fps: int) -> int | None:
    """Absolute timeline start frame for a cue, or None if it anchors to a
    shot/beat that isn't in this (possibly scoped) compile."""
    offset = m.seconds_to_frames(float(cue.get("offset") or 0), fps)
    if cue.get("start") is not None:                    # plain absolute form
        return max(0, m.seconds_to_frames(float(cue["start"]), fps) + offset)
    sid = cue.get("shot")                               # SFX form: shot + offset
    if sid is not None:
        anchor = shot_starts.get(sid, beat_starts.get(sid))
        return None if anchor is None else max(0, anchor + offset)
    anchors = cue.get("shots") or cue.get("beats")      # music form: shot/beat span
    if anchors is not None:
        if isinstance(anchors, str):
            anchors = [anchors]
        found = [shot_starts[a] for a in anchors if a in shot_starts]
        found += [beat_starts[a] for a in anchors if a in beat_starts]
        return None if not found else max(0, min(found) + offset)
    return max(0, offset)                               # unanchored → origin


def _cue_duration_frames(cue: dict, store: ProjectStore, source: str,
                         fps: int) -> int | None:
    d = _cue_get(cue, _CUE_DUR_KEYS)
    if d is not None:
        try:
            return max(1, m.seconds_to_frames(float(d), fps))
        except (TypeError, ValueError):
            pass
    if source and store.exists(source):
        try:
            return max(1, m.seconds_to_frames(
                ff.probe_duration(store.resolve(source)), fps))
        except Exception:
            return None
    return None


def _compile_cues(cues, role: str, track: m.Track, store: ProjectStore,
                  shot_starts: dict[str, int], beat_starts: dict[str, int],
                  fps: int) -> list[m.Clip]:
    """Turn a list of cue records into audio clips on `track`."""
    out: list[m.Clip] = []
    if not isinstance(cues, list):
        return out
    for cue in cues:
        if not isinstance(cue, dict):
            continue
        source = _cue_get(cue, _CUE_SRC_KEYS)
        if not source:
            continue
        start = _cue_start_frame(cue, shot_starts, beat_starts, fps)
        if start is None:
            continue
        dur = _cue_duration_frames(cue, store, source, fps)
        if not dur:
            continue
        lineage: dict = {"role": role}
        if cue.get("id"):
            lineage["cue"] = str(cue["id"])   # what the Timeline drags by
        gain = _cue_get(cue, _CUE_GAIN_KEYS)
        if gain is not None:
            lineage["gain"] = gain
        if cue.get("shot"):
            lineage["shot"] = cue["shot"]
        out.append(m.Clip(
            track_id=track.id, kind="audio", start=start, duration=dur,
            source=source, source_start=0, source_end=dur,
            source_duration=dur, source_fps=fps,
            label=f"{role}:{Path(source).name}", cutroom=lineage))
    return out


def _act_filter(scope: str | None) -> int | None:
    """`"act1".."act4"` → the act number; anything else → None (whole film)."""
    if not scope:
        return None
    s = str(scope).strip().lower()
    if s.startswith("act"):
        try:
            return int(s[3:])
        except ValueError:
            return None
    return None


# project_id -> (fingerprint, compiled dict). Makes the UI's revalidation cheap
# (the first cold compile probes every clip; repeats skip straight to the cache
# unless the project's shots/takes/overrides/settings changed).
_COMPILE_CACHE: dict[str, tuple[str, dict]] = {}


def _fingerprint(session, project_id: str) -> str:
    rows = session.execute(
        select(Shot.sid, Shot.seconds, Shot.keeper, Shot.override, Shot.order_idx,
               Shot.dialogue)
        .where(Shot.project_id == project_id)
        .order_by(Shot.order_idx, Shot.id)).all()
    n_takes = session.execute(select(func.count(Take.id))
                              .where(Take.project_id == project_id)).scalar() or 0
    max_take = session.execute(select(func.max(Take.created_at))
                               .where(Take.project_id == project_id)).scalar() or 0
    proj = session.get(Project, project_id)
    blob = json.dumps({
        "shots": [list(r) for r in rows], "n_takes": n_takes,
        "max_take": max_take, "settings": (proj.settings if proj else {})},
        sort_keys=True, default=str)
    return hashlib.md5(blob.encode()).hexdigest()


def compile_film_cached(store: ProjectStore, session, project_id: str,
                        **kw) -> m.Timeline:
    """compile_film with a fingerprint cache (whole-film only; scoped compiles
    are cheap and always fresh)."""
    if kw.get("scope"):
        return compile_film(store, session, project_id, **kw)
    fp = _fingerprint(session, project_id)
    hit = _COMPILE_CACHE.get(project_id)
    if hit and hit[0] == fp:
        return m.Timeline.from_dict(hit[1])
    tl = compile_film(store, session, project_id, **kw)
    _COMPILE_CACHE[project_id] = (fp, tl.to_dict())
    return tl


@lru_cache(maxsize=4096)
def _probe_video(path_str: str) -> tuple[int | None, float | None]:
    """(frame_count, fps) for a video file. Cached — renders are immutable."""
    try:
        info = ff.probe_streams(path_str)
        vs = next(s for s in info.get("streams", []) if s.get("codec_type") == "video")
        num, _, den = (vs.get("r_frame_rate") or "24/1").partition("/")
        fps = float(num) / float(den or 1)
        nb = vs.get("nb_frames")
        if nb and str(nb).isdigit() and int(nb) > 0:
            return int(nb), fps
        dur = float(info.get("format", {}).get("duration") or 0)
        return (round(dur * fps) if dur else None), fps
    except Exception:
        return None, None


def compile_film(store: ProjectStore, session, project_id: str, *,
                 fps: int = 24, width: int = 1920, height: int = 1080,
                 head_pad: float = HEAD_PAD, scope: str | None = None) -> m.Timeline:
    """Compile the film into a Timeline.

    `scope`: None → the whole film; `"act1".."act4"` → only that act's shots,
    re-based to frame 0 (V/A1/cue clips all start at the scoped origin).
    """
    shots = film.shots_ordered(session, project_id)
    act = _act_filter(scope)
    if act is not None:
        shots = [sh for sh in shots if sh.act == act]
    takes = film.takes_by_shot(session, project_id)

    v = m.Track(kind="video", name="V1", order=0)
    a = m.Track(kind="audio", name="A1", order=1)
    # `head_pad` rides along so a client can invert the VO placement below
    # (line start = shot start + head_pad + vo_offset) without a constant of
    # its own that could drift from this one.
    cr = {"project": project_id, "source": "film-compile", "head_pad": head_pad}
    if scope:
        cr["scope"] = scope
    tl = m.Timeline(fps=fps, width=width, height=height, tracks=[v, a], cutroom=cr)

    cursor = 0
    head_pad_f = m.seconds_to_frames(head_pad, fps)
    shot_starts: dict[str, int] = {}
    beat_starts: dict[str, int] = {}

    for shot in shots:
        shot_starts[shot.sid] = cursor
        if shot.beat:
            beat_starts.setdefault(shot.beat, cursor)   # earliest (shots ordered)
        stakes = takes.get(shot.sid, [])
        src = film.active_source(store, shot, stakes)
        ov = shot.override or {}
        seconds = float(ov.get("seconds", shot.seconds) or 0)
        shot_frames = max(1, m.seconds_to_frames(seconds, fps))
        lineage = {"shot": shot.sid, "beat": shot.beat, "act": shot.act,
                   "type": shot.type, "register": shot.register}

        if src and Path(src).suffix.lower() in CLIP_EXTS:
            sf, sfps = _probe_video(str(store.resolve(src)))
            if sf:
                dur = min(shot_frames, sf)     # v1: no freeze-hold past clip end
                clip = m.Clip(track_id=v.id, kind="video", start=cursor, duration=dur,
                              source=src, source_start=0, source_end=dur,
                              source_duration=sf, source_fps=sfps,
                              label=shot.sid, cutroom=lineage)
            else:
                dur = shot_frames
                clip = m.Clip(track_id=v.id, kind="video", start=cursor, duration=dur,
                              source=src, label=shot.sid, cutroom=lineage)
        elif src:                              # a still — a TRUE hold
            dur = shot_frames
            clip = m.Clip(track_id=v.id, kind="image", start=cursor, duration=dur,
                          source=src, label=shot.sid, cutroom=lineage)
        else:                                  # no take yet — a slate placeholder
            dur = shot_frames
            clip = m.Clip(track_id=v.id, kind="text", start=cursor, duration=dur,
                          text=shot.sid, color="#334155", label=shot.sid,
                          cutroom={**lineage, "slate": True})
        tl.clips.append(clip)

        # VO → A1: one clip per SCRIPTED dialogue line (not per take variant —
        # vo_paths scans the take directory, so cap to the shot's line count or
        # the film balloons with alternate takes). Lines butt sequentially and
        # never overlap; the first sits at head_pad + offset.
        if not ov.get("mute_vo"):
            n_lines = max(1, len(shot.dialogue or []))
            vps = [vp for vp in film.vo_paths(store, shot.sid, shot.beat, stakes)
                   if store.exists(vp)][:n_lines]
            vo_off = m.seconds_to_frames(float(ov.get("vo_offset", 0) or 0), fps)
            # anchored to THIS shot (no global carry — a long line must not push
            # every later shot's VO and balloon the film); lines within the shot
            # butt sequentially.
            line_start = max(0, cursor + head_pad_f + vo_off)
            for i, vp in enumerate(vps):
                try:
                    vdur = ff.probe_duration(store.resolve(vp))
                except Exception:
                    continue
                vframes = max(1, m.seconds_to_frames(vdur, fps))
                tl.clips.append(m.Clip(
                    track_id=a.id, kind="audio",
                    start=line_start, duration=vframes,
                    source=vp, source_start=0, source_end=vframes,
                    source_duration=vframes, source_fps=fps,
                    label=f"{shot.sid} vo", cutroom={"shot": shot.sid, "role": "vo",
                                                     "line": i}))
                line_start += vframes        # next line in this shot butts on

        cursor += dur

    # --- music / SFX cue tracks (order after A1) ---------------------------
    proj = session.get(Project, project_id)
    settings = (proj.settings or {}) if proj else {}
    order = 2
    for name, key, role in (("MUSIC", "music_cues", "music"),
                            ("SFX", "sfx_cues", "sfx")):
        track = m.Track(kind="audio", name=name, order=order)
        clips = _compile_cues(settings.get(key), role, track, store,
                              shot_starts, beat_starts, fps)
        if clips:
            tl.tracks.append(track)
            tl.clips.extend(clips)
            order += 1

    return tl.validate()


# --- projection onto the FreeCut engine's proven renderTimeline input --------

_QUALITY_BITRATE = {"low": 2_500_000, "medium": 5_000_000,
                    "high": 10_000_000, "ultra": 20_000_000}


def _fc_track(t: m.Track) -> dict:
    return {"id": t.id, "name": t.name or ("V" if t.kind == "video" else "A"),
            "kind": t.kind, "height": 60, "locked": False, "syncLock": True,
            "visible": True, "muted": False, "solo": False, "order": t.order,
            "items": []}


def _fc_item(c: m.Clip) -> dict:
    item: dict = {"id": c.id, "trackId": c.track_id, "from": c.start,
                  "durationInFrames": c.duration, "label": c.label or ""}
    if c.kind == "text":
        item.update({"type": "text", "text": c.text or "",
                     "color": c.color or "#ffffff", "fontSize": 64,
                     "fontWeight": "bold", "textAlign": "center",
                     "verticalAlign": "middle"})
        return item
    item.update({"type": c.kind, "mediaId": c.source, "speed": 1})
    if c.kind in ("video", "audio"):
        item["sourceStart"] = c.source_start
        item["sourceEnd"] = c.effective_source_end
        if c.source_duration is not None:
            item["sourceDuration"] = c.source_duration
        if c.source_fps is not None:
            item["sourceFps"] = c.source_fps
        item["volume"] = 0  # dB; VO on A1 rides at unity, silent video stays silent
    return item


def to_freecut_render_input(tl: m.Timeline, *, container: str = "mp4",
                            codec: str = "avc", quality: str = "high") -> dict:
    """The exact `window.freecut.renderTimeline` shape proven in the spike.

    `media` entries carry the project-relative `rel`; the node render harness
    resolves each against the project root, serves it over HTTP, and fills `url`.
    """
    media_rels: dict[str, None] = {}
    items = []
    for c in tl.clips:
        items.append(_fc_item(c))
        if c.kind != "text" and c.source:
            media_rels[c.source] = None

    audio_codec = "opus" if container == "webm" else "aac"
    settings = {"mode": "video", "codec": codec, "audioCodec": audio_codec,
                "container": container, "quality": quality,
                "resolution": {"width": tl.width, "height": tl.height},
                "fps": tl.fps, "videoBitrate": _QUALITY_BITRATE.get(quality, 10_000_000),
                "audioBitrate": 192_000}
    project = tl.cutroom.get("project", "cutroom")
    return {
        "tracks": [_fc_track(t) for t in sorted(tl.tracks, key=lambda t: t.order)],
        "items": items,
        "transitions": [],
        "fps": tl.fps, "width": tl.width, "height": tl.height,
        "backgroundColor": "#000000",
        "media": [{"mediaId": rel, "rel": rel} for rel in media_rels],
        "settings": settings,
        "outputFileName": f"{project}.{container}",
    }

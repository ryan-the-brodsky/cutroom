"""Job handlers — each production lane as an async function.

A handler receives (ctx, payload), speaks to adapters/engine, moves results
into project storage, and records Take rows (lineage). Blocking CPU work runs
in threads; adapter calls are async. Handlers never overwrite existing takes
(storage.unique_rel).
"""
from __future__ import annotations

import asyncio
import re
import shutil
import time
import uuid
from pathlib import Path

from sqlalchemy import select

from ..adapters import build_adapter
from ..adapters import motion_profiles as mprof
from ..adapters.base import BackendConfig, GenRequest
from ..adapters.registry import ADAPTER_TYPES
from ..config import get_settings
from .. import budget
from .. import cues as c_cues
from ..db import session_scope
from ..engine import assemble as e_asm
from ..engine import audio as e_audio
from ..engine import cels as e_cels
from ..engine import ffmpeg as e_ff
from ..engine import images as e_img
from ..engine import motion as e_motion
from ..engine import panels as e_panels
from ..models import Backend, Comp, LaneConfig, Shot, Take
from ..storage import get_storage
from .. import film

CHAIN_FREEZE = ("Static locked camera, the camera does not move, "
                "no camera movement, fixed tripod shot.")
CHAIN_TAIL = " Flat anime cel shading, clean line art, cinematic."


def _slug(s: str | None, n: int = 48) -> str:
    return re.sub(r"[^A-Za-z0-9-]+", "-", s or "").strip("-")[:n] or \
        f"gen-{uuid.uuid4().hex[:5]}"


def _workdir(ctx) -> Path:
    d = get_settings().data_dir / "tmp" / f"job-{ctx.job_id}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cleanup(d: Path) -> None:
    shutil.rmtree(d, ignore_errors=True)


class LaneChoice:
    def __init__(self, cfg: BackendConfig, model: str | None, params: dict):
        self.cfg, self.model, self.params = cfg, model, params

    def take_meta(self, extra: dict | None = None) -> dict:
        """Adapter-produced takes carry a mock marker in test mode so they
        never auto-promote into the timeline."""
        m = dict(extra or {})
        if self.cfg.type == "mock":
            m["mock"] = True
        return m


def pick_backend(project_id: str | None, lane: str,
                 backend_id: str | None = None,
                 model: str | None = None) -> LaneChoice:
    """explicit request > project lane default > first enabled backend
    whose adapter serves the lane."""
    with session_scope() as s:
        lc = None
        if project_id:
            lc = s.execute(select(LaneConfig).where(
                LaneConfig.project_id == project_id,
                LaneConfig.lane == lane)).scalar_one_or_none()
        bid = backend_id or (lc.backend_id if lc else None)
        row = s.get(Backend, bid) if bid else None
        if row and not row.enabled:
            # An EXPLICIT request for a disabled backend must fail loudly —
            # silently substituting another backend could route a test roll
            # to a paid endpoint (or a paid roll to the mock).
            if backend_id:
                raise RuntimeError(
                    f"backend {backend_id} is disabled — enable it in "
                    "Settings → Backends or pick another")
            row = None
        if row is None:
            for b in s.execute(select(Backend).where(
                    Backend.enabled.is_(True))
                    .order_by(Backend.created_at)).scalars():
                cls = ADAPTER_TYPES.get(b.type)
                if cls and lane in cls.lanes:
                    row = b
                    break
        if row is None:
            raise RuntimeError(
                f"no enabled backend serves lane '{lane}' — configure one "
                "in Settings → Backends")
        cls = ADAPTER_TYPES.get(row.type)
        if not cls or lane not in cls.lanes:
            raise RuntimeError(f"backend {row.id} ({row.type}) does not "
                               f"serve lane '{lane}'")
        return LaneChoice(BackendConfig.from_row(row),
                          model or (lc.model if lc else None),
                          dict((lc.params if lc else {}) or {}))


def record_take(project_id: str, shot_sid: str | None, kind: str, rel: str,
                *, backend_id=None, model=None, prompt=None, params=None,
                sources=None, seed=None, job_id=None, meta=None) -> None:
    # Cost accounting: one produced take = one unit of the backend's
    # options.cost_usd. This is the single hook the demo spend cap counts —
    # imported takes carry no backend_id and free backends cost 0, so neither
    # reaches the ledger.
    if backend_id:
        try:
            budget.charge(backend_id, 1, project_id, job_id)
        except Exception:                       # ledger must never fail a job
            pass
    with session_scope() as s:
        s.add(Take(project_id=project_id, shot_sid=shot_sid, kind=kind,
                   path=rel, backend_id=backend_id, model=model,
                   prompt=prompt, params=params or {}, sources=sources or [],
                   seed=seed, job_id=job_id, meta=meta or {}))


# ===================================================================== stills

async def gen_still(ctx, p: dict) -> dict:
    project = p["project"]
    store = get_storage().project(project)
    choice = pick_backend(project, "still", p.get("backend"), p.get("model"))
    adapter = build_adapter(choice.cfg)
    name = _slug(p.get("name") or p.get("shot") or "still")
    seeds = [int(s) for s in (p.get("seeds") or [int(time.time()) % 10 ** 6])]
    wd = _workdir(ctx)
    takes = []
    try:
        for seed in seeds:
            req = GenRequest(
                lane="still", workdir=wd, prompt=p["prompt"],
                negative=p.get("negative", ""), width=int(p.get("width", 768)),
                height=int(p.get("height", 432)), seed=seed,
                model=choice.model,
                params={**choice.params, **(p.get("params") or {}),
                        "_project": project},
                log=ctx.log)
            res = await adapter.generate(req)
            for f in res.files:
                rel = store.unique_rel(f"renders/stills/{name}_s{seed}{f.suffix}")
                store.copy_in(f, rel)
                record_take(project, p.get("shot"), "still", rel,
                            backend_id=choice.cfg.id,
                            model=choice.model or res.meta.get("model"),
                            prompt=p["prompt"], params=res.meta.get("options"),
                            seed=seed, job_id=ctx.job_id,
                            meta=choice.take_meta())
                takes.append(rel)
                ctx.log(f"take -> {rel}")
    finally:
        _cleanup(wd)
    return {"takes": takes}


async def gen_i2i(ctx, p: dict) -> dict:
    project = p["project"]
    store = get_storage().project(project)
    choice = pick_backend(project, "i2i", p.get("backend"), p.get("model"))
    adapter = build_adapter(choice.cfg)
    src = store.resolve(p["source"])
    name = _slug(p.get("name") or f"{Path(p['source']).stem}-i2i")
    seeds = [int(s) for s in (p.get("seeds") or [4242])]
    denoise = float(p.get("denoise", 0.85))
    wd = _workdir(ctx)
    takes = []
    try:
        for seed in seeds:
            req = GenRequest(
                lane="i2i", workdir=wd, prompt=p["prompt"],
                negative=p.get("negative", ""), source=src, seed=seed,
                denoise=denoise, model=choice.model,
                params={**choice.params, **(p.get("params") or {}),
                        "_project": project},
                log=ctx.log)
            res = await adapter.generate(req)
            for f in res.files:
                rel = store.unique_rel(f"renders/i2i/{name}_s{seed}{f.suffix}")
                store.copy_in(f, rel)
                record_take(project, p.get("shot"), "i2i", rel,
                            backend_id=choice.cfg.id, model=choice.model,
                            prompt=p["prompt"],
                            params={"denoise": denoise}, sources=[p["source"]],
                            seed=seed, job_id=ctx.job_id,
                            meta=choice.take_meta())
                takes.append(rel)
                ctx.log(f"take -> {rel}")
    finally:
        _cleanup(wd)
    return {"takes": takes, "denoise": denoise}


# ===================================================================== motion

async def _i2v(ctx, project: str, p: dict, source_png: Path, width: int,
               height: int, wd: Path, prompt: str) -> tuple[Path, LaneChoice]:
    choice = pick_backend(project, "motion", p.get("backend"), p.get("model"))
    adapter = build_adapter(choice.cfg)
    # The live window is a backend property. `seconds` is what the caller asked
    # for in film time; queue backends map it to their own duration parameter,
    # frame-count backends use `frames`.
    prof = mprof.profile_for(choice.cfg.options, choice.cfg.type,
                             choice.model or choice.cfg.options.get("model"))
    seconds = p.get("seconds")
    frames = p.get("frames")
    if seconds is None and frames is None:
        seconds = mprof.seconds_default(prof)
    if frames is None:
        frames = mprof.frames_for_seconds(prof, seconds)
    if seconds is None:
        seconds = mprof.seconds_for_frames(prof, frames)
    req = GenRequest(
        lane="motion", workdir=wd, prompt=prompt,
        negative=p.get("negative", ""), source=source_png,
        width=width, height=height, frames=int(frames),
        duration=float(seconds),
        steps=p.get("steps"), cfg=p.get("cfg"),
        seed=int(p.get("seed", 42)), model=choice.model,
        params={**choice.params, **(p.get("params") or {}),
                "_project": project}, log=ctx.log)
    res = await adapter.generate(req)
    clips = [f for f in res.files
             if f.suffix.lower() in (".webm", ".mp4", ".mov")]
    if not clips:
        raise RuntimeError(f"motion backend returned no clip: {res.files}")
    return clips[0], choice


async def gen_motion(ctx, p: dict) -> dict:
    """The cel lane: animate a region of the plate (or the whole frame),
    composite back onto the untouched plate. Optional auto freeze-tail."""
    project = p["project"]
    store = get_storage().project(project)
    plate_rel = p["plate"]
    plate = store.resolve(plate_rel)
    name = _slug(p.get("name") or f"{p.get('shot', 'motion')}-cel")

    from PIL import Image
    with Image.open(plate) as im:
        pw, ph = im.size
    region = p.get("region") or [0, 0, pw, ph]
    snapped = e_img.snap_region(region, pw, ph)
    l, t, r, b = snapped
    rw, rh = r - l, b - t
    ctx.log(f"plate {pw}x{ph}; region snapped {snapped} -> {rw}x{rh}; "
            f"pinned edges: {e_img.pinned_edges(snapped, pw, ph) or 'none'}")

    wd = _workdir(ctx)
    try:
        crop_png = wd / "crop.png"
        if p.get("start_frame"):
            sf = Image.open(store.resolve(p["start_frame"])).convert("RGB")
            if sf.size != (rw, rh):
                ctx.log(f"start_frame {sf.size} cover-fit to region {rw}x{rh}")
                sf = e_img.cover(sf, (rw, rh))
            sf.save(crop_png)
        else:
            e_img.crop_region(plate, snapped, crop_png, snap=None)

        clip, choice = await _i2v(ctx, project, p, crop_png, rw, rh, wd,
                                  p["prompt"])
        crop_rel = store.unique_rel(f"renders/motion/tests/{name}-crop.webm")
        if clip.suffix == ".webm":
            store.copy_in(clip, crop_rel)
        else:
            await asyncio.to_thread(e_ff.transcode, clip, store.resolve(crop_rel))
        record_take(project, p.get("shot"), "crop", crop_rel,
                    backend_id=choice.cfg.id, model=choice.model,
                    prompt=p["prompt"],
                    params={"region": snapped, "frames": p.get("frames"),
                            "seconds": p.get("seconds"),
                            "steps": p.get("steps"), "cfg": p.get("cfg"),
                            "seed": p.get("seed", 42)},
                    sources=[plate_rel], seed=p.get("seed"), job_id=ctx.job_id)

        out_rel = store.unique_rel(f"renders/fx/{name}.mp4")
        full_frame = (l, t, r, b) == (0, 0, pw, ph) and p.get("matte", "window") == "window"
        if full_frame:
            # Whole-plate cel with a window matte composites to the clip itself. Skip the
            # in-memory compositor (it decodes every frame into RAM and OOMs a 1 GB box)
            # and let ffmpeg stream the clip to the plate's size instead.
            ctx.log("full-frame cel: streaming transcode to plate size (no composite)")
            await asyncio.to_thread(
                e_ff.transcode, store.resolve(crop_rel), store.resolve(out_rel),
                ["-vf", f"scale={pw}:{ph}:flags=lanczos", "-r", "24"])
        else:
            await asyncio.to_thread(
                e_cels.composite_single, plate, store.resolve(crop_rel), snapped,
                store.resolve(out_rel), int(p.get("feather", 24)),
                p.get("matte", "window"), None, 24, True, ctx.log)
        record_take(project, p.get("shot"), "motion", out_rel,
                    backend_id=choice.cfg.id, model=choice.model,
                    prompt=p["prompt"],
                    params={"region": snapped, "feather": p.get("feather", 24),
                            "matte": p.get("matte", "window")},
                    sources=[plate_rel, crop_rel], seed=p.get("seed"),
                    job_id=ctx.job_id, meta=choice.take_meta())
        result = {"crop": crop_rel, "composite": out_rel}

        if p.get("freeze_after"):
            live = float(p["freeze_after"])
            ft_rel = store.unique_rel(f"renders/fx/{name}-ft{live}.mp4")
            await asyncio.to_thread(e_motion.freeze_tail,
                                    store.resolve(out_rel),
                                    store.resolve(ft_rel), live, None, 24,
                                    ctx.log)
            record_take(project, p.get("shot"), "motion", ft_rel,
                        prompt=p["prompt"], params={"live": live},
                        sources=[out_rel], job_id=ctx.job_id,
                        meta={"freeze_tail": live})
            result["freeze"] = ft_rel
        return result
    finally:
        _cleanup(wd)


async def gen_chain(ctx, p: dict) -> dict:
    """Breath-stitching: every segment starts from an anime-clean anchor."""
    project = p["project"]
    store = get_storage().project(project)
    name = _slug(p.get("name") or "chain")
    width, height = int(p.get("width", 768)), int(p.get("height", 448))
    beats = p["beats"]
    wd = _workdir(ctx)
    try:
        asm = e_motion.ChainAssembler(width, height, 24, wd / "chain")
        anchor = asm.prepare_anchor(store.resolve(p["plate"]))
        for i, beat in enumerate(beats):
            live = float(beat.get("live", 1.0))
            breath = float(beat.get("breath", 0.4))
            frames = asm.gen_frames_for(live)
            prompt = beat["prompt"] + " " + CHAIN_FREEZE + CHAIN_TAIL
            ctx.log(f"[seg {i}] {frames}f gen, keep {live}s + breath {breath}s")
            seg_p = {**p, "frames": frames, "seed": int(p.get("seed", 42)) + i}
            clip, choice = await _i2v(ctx, project, seg_p, anchor, width,
                                      height, wd, prompt)
            anchor = asm.add_segment(clip, live, breath)
        out_rel = store.unique_rel(f"renders/chains/{name}.mp4")
        info = await asyncio.to_thread(asm.finalize, store.resolve(out_rel))
        # keep the anchors inspectable next to the clip
        anchors_rel = f"renders/chains/{name}.anchors"
        shutil.copytree(info["anchors_dir"], store.resolve(anchors_rel),
                        dirs_exist_ok=True)
        record_take(project, p.get("shot"), "chain", out_rel,
                    backend_id=choice.cfg.id, model=choice.model,
                    prompt="; ".join(b["prompt"] for b in beats),
                    params={"beats": beats, "width": width, "height": height},
                    sources=[p["plate"]], job_id=ctx.job_id,
                    meta=choice.take_meta({"segments": info["segments"]}))
        return {"take": out_rel, **{k: info[k] for k in ("frames", "segments")}}
    finally:
        _cleanup(wd)


async def gen_freeze(ctx, p: dict) -> dict:
    project = p["project"]
    store = get_storage().project(project)
    src_rel = p["source"]
    live = float(p.get("live", 1.0))
    name = _slug(p.get("name") or f"{Path(src_rel).stem}-ft{live}")
    out_rel = store.unique_rel(f"renders/motion/tests/{name}.mp4")
    info = await asyncio.to_thread(
        e_motion.freeze_tail, store.resolve(src_rel), store.resolve(out_rel),
        live, p.get("total"), 24, ctx.log)
    record_take(project, p.get("shot"), "motion", out_rel,
                params={"live": live, "total": p.get("total")},
                sources=[src_rel], job_id=ctx.job_id,
                meta={"freeze_tail": live})
    return {"take": out_rel, **info}


async def gen_trim(ctx, p: dict) -> dict:
    project = p["project"]
    store = get_storage().project(project)
    src_rel = p["source"]
    name = _slug(p.get("name") or f"{Path(src_rel).stem}-trim")
    out_rel = store.unique_rel(f"renders/motion/tests/{name}.mp4")
    info = await asyncio.to_thread(
        e_motion.trim, store.resolve(src_rel), store.resolve(out_rel),
        float(p.get("start", 0.0)), p.get("end"))
    record_take(project, p.get("shot"), "motion", out_rel,
                params={"start": p.get("start", 0), "end": p.get("end")},
                sources=[src_rel], job_id=ctx.job_id)
    return {"take": out_rel, **info}


# ===================================================================== voice

async def gen_vo(ctx, p: dict) -> dict:
    project = p["project"]
    store = get_storage().project(project)
    choice = pick_backend(project, "vo", p.get("backend"))
    adapter = build_adapter(choice.cfg)
    name = _slug(p.get("name") or f"{p.get('shot', 'vo')}_"
                 f"{p.get('role', 'line')}")
    wd = _workdir(ctx)
    try:
        req = GenRequest(
            lane="vo", workdir=wd, prompt=p["text"],
            voice=p.get("voice") or choice.model,
            params={**{k: p[k] for k in
                       ("stability", "style", "similarity", "speed", "seed",
                        "model_id") if p.get(k) is not None},
                    "_project": project},
            log=ctx.log)
        res = await adapter.generate(req)
        f = res.files[0]
        rel = store.unique_rel(f"audio/generated/{name}{f.suffix}")
        store.copy_in(f, rel)
        record_take(project, p.get("shot"), "vo", rel,
                    backend_id=choice.cfg.id, model=req.voice,
                    prompt=p["text"], params=req.params, job_id=ctx.job_id,
                    meta={"chars": res.meta.get("chars")})
        result = {"take": rel}
        if p.get("futz"):
            futz_rel = store.unique_rel(f"audio/generated/{name}-futz.wav")
            await asyncio.to_thread(e_audio.futz_file, store.resolve(rel),
                                    store.resolve(futz_rel))
            record_take(project, p.get("shot"), "vo", futz_rel,
                        sources=[rel], job_id=ctx.job_id,
                        meta={"futz": True})
            result["futz"] = futz_rel
            ctx.log(f"radio futz -> {futz_rel}")
        return result
    finally:
        _cleanup(wd)


async def gen_sfx(ctx, p: dict) -> dict:
    project = p["project"]
    store = get_storage().project(project)
    lane = p.get("lane", "sfx")
    choice = pick_backend(project, lane, p.get("backend"), p.get("model"))
    adapter = build_adapter(choice.cfg)
    name = _slug(p.get("name") or lane)
    text = p.get("text") or p.get("prompt") or ""
    if not text:
        raise RuntimeError(f"{lane} needs `prompt` — describe the sound")
    seconds = p.get("duration", p.get("seconds"))
    # Flat body keys are the agent-facing spelling; params is the escape
    # hatch. Both end up in the adapter's params dict.
    flat = {k: p[k] for k in ("instrumental", "prompt_influence", "influence",
                              "loop") if p.get(k) is not None}
    wd = _workdir(ctx)
    try:
        req = GenRequest(lane=lane, workdir=wd, prompt=text,
                         duration=float(seconds) if seconds else None,
                         model=choice.model,
                         params={**choice.params, **(p.get("params") or {}),
                                 **flat, "_project": project}, log=ctx.log)
        res = await adapter.generate(req)
        f = res.files[0]
        rel = store.unique_rel(f"audio/{lane}/{name}{f.suffix}")
        store.copy_in(f, rel)
        record_take(project, p.get("shot"), lane, rel,
                    backend_id=choice.cfg.id, model=choice.model, prompt=text,
                    job_id=ctx.job_id,
                    params={"seconds": seconds, **flat},
                    meta=choice.take_meta({"lane": lane}))
        return {"take": rel, "lane": lane}
    finally:
        _cleanup(wd)


# ================================================================ comps/panels

def _get_comp(project: str, cid: str) -> Comp:
    with session_scope() as s:
        comp = s.execute(select(Comp).where(
            Comp.project_id == project, Comp.cid == cid)).scalar_one_or_none()
        if not comp:
            raise RuntimeError(f"comp {cid} not found")
        s.expunge(comp)
        return comp


async def comp_render(ctx, p: dict) -> dict:
    project = p["project"]
    store = get_storage().project(project)
    comp = _get_comp(project, p["comp"])
    out_rel = store.unique_rel(f"renders/fx/comp-{comp.cid}.mp4")
    spec = {"background": comp.background, "width": comp.width,
            "height": comp.height, "duration": comp.duration,
            "layers": comp.layers}
    info = await asyncio.to_thread(
        e_cels.render_comp, spec, store.resolve, store.resolve(out_rel), 24,
        True, ctx.log)
    record_take(project, comp.shot_sid, "comp", out_rel,
                params={"comp": comp.cid}, sources=[comp.background] +
                [L.get("clip") for L in comp.layers if L.get("clip")],
                job_id=ctx.job_id, meta={"layers": len(comp.layers)})
    return {"take": out_rel, **{k: info[k] for k in ("frames", "layers")}}


async def comp_layer_reroll(ctx, p: dict) -> dict:
    """Re-generate one layer's cel from the CURRENT background; the plate and
    the other layers are untouched. Auto re-renders the comp."""
    project = p["project"]
    store = get_storage().project(project)
    comp = _get_comp(project, p["comp"])
    layer = next((L for L in comp.layers if L["id"] == p["layer"]), None)
    if not layer:
        raise RuntimeError(f"layer {p['layer']} not in comp {comp.cid}")
    prompt = p.get("prompt") or layer.get("prompt", "")
    if not prompt:
        raise RuntimeError("layer has no prompt and none was given")

    from PIL import Image
    # Separated layers animate from the ORIGINAL plate (the figure is only
    # there); everything else crops the comp's current background.
    src_rel = layer.get("source_plate") or comp.background
    plate = store.resolve(src_rel)
    wd = _workdir(ctx)
    from ..engine import ffmpeg as e_ff
    if e_ff.is_video(plate):
        # a CLIP background: the cel is guided by its first frame, and the
        # region is measured against the clip's own pixels
        first = wd / "bg-frame0.png"
        await asyncio.to_thread(e_ff.extract_frame, plate, 0.0, first)
        plate = first
    with Image.open(plate) as im:
        pw, ph = im.size
    snapped = e_img.snap_region(layer["region"], pw, ph)
    l, t, r, b = snapped
    try:
        crop_png = wd / "crop.png"
        e_img.crop_region(plate, snapped, crop_png, snap=None)
        sub = {**p, "frames": p.get("frames", layer.get("frames", 97)),
               "steps": p.get("steps", layer.get("steps")),
               "cfg": p.get("cfg", layer.get("cfg")),
               "seed": p.get("seed", int(time.time()) % 100000)}
        clip, choice = await _i2v(ctx, project, sub, crop_png,
                                  r - l, b - t, wd, prompt)
        gen_id = f"comp-{comp.cid}-{p['layer']}-r{int(time.time()) % 100000}"
        crop_rel = store.unique_rel(f"renders/motion/tests/{gen_id}-crop.webm")
        if clip.suffix == ".webm":
            store.copy_in(clip, crop_rel)
        else:
            await asyncio.to_thread(e_ff.transcode, clip,
                                    store.resolve(crop_rel))
        record_take(project, comp.shot_sid, "crop", crop_rel,
                    backend_id=choice.cfg.id, prompt=prompt,
                    params={"region": snapped}, sources=[src_rel],
                    job_id=ctx.job_id)
        with session_scope() as s:
            row = s.execute(select(Comp).where(
                Comp.project_id == project,
                Comp.cid == comp.cid)).scalar_one()
            layers = [dict(L) for L in row.layers]
            for L in layers:
                if L["id"] == p["layer"]:
                    # every cel this layer has ever had stays toggleable
                    variants = list(L.get("variants") or [])

                    def _add(clip, pr):
                        if clip and not any(v.get("clip") == clip
                                            for v in variants):
                            variants.append({"clip": clip, "prompt": pr})
                    _add(L.get("clip"), L.get("prompt"))
                    _add(crop_rel, prompt)
                    L["variants"] = variants
                    L["clip"] = crop_rel
                    L["region"] = snapped
                    if p.get("prompt"):
                        L["prompt"] = p["prompt"]
            row.layers = layers
        ctx.log(f"layer {p['layer']} -> {crop_rel}")
        render = await comp_render(ctx, {"project": project,
                                         "comp": comp.cid})
        return {"crop": crop_rel, **render}
    finally:
        _cleanup(wd)


async def comp_bg_reroll(ctx, p: dict) -> dict:
    """Two intents, two lanes (every layer persists either way):
    mode=edit   → i2i lane: keep THIS plate, guide with a prompt (low denoise
                  preserves the staged geometry; instruction-edit models fit
                  here — set the project's i2i lane accordingly)
    mode=regen  → still lane: a brand-new plate from scratch (t2i)."""
    project = p["project"]
    store = get_storage().project(project)
    comp = _get_comp(project, p["comp"])
    mode = p.get("mode", "edit")
    denoise = float(p.get("denoise", 0.55))
    seed = int(p.get("seed", int(time.time()) % 100000))
    lane = "still" if mode == "regen" else "i2i"
    choice = pick_backend(project, lane, p.get("backend"), p.get("model"))
    adapter = build_adapter(choice.cfg)
    wd = _workdir(ctx)
    try:
        from PIL import Image
        with Image.open(store.resolve(comp.background)) as im:
            bw, bh = im.size
        req = GenRequest(lane=lane, workdir=wd, prompt=p.get("prompt", ""),
                         source=None if mode == "regen"
                         else store.resolve(comp.background),
                         width=bw, height=bh, seed=seed,
                         denoise=denoise, model=choice.model,
                         params={**choice.params, "_project": project},
                         log=ctx.log)
        ctx.log(f"bg {mode} via lane '{lane}' ({choice.cfg.id})")
        res = await adapter.generate(req)
        f = res.files[0]
        subdir = "renders/stills" if mode == "regen" else "renders/i2i"
        rel = store.unique_rel(f"{subdir}/compbg_{comp.cid}_s{seed}{f.suffix}")
        store.copy_in(f, rel)
        record_take(project, comp.shot_sid,
                    "still" if mode == "regen" else "i2i", rel,
                    backend_id=choice.cfg.id, prompt=p.get("prompt", ""),
                    params={"denoise": denoise} if mode == "edit"
                    else {"mode": "regen"},
                    sources=[] if mode == "regen" else [comp.background],
                    seed=seed, job_id=ctx.job_id, meta=choice.take_meta())
        with session_scope() as s:
            row = s.execute(select(Comp).where(
                Comp.project_id == project,
                Comp.cid == comp.cid)).scalar_one()
            row.background_history = list(row.background_history or []) + \
                [row.background]
            row.background = rel
        render = await comp_render(ctx, {"project": project, "comp": comp.cid})
        return {"background": rel, **render}
    finally:
        _cleanup(wd)


async def panel_render(ctx, p: dict) -> dict:
    project = p["project"]
    store = get_storage().project(project)
    name = _slug(p.get("name") or f"panels-{p.get('shot', 'shot')}")
    spec = p["spec"]
    spec_rel = store.unique_rel(f"renders/fx/specs/{name}.json")
    import json as _json
    store.write_bytes(spec_rel, _json.dumps(spec, indent=1).encode())
    out_rel = store.unique_rel(f"renders/fx/{name}.mp4")
    info = await asyncio.to_thread(
        e_panels.render_panel_script, spec, store.resolve(out_rel),
        [store.root, store.resolve("renders/stills"),
         store.resolve("renders/motion"), store.resolve("uploads")],
        True, ctx.log)
    record_take(project, p.get("shot"), "panel", out_rel,
                params={"spec": spec_rel}, job_id=ctx.job_id,
                meta={"cues": info["cues"]})
    return {"take": out_rel, "spec": spec_rel, "cues": info["cues"]}


# ==================================================================== animatic

async def animatic_assemble(ctx, p: dict) -> dict:
    project = p["project"]
    store = get_storage().project(project)
    scope = p.get("scope", "full")
    res = str(p.get("res", "720"))
    dims = (1920, 1080) if res == "1080" else (1280, 720)

    with session_scope() as s:
        shots = film.shots_ordered(s, project)
        takes = film.takes_by_shot(s, project)
        entries = []
        for shot in shots:
            if scope.startswith("act") and str(shot.act) != scope[3:]:
                continue
            ov = shot.override or {}
            src = film.active_source(store, shot, takes.get(shot.sid, []))
            vo = []
            if not ov.get("mute_vo"):
                vo_files = ([ov["vo_file"]] if ov.get("vo_file") else
                            film.vo_paths(store, shot.sid, shot.beat,
                                          takes.get(shot.sid, [])))
                for vf in vo_files[:1]:      # one line per shot in v1
                    if store.exists(vf):
                        vo.append(e_asm.VOItem(path=store.resolve(vf),
                                               offset=float(ov.get("vo_offset", 0))))
            entries.append(e_asm.TimelineShot(
                sid=shot.sid,
                seconds=float(ov.get("seconds", shot.seconds)),
                source=store.resolve(src) if src else None,
                vo=vo))
    if not entries:
        raise RuntimeError(f"no shots in scope {scope}")

    # Cue sheet: the job payload wins when it names one, otherwise the
    # project's own music_cues / sfx_cues (what the Cues API and the importer
    # write) are mixed into the cut.
    raw_cues = p.get("cues")
    if raw_cues is None:
        sheet = c_cues.read_all(project)
        raw_cues = [{**c, "kind": kind}
                    for kind in c_cues.KINDS for c in sheet[kind]]
    cues = []
    for c in (raw_cues or []):
        rel = c_cues.cue_path(c)
        if not rel or not store.exists(rel):
            if rel:
                ctx.log(f"[warn] cue file missing, skipped: {rel}")
            continue
        kind = c.get("kind") or ("music" if "/music/" in rel else "sfx")
        cues.append(e_asm.AudioCue(
            path=store.resolve(rel),
            start=float(c.get("start") or 0.0),
            gain_db=float(c["gain_db"]) if c.get("gain_db") is not None
            else c_cues.cue_gain_db(c, kind),
            duration=c_cues.cue_duration(c),
            shot=c_cues.cue_anchor(c) if c.get("start") is None else None,
            offset=float(c.get("offset") or 0.0),
            fade_in=float(c.get("fade_in") or 0.0),
            fade_out=float(c.get("fade_out") or 0.0),
            loop=bool(c.get("loop"))))
    out_rel = store.unique_rel(f"assembly/animatic-{scope}-{res}p.mp4")
    info = await asyncio.to_thread(
        e_asm.build_animatic, entries, store.resolve(out_rel), dims, 24, 0.3,
        cues, 0.4, ctx.log)
    # The EDL rides along in the take's meta: it is what the screening room's
    # chapter strip is built from, and recomputing it later from the film would
    # miss the audio-fit stretch this pass applied. Sources are stored
    # project-relative, the way every other path in the API is.
    edl_meta = []
    for e in info["edl"]:
        src = e.get("source")
        try:
            rel = store.rel(Path(src)) if src else None
        except Exception:
            rel = None
        edl_meta.append({"sid": e["sid"], "start": e["start"],
                         "seconds": e["seconds"], "source": rel})
    record_take(project, None, "animatic", out_rel,
                params={"scope": scope, "res": res}, job_id=ctx.job_id,
                meta={"total": info["total"], "shots": info["shots"],
                      "edl": edl_meta})
    return {"take": out_rel, "cues": len(cues),
            **{k: info[k] for k in
               ("total", "shots", "audio_items", "edl")}}


# ===================================================================== import

async def project_import(ctx, p: dict) -> dict:
    from ..importer.folder import import_folder
    return await asyncio.to_thread(import_folder, p["src_root"], p["project"],
                                   p.get("label"), ctx.log,
                                   p.get("copy_media", True))


async def thumbs_warm(ctx, p: dict) -> dict:
    """Pre-generate the 320px thumbnails for every take so first paint of the
    storyboard doesn't race 97 cold ffmpeg spawns."""
    from ..engine import ffmpeg as e_ff
    project = p["project"]
    store = get_storage().project(project)
    with session_scope() as s:
        paths = [t.path for t in s.execute(
            select(Take).where(Take.project_id == project)).scalars()]

    def warm() -> int:
        n = 0
        for rel in paths:
            if rel.endswith(".json") or not store.exists(rel):
                continue
            key = re.sub(r"[^A-Za-z0-9]", "_", rel) + "_0.3_320.jpg"
            out = store.resolve(f".cache/thumbs/{key}")
            if out.exists():
                continue
            try:
                e_ff.make_thumb(store.resolve(rel), out, 0.3, 320)
                n += 1
            except Exception:
                pass
        return n
    n = await asyncio.to_thread(warm)
    ctx.log(f"warmed {n} thumbnails ({len(paths)} takes)")
    return {"warmed": n}


async def timeline_render(ctx, p: dict) -> dict:
    """Render the compiled clip-model timeline through the lifted FreeCut engine
    (frame-accurate WebCodecs), optionally scoped to the first `scope_sec`
    seconds. Produces an mp4 Take."""
    from ..timeline.compile import compile_film, to_freecut_render_input
    from .. import engine_render
    project = p["project"]
    store = get_storage().project(project)
    container = p.get("container", "mp4")
    scope_sec = p.get("scope_sec")
    with session_scope() as s:
        tl = compile_film(store, s, project)
    inp = to_freecut_render_input(tl, container=container)
    ctx.log(f"compiled timeline: {len(tl.clips)} clips, {tl.duration_seconds()}s")
    out_rel = store.unique_rel(f"assembly/timeline-{('%ds' % scope_sec) if scope_sec else 'full'}.{container}")
    info = await asyncio.to_thread(
        engine_render.render_timeline_input, store.root, inp,
        store.resolve(out_rel), scope_sec=scope_sec, log=ctx.log)
    summary = info.get("summary") or {}
    record_take(project, None, "animatic", out_rel, job_id=ctx.job_id,
                params={"engine": "freecut", "scope_sec": scope_sec,
                        "container": container},
                meta={"engine": True, "total": summary.get("durationSeconds"),
                      "items": info.get("items")})
    return {"take": out_rel, "duration": summary.get("durationSeconds"),
            "items": info.get("items")}


async def gen_separate(ctx, p: dict) -> dict:
    """Pull a figure off the plate into its own animatable layer.

    The anime-studio budget move as one job: SAM masks the clicked figure,
    LaMa synthesizes the clean plate behind it, and a comp is staged with
    the figure as a figure-matted layer whose cel source is the ORIGINAL
    plate (so animating it animates the character in situ, while the comp's
    background is the character-less clean plate — no ghost where they
    stood)."""
    from PIL import Image

    from ..engine import inpaint as e_inpaint
    from ..engine import matte as e_matte

    project = p["project"]
    store = get_storage().project(project)
    plate_rel = p["plate"]
    plate = store.resolve(plate_rel)
    name = _slug(p.get("name") or f"{p.get('shot', 'sep')}-fig")
    img = Image.open(plate).convert("RGB")
    pw, ph = img.size

    if p.get("mask"):                     # a stored mask rel — reuse verbatim
        from numpy import asarray, float32
        m = Image.open(store.resolve(p["mask"])).convert("L").resize((pw, ph))
        mask = asarray(m, float32) / 255.0
    elif p.get("prompts"):
        mask = await asyncio.to_thread(e_matte.refined_mask, img,
                                       p["prompts"])
    else:
        mask = await asyncio.to_thread(e_matte.anime_mask, img)
    cover = float((mask > 0.5).mean())
    ctx.log(f"figure mask: {cover * 100:.1f}% of plate")
    if cover < 0.001:
        raise RuntimeError("mask is empty — click the figure and retry")

    box = e_matte.bbox(mask, pad=int(p.get("pad", 16)))
    # Hosted i2v endpoints (fal Wan) support only 16:9 / 9:16 / 1:1 — grow
    # the region toward the nearest one now so the cel round-trips at native
    # aspect instead of being squashed at composite time.
    box = e_img.grow_to_aspect(box, pw, ph)
    mask_rel = store.unique_rel(f"renders/mattes/{name}-mask.png")
    store.write_bytes(mask_rel, e_matte.mask_png_bytes(mask))
    cut_rel = store.unique_rel(f"renders/mattes/{name}-cutout.png")
    cut_path = store.resolve(cut_rel)
    cut_path.parent.mkdir(parents=True, exist_ok=True)
    e_matte.cutout_rgba(img, e_matte.feather(mask, 2)).save(cut_path)
    record_take(project, p.get("shot"), "matte", mask_rel,
                params={"prompts": p.get("prompts"), "coverage": cover},
                sources=[plate_rel], job_id=ctx.job_id)
    record_take(project, p.get("shot"), "matte", cut_rel,
                sources=[plate_rel, mask_rel], job_id=ctx.job_id)

    clean, method = await asyncio.to_thread(
        e_inpaint.clean_plate, img, mask, int(p.get("dilate", 12)),
        int(p.get("feather", 4)), ctx.log)
    clean_rel = store.unique_rel(f"renders/plates/{name}-clean.png")
    clean_path = store.resolve(clean_rel)
    clean_path.parent.mkdir(parents=True, exist_ok=True)
    clean.save(clean_path)
    ctx.log(f"clean plate via {method} -> {clean_rel}")
    record_take(project, p.get("shot"), "still", clean_rel,
                params={"clean_plate": True, "method": method,
                        "figure_mask": mask_rel},
                sources=[plate_rel], job_id=ctx.job_id,
                meta={"clean_plate": True})

    # stage the comp: clean plate under, figure layer over
    duration = p.get("duration")
    sid = p.get("shot")
    if not duration and sid:
        with session_scope() as s:
            row = s.execute(select(Shot).where(
                Shot.project_id == project,
                Shot.sid == sid)).scalar_one_or_none()
            if row:
                duration = (row.override or {}).get("seconds", row.seconds)
    cid = f"{_slug(sid or name)}-sep-{int(time.time()) % 100000}"
    layer = {"id": "fig1", "region": list(box), "matte": "figure",
             "feather": int(p.get("feather", 4)),
             "source_plate": plate_rel, "mask": mask_rel,
             "cutout": cut_rel, "prompt": p.get("prompt", ""),
             "media": {"loop": "hold"}, "opacity": 1.0, "z": 1, "clip": None}
    with session_scope() as s:
        s.add(Comp(project_id=project, cid=cid, shot_sid=sid,
                   background=clean_rel, width=pw, height=ph,
                   duration=float(duration or 4.0), layers=[layer]))
    ctx.log(f"comp {cid}: clean plate + figure layer @ {list(box)}")
    return {"comp": cid, "mask": mask_rel, "cutout": cut_rel,
            "clean_plate": clean_rel, "method": method,
            "coverage": round(cover, 4), "region": list(box)}


HANDLERS = {
    "gen.still": gen_still,
    "timeline.render": timeline_render,
    "gen.i2i": gen_i2i,
    "gen.motion": gen_motion,
    "gen.chain": gen_chain,
    "gen.freeze": gen_freeze,
    "gen.trim": gen_trim,
    "gen.vo": gen_vo,
    "gen.sfx": gen_sfx,
    "gen.separate": gen_separate,
    "comp.render": comp_render,
    "comp.layer_reroll": comp_layer_reroll,
    "comp.bg_reroll": comp_bg_reroll,
    "panel.render": panel_render,
    "animatic.assemble": animatic_assemble,
    "project.import": project_import,
    "thumbs.warm": thumbs_warm,
}

# CUTROOM — hosted studio platform architecture

> The refactor of the game7 local pipeline into a hosted, multi-project web application
> with pluggable generation backends. The existing `bin/` + `dashboard/` components stay
> in place and untouched; `platform/` is the product.

## 1. What exists today (the extraction source)

The game7 pipeline is a single-machine production system:

| Concern | Today | Coupling |
|---|---|---|
| Stills (t2i/i2i) | Anima 2B via local ComfyUI :8188, graphs built inline | hard-coded `http://127.0.0.1:8188`, model filenames, `~/.local/share/henchmen/ComfyUI/{input,output}` |
| Motion (i2v) | LTX-Video 2B distilled via ComfyUI, cel-region pipeline (`cel-composite.py`) | same + memory protocol (`memory_pressure -Q`, `mlxctl`, `MOTION_PAUSED` sentinel) |
| Composition | `comp_render.py` (plate + N cel layers), `anime-fx.py` (1.5k lines of 2D FX), panel engine (skill) | pure CPU (PIL/numpy/ffmpeg) but path-bound to repo layout |
| Motion edits | `freeze-tail.py`, `chain-gen.py` (breath-stitching) — the director-cut grammar | ComfyUI + ffmpeg |
| Voice | `eleven.py` (ElevenLabs), local TTS lane | `.env` at a stale relative path; key in henchmen repo |
| Assembly | `assemble-animatic.py` (1.6k lines, PyAV) | runs in the *ComfyUI* venv because that's where PyAV is |
| Direction | dashboard chat → `claude -p --dangerously-skip-permissions` inside the repo | local CLI, local FS |
| UI | FastAPI + 1.3k-line vanilla JS single page, :7787 | file-based state (`dashboard/state/*.json`) |
| Data | `prompts/shots.jsonl` (immutable), `renders/curation.json`, `overrides-<project>.json`, directory scans as asset DB | filenames encode shot IDs + seeds |

The deep design ideas worth keeping (they ARE the product):

1. **The cel model.** A shot's visual = an approved still **plate** (never touched by video
   models) + z-ordered **cel layers**: animated clips playing inside snapped-to-32 regions,
   merged via feathered windows or figure mattes. Layers reroll independently.
2. **The FIRST-SECOND LAW.** LTX's first ~1s is clean anime; drift accumulates. Therefore:
   freeze-tail (burst then held cel), chain-gen (breath-stitching short front-loaded beats),
   and the director grammar built on them.
3. **Registers + prompt glossary** — style consistency as data, not vibes.
4. **Lanes** — still / i2i / motion / vo / fx / assemble, each with a documented contract.
5. **Curation & lineage** — keeper picks with backups; every generated asset records
   engine, prompt, params, sources.
6. **Serial GPU discipline** — queues sized to the hardware, pause sentinels.
7. **Director rulings as doctrine** — true freezes (no Ken Burns), boil banned, etc.

## 2. Product shape

**Cutroom** is a self-hostable web application for directing AI-generated
limited-animation film. One server, N projects, M pluggable generation backends.

```
┌────────────────────────────  cutroom server  ───────────────────────────┐
│  FastAPI (REST + SSE)          SQLite/Postgres          project stores  │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐ ┌──────────────────────────┐ │
│  │ projects │ │ shots/   │ │ jobs queue  │ │ media (per-project dirs, │ │
│  │  + auth  │ │ takes/   │ │ (DB-backed, │ │  storage-abstracted)     │ │
│  │          │ │ comps    │ │  pools)     │ │                          │ │
│  └──────────┘ └──────────┘ └─────────────┘ └──────────────────────────┘ │
│        │            │             │                                     │
│  ┌─────┴────────────┴─────────────┴──────────────────────────────────┐  │
│  │                        adapter layer                              │  │
│  │  comfyui (any URL)  ·  openai-images  ·  openrouter-image         │  │
│  │  fal / replicate    ·  elevenlabs     ·  anthropic director       │  │
│  │  openai-compat chat ·  claude-cli (self-host power mode)          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│        │                                    │                           │
│  in-process workers                  remote workers (VMs/microservices) │
│  (default; pools sized per backend)  claim jobs over HTTP w/ token      │
└──────────────────────────────────────────────────────────────────────────┘
                     │
        ┌────────────┴───────────┐
        │  web SPA (React/Vite)  │  storyboard · shot lab · composer ·
        │                        │  timeline · jobs · director chat · settings
        └────────────────────────┘
```

### The engine is a library, not scripts

`cutroom.engine` — pure Python (PIL + numpy + ffmpeg subprocess), zero server
dependencies, zero absolute paths. Every function takes explicit paths/params and
returns result metadata. Ported from the proven `bin/` code:

- `engine.cels` — region snap-to-32, feathered window alpha, figure matte hooks,
  N-layer comp render (from `comp_render.py` / `anime-fx.py cel_composite`)
- `engine.motion` — `freeze_tail` (true freeze doctrine), `chain_stitch`
  (assembles kept-window + breath holds from segment clips), trim/retime helpers
- `engine.panels` — the Ping Pong/Dezaki panel grammar (from the skill's
  `panel_engine.py`): trapezoid panels, rhythmic entries, video-in-panel,
  speed-line fields, collapse — driven by a JSON spec
- `engine.audio` — radio futz chain (bandpass + saturation + static bed),
  VO placement math
- `engine.assemble` — the animatic assembler re-implemented on ffmpeg:
  timeline (shots × overrides × curation) → V track (still holds are TRUE
  freezes; motion/fx/comp sources; per-shot seconds) + A tracks (VO w/ offset &
  futz, music/sfx cues) → 720p/1080p H.264
- `engine.ffmpeg` / `engine.images` — probe, encode, thumbnails, cover-fit

Doctrine is encoded as defaults: no zoompan anywhere, boil never auto-selected,
stills hold true-still.

### Backends: everything generative is a plug

A **Backend** row = `{id, type, label, base_url, api_key, options, enabled}`.
Adapter types shipped:

| type | lanes served | notes |
|---|---|---|
| `comfyui` | still, i2i, motion | Any ComfyUI URL — localhost, LAN box, cloud VM. Workflow templates parameterized by model/clip/vae names; **model discovery** via `/object_info` feeds the model pickers. Serial pool per backend by default. |
| `openai-images` | still, i2i | any OpenAI-compatible `/images/generations|edits` |
| `openrouter-image` | still, i2i | chat-completions image-output modality |
| `fal` | still, motion | fal.ai queue API (submit → poll → download) |
| `replicate` | still, motion | predictions API, version-pinned models |
| `elevenlabs` | vo, sfx | voices listed live for the picker; v3 audio tags pass through |
| `anthropic` | direction | tool-use agent loop, hosted-safe project tools |
| `openai-chat` | direction (advisory) | LM Studio / mlx / OpenRouter / any compatible |
| `claude-cli` | direction | self-host power mode: `claude -p` in the project workspace |

**Lanes** (`still`, `i2i`, `motion`, `vo`, `direction`) each have per-project
defaults: `{lane → backend_id, model, params}`. The generation console and the
composer read the lane registry to render **model pickers**: pick backend →
adapter lists its models (ComfyUI checkpoints/unets, ElevenLabs voices, free-text
for API models) → per-generation override or save as lane default.

### Jobs: pools instead of one global queue

Jobs are DB rows; pools serialize what must be serial and parallelize what can be:

- `backend:<id>` — GPU backends default concurrency 1 (the 16GB discipline,
  now per-backend instead of global)
- `cpu` — comps, freezes, assembly (concurrency 2)
- `api:<id>` — hosted APIs (concurrency 4)

In-process pool workers run by default (single-binary deploy). **Remote workers**
(the microservice/VM story) run the same package (`python -m cutroom.worker`)
pointed at the server with a worker token; they claim jobs by pool over HTTP,
stream logs back, upload artifacts. A GPU VM runs ComfyUI + a cutroom worker
bound to that backend's pool. Pause = per-project and global flags (the
`MOTION_PAUSED` sentinel, promoted to API).

### Direction: grammar first, LLM second

`POST /projects/{p}/direct` takes a natural-language instruction (+ optional shot
scope) and returns an **EditPlan** — a validated JSON list of ops from the ops
schema (`freeze_tail`, `chain`, `trim`, `set_source`, `set_seconds`, `vo_offset`,
`add_cel_layer`, `reroll_layer`, `reroll_background`, `render_comp`, `assemble`, …).

1. **Deterministic grammar** (ported director-cut skill): "keep the first second",
   "freeze from 1.5s", "hold his pose for the rest of the line", "stitch these with
   a breath between" parse without any LLM — the product works with zero keys.
2. **LLM planner**: if configured, an Anthropic tool-use call (or any OpenAI-compat
   model) maps richer instructions to the same schema. The plan is *previewed* in
   the UI, then applied — each op becomes a job.
3. **Director chat**: streaming agent (SSE). Hosted-safe mode gives Claude
   function tools scoped to the project (inspect shots/takes/comps, run ops,
   generate); self-host mode can run `claude -p` in the workspace like today.

### Data model

```
User/token (optional auth)      Backend (adapter config, global)
Project ── Shot (script row: prompts, register, audio fields, order)
        │     ├─ keeper take + curation note (backed-up history)
        │     └─ override (seconds/source/vo/mute/refs) — timeline edits
        ├─ Take (any generated/imported asset: kind, path, backend, prompt,
        │        params, seed, sources[] — lineage is first-class)
        ├─ Comp (background + cel layers JSON, rendered by engine)
        ├─ Job  (type, pool, payload, status, log, artifacts)
        ├─ ChatMessage / EditPlan
        └─ LaneConfig (lane → backend/model/params defaults)
```

Media lives in per-project directories following the game7 layout convention
(`renders/stills`, `renders/motion`, `renders/fx`, `audio/generated`, `assembly`,
`refs`) under `CUTROOM_DATA/projects/<slug>/` — which makes the **importer**
almost a copy: point it at an existing game7-style repo and it ingests shots.jsonl,
curation, overrides, and scans renders into Take rows.

Storage is behind a `Storage` interface (local FS shipped; S3-compatible is a
documented seam with the same path semantics).

## 3. Repository layout

```
platform/
  docs/            ARCHITECTURE.md · DEPLOYMENT.md · BACKENDS.md
  server/          python project (pyproject: cutroom)
    cutroom/
      config.py    env-driven settings (CUTROOM_DATA, DB URL, auth, …)
      db.py models.py schemas.py
      storage.py   Storage interface + LocalStorage
      engine/      ffmpeg.py images.py cels.py motion.py panels.py audio.py assemble.py
      adapters/    base.py comfyui.py comfy_workflows.py openai_images.py
                   openrouter_image.py fal.py replicate.py elevenlabs.py
                   anthropic_director.py openai_chat.py claude_cli.py registry.py
      director/    ops.py grammar.py planner.py
      jobs/        queue.py handlers.py
      importer/    game7.py
      api/         projects, shots, takes, media, comps, generate, direction,
                   chat, jobs, backends, lanes, timeline, animatic, refs,
                   workers, system
      worker/      __main__.py (remote worker)
      main.py      app factory
    tests/
  web/             Vite + React + TS SPA
  deploy/          Dockerfile · docker-compose.yml · .env.example
  dev.sh           run server+web against this machine's ComfyUI
```

## 4. What is deliberately NOT ported

- `anime-fx.py`'s full 40-effect catalog — the engine ports the load-bearing
  primitives (cel composite, freeze, panels, futz); the rest remain runnable
  in-place via the self-host claude-cli direction mode.
- Kokoro/mlx local TTS lanes — the adapter seam exists (`elevenlabs` shows the
  shape); local TTS is a backend type to add when needed.
- Multi-user RBAC — single-workspace with optional bearer token; User model
  exists for future work.

## 5. Security posture

- API keys stored server-side (DB), never returned in full by the API
  (masked reads), never logged.
- Media endpoints resolve paths through the storage layer with project-root
  jailing (no traversal).
- Hosted direction mode uses function tools only — no arbitrary shell on the
  server. `claude-cli` mode is explicitly a self-host feature.
- Remote workers authenticate with scoped worker tokens.

# Genga Studio — hosted studio platform architecture

> A hosted, multi-project web application for making limited-animation films,
> with pluggable generation backends.

The engine and its package are called `cutroom`; the product is Genga Studio.

## 1. Origins

Genga Studio grew out of a single-machine pipeline for a limited-animation short.
That pipeline is not part of this repository. It was a pile of scripts welded
to one box: a fixed ComfyUI install at a hard-coded address, model filenames
baked in, an assembler that only ran inside the ComfyUI virtualenv, a
directory scan standing in for an asset database, JSON files on disk standing
in for state, and a single-page UI that could only ever serve one film on one
machine.

Genga Studio keeps the ideas and throws away the coupling. Every generator is an
adapter behind a lane contract, every path is project-relative, state is a
database, and the whole thing serves many films to many people over HTTP.

The design ideas worth keeping (they ARE the product):

1. **The cel model.** A shot's visual = an approved still **plate** (never touched by video
   models) + z-ordered **cel layers**: animated clips playing inside snapped-to-32 regions,
   merged via feathered windows or figure mattes. Layers reroll independently. The plate is
   still the only thing *restyle* can touch — that is what keeps a look consistent — but the
   background may itself be a **clip**, so a moving background can carry moving cels without
   the figures boiling. `engine.cels.render_comp` streams both: background and every layer are
   decoded one frame at a time through ffmpeg pipes, composited with numpy and piped into an
   encoder, so peak memory is a handful of frames whatever the clip length. The encoder
   captures ffmpeg's stderr and reports its exit (including "killed by signal", the shape an
   OOM kill takes) rather than surfacing a bare `BrokenPipeError` from the write, because on a
   capped box that error is the only evidence you get.
2. **The live window is a backend property.** How long an image-to-video model holds
   before the style drifts and the frame starts to *boil* (the line work crawling and
   reforming every frame) differs per model: about one second on the local LTX rig,
   three to five on hosted Wan-class models. So it is config, not a constant — every
   motion backend carries a `motion_profile` (clip length, fps, frame counts,
   resolutions, price) and a clip plays in **full** at that length.

   Freeze-tail and chain-stitching are SURGICAL repair tools: when a clip is good for
   its first N seconds and then drifts, keep the good frames and hold or continue from
   them instead of rerolling the whole clip. They are not defaults. The historical
   FIRST-SECOND LAW (2026-07) applied to the local LTX lane only. Holds stay **true
   freezes** — the identical frame repeated, never a slow zoom or a loop.
3. **Registers + prompt glossary** — a *register* is a named bundle of style words
   (lighting, line weight, palette, lens) attached to a shot, so consistency is data
   rather than a phrase someone remembers to retype. See "Style register" below for
   the project-level version, which is the one that actually holds a film together.
4. **Lanes** — still / i2i / motion / vo / fx / assemble. A *lane* is one kind of
   generation with a documented contract, and each lane is pointed at whichever
   backend a project chooses.
5. **Curation & lineage** — keeper picks with backups; every generated asset records
   engine, prompt, params, sources.
6. **Serial GPU discipline** — queues sized to the hardware, pause sentinels.
7. **Director rulings as doctrine** — true freezes (no Ken Burns), boil banned, etc.

## 2. Product shape

**Genga Studio** is a self-hostable web application for directing AI-generated
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
- `engine.audio` — voice treatments (named chains a line is heard through:
  radio, phone, megaphone, hall; none by default), VO placement math
- `engine.assemble` — the animatic assembler re-implemented on ffmpeg:
  timeline (shots × overrides × curation) → V track (still holds are TRUE
  freezes; motion/fx/comp sources; per-shot seconds) + A tracks (VO w/ offset &
  treatment, music/sfx cues) → 720p/1080p H.264
- `engine.ffmpeg` / `engine.images` — probe, encode, thumbnails, cover-fit

Doctrine is encoded as defaults: no zoompan anywhere, boil never auto-selected,
stills hold true-still.

**Hearing a shot.** Those lanes only meet at cut time, so reviewing one shot in
the Shot Editor used to be silent. `GET /api/projects/{pid}/shots/{sid}/audio-plan`
(`api/audio.py`) returns the shot's window and everything that sounds inside it:
the VO at head pad + `vo_offset`, the music cues overlapping the window (a bed
that started three shots ago reports `offset_into_file`), and the SFX anchored to
the shot. Placement is not re-derived — the shot's start and length come from
`compile_film_cached`'s picture clips and cue anchors resolve through
`cues.film_start` against those same starts, so the preview and the cut agree.
Times are shot-relative seconds; gain is decibels. The browser plays it with
`web/src/audio/shotMix.ts` (`ShotMixer`: one Web Audio source per track, dB
converted to linear gain, `GainNode` ramps for fades, loop where flagged),
locked to the monitor's `<video>` and resynced when drift passes 120 ms. A still
take gets a held-frame transport of the shot's length so it can be heard too.

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
pause sentinel, promoted to API).

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

### Style register: the look is data, not prompt discipline

A film has one look, and asking whoever writes the script to remember it does
not work. The hosted demo proved it: an agent that had never seen this pipeline
wrote "hand-painted 2D satire" and "caricature" into a French Revolution script
and got western political cartoon back from the same model that had kept an
earlier film anime-faithful. The words an LLM reaches for when it improvises a
style are not the words the still lane needs.

So the look lives on the project, not in the prompt:

```jsonc
project.settings.style = {
  "name":   "anime-cel",
  "prefix": "Cinematic anime film still, 1990s TV anime cel look: clean ink outlines, …",
  "suffix": "",
  "avoid":  "text, lettering, watermark, photorealistic, western cartoon, caricature, …",
  "refs":   ["anime-01.jpg", "anime-02.jpg", "anime-03.jpg"]
}
```

`cutroom/style.py` owns it. Every still and i2i is composed server-side as
`prefix + shot prompt + suffix`, with the register's style words stripped out
of the middle of the prompt (`hand-painted`, `caricature`, `comic` — subject
words like "text" and "gore" are never stripped, since they mean something
different inside a prompt than in a negative). The shot's own negative merges
with `avoid` and rides along; the composed register is recorded on the Take as
`params.style_applied`, so any frame can be traced back to the look that shaped
it. Three named presets ship (`anime-cel` default, `anime-noir`,
`anime-pastel`) and a custom prefix is always allowed.

`refs` are style-reference frames — three 512 px stills from *Two Claudes*,
shipped as package data under `cutroom/assets/style/` — attached ahead of the
prompt on backends whose adapter takes image input (`accepts_style_refs`),
with the instruction to match line, shading and palette but not content. They
cost about 800 input tokens, under 1% of a still. Turn them off per backend
with `options.style_refs: false` or per project with `refs: []`.

Every new project is seeded with the house register at `POST /projects`, and a
project made before the register existed reads as the default rather than as
"no style". `GET`/`POST /api/projects/{pid}/style` is the whole API, and it is
viewer-allowed on the demo for the same reason casting is: choosing what the
film looks like is creative work, not an admin setting. Measured a/b/c
comparison: `docs/research/style-register/RESULTS.md`.

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

A Shot's audio fields are `narration` (what a voice says over the shot),
`dialogue` (in-scene lines), `sfx` and `ambient`. None of them presumes a
genre: `narration` carried the name `radio` while `cutroom` was extracted from
one film whose narration happened to be a broadcast, and the API still accepts
and returns that spelling for one release. The rename is applied by
`db.migrate_db()`, which runs on every boot: it adds the new column, copies the
old one into it once, and leaves the old column in place so a rollback still
reads. That function is the whole migration story — additive and idempotent,
because `create_all` only ever creates missing *tables*.

Media lives in per-project directories following the **studio folder layout**
(below) under `CUTROOM_DATA/projects/<slug>/` — which makes the **importer**
almost a copy: point it at an existing studio folder and it ingests shots.jsonl,
curation, overrides, and scans renders into Take rows.

### Studio folder layout

A *studio folder* is the plain on-disk shape `cutroom` reads and writes. It is not
a Genga Studio invention: it is what a film looks like when a small team keeps it in a
directory, and it stays readable with `ls` and a text editor.

```
<studio-folder>/
  prompts/
    shots.jsonl         one JSON object per shot, in film order: sid (B10-S2),
                        beat, type, seconds, prompt, dialogue, characters
    characters.jsonl    the cast: id, character ("Name — the role"), prompts
  renders/
    stills/  motion/  fx/    generated media; filenames encode sid + seed
    refs/photo/              reference images attached to shots
    curation.json            which take is the keeper for each shot
  audio/
    generated/               VO, one file per line
    music-cues.jsonl         the music bed, as absolute-time cues
    sfx-cues.jsonl           the SFX bed
    mix-overrides.jsonl      per-cue gain and timing corrections
  assembly/                  assembled animatics
  dashboard/state/
    overrides-<id>.json      per-shot timeline edits (seconds, source, offsets)
    comps-<id>.json          cel comps: a plate plus z-ordered layers
```

Only `prompts/shots.jsonl` is required; everything else is optional and indexed
if present. `server/cutroom/importer/folder.py` reads this layout
(`import_folder`), and `cutroom demo-bundle` packs one into a demo tarball.

Storage is behind a `Storage` interface (local FS shipped; S3-compatible is a
documented seam with the same path semantics).

## 3. Repository layout

```
cutroom/
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
      importer/    folder.py
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
  primitives (cel composite, freeze, panels, voice treatments); the rest remain runnable
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

# Backends — plugging generation into Cutroom

A backend row: `{id, type, label, base_url, api_key, options, enabled}`.
Manage in **Settings → Backends** or `POST /api/backends`. API keys are
stored server-side and never returned (masked reads).

Per-project lane defaults: **`POST /api/projects/<p>/lanes`**
`{lane, backend, model, params}` — the generation console and director ops
resolve `explicit request > lane default > first enabled backend serving the
lane`.

## comfyui  (lanes: still, i2i, motion — kind: gpu, serial by default)

Any ComfyUI server: this machine, a LAN box, a rented GPU VM. Sources are
uploaded (`/upload/image`) and results downloaded (`/view`) — no shared
filesystem needed. Model pickers read `/object_info`.

```jsonc
{
  "id": "local-comfyui", "type": "comfyui",
  "base_url": "http://127.0.0.1:8188",
  "options": {
    "concurrency": 1,          // GPU discipline: serial per backend
    "still": {                 // overrides of the Anima-lane defaults
      "unet": "anima-base-v1.0.safetensors",
      "clip": "qwen_3_06b_base.safetensors",
      "vae": "qwen_image_vae.safetensors",
      "steps": 20, "cfg": 4.0, "sampler": "er_sde", "scheduler": "simple"
    },
    "motion": {                // overrides of the LTX-lane defaults
      "checkpoint": "ltxv-2b-0.9.8-distilled.safetensors",
      "clip": "t5xxl_fp16.safetensors",
      "steps": 8, "cfg": 1.0, "free_after": true
    },
    "remote": false            // true → only remote workers claim its jobs
  }
}
```

Defaults reproduce a recipe verified on a real ComfyUI host; every knob overrides
per backend, per lane-config, and per request. i2v constraints are enforced
(dims %32; frames snapped to 8k+1).

**Scaling out**: register `gpu-vm` with the VM's URL — done (the server
drives it directly). If the VM should *pull* instead, set
`options.remote: true` and run on the VM:

```bash
CUTROOM_DATA=/shared/data cutroom-worker \
    --server https://cutroom.example --token $WORKER_TOKEN \
    --pools backend:gpu-vm
```

(`CUTROOM_DATA` must point at the same project storage — NFS/SMB/S3-mount.)

## elevenlabs  (lanes: vo, sfx, music)

`options: {"model": "eleven_v3", "voice": "<default voice id>"}`.
The vo "model picker" lists your account's voices live. v3 inline tags
(`[whispers]`, `<break time="1.6s"/>`, CAPS) pass through untouched.
Per-line direction: `stability`, `style`, `similarity`, `speed`, `seed` in
request params. `futz: true` on a vo generation chains the radio-futz
(bandpass 300–3400Hz + grit + static bed — the film's audio geography).

### Music & SFX

The same backend serves two more lanes, both through `gen.sfx`:

```bash
POST /api/projects/<p>/generate/music   {"prompt", "seconds", "instrumental"}
POST /api/projects/<p>/generate/sfx     {"shot", "prompt", "seconds",
                                         "prompt_influence"}
```

`music` → `/v1/music` (`music_length_ms`; `instrumental: true` sends
`force_instrumental`, the right default under dialogue; the model's floor is
10 s and its ceiling 5 min, and the adapter clamps to that). `sfx` →
`/v1/sound-generation` (`duration_seconds` 0.5–30, `prompt_influence` 0–1 —
higher follows the words literally, lower is more inventive). Takes land as
kind `music` / `sfx` under `audio/music/` and `audio/sfx/`. Lane defaults
follow the usual precedence (explicit `backend` > project `LaneConfig` >
first enabled backend serving the lane), so `CUTROOM_LANE_MUSIC=elevenlabs`
and `CUTROOM_LANE_SFX=elevenlabs` pin them on a hosted instance.

Note: a **restricted** ElevenLabs key can generate while `/v1/user` 401s, so
the Settings health probe reads "down" on a key that works. Judge the lane by
a generation, not by the health dot.

### Cues — the film's audio bed

Audio only reaches the cut through the **cue sheet**, stored on the project as
`settings.music_cues` / `settings.sfx_cues` (the same two keys the folder
importer writes from `audio/*-cues.jsonl`). The assembler mixes it; the
timeline compiler puts it on the MUSIC / SFX tracks.

```bash
GET  /api/projects/<p>/cues[?scope=act2]   → {music:[…], sfx:[…]}
POST /api/projects/<p>/cues                → the stored cue + its id
POST /api/projects/<p>/cues/<id>/delete
```

A cue record:

```jsonc
{"id": "cue_a1b2c3d4", "kind": "music",       // or "sfx"
 "path": "audio/music/opening.mp3",           // project-relative
 "start": 12.5,                               // absolute film seconds, OR
 "shot": "B10-S2",                            // ride that shot's start
 "offset": 0.3,                               // added to whichever anchor won
 "duration": 20, "gain": -16,                 // GAIN IS DECIBELS
 "fade_in": 0.5, "fade_out": 1.5, "loop": false, "label": "main theme"}
```

**Gain is always dB** — `0` is unity (as loud as the file), negative rides
under the VO. Defaults: music `-16` (a bed), SFX `-8` (an accent). The
importer's free-text `gain-hint` ("-16dB under narration") is parsed for its
number. A shot-anchored cue is resolved against the *finished* EDL, so it
moves with its shot when audio-fit stretches the picture; a cue whose shot is
outside an `actN` cut is skipped with a warning, never a failure. `loop`
requires a `duration` to fill. These endpoints are **not** admin-gated — a
demo viewer (or an agent driving the page for them) can place cues, because
it only writes JSON and costs nothing.

## openai-images / openrouter-image  (lanes: still / still+i2i)

The two adapters the original pipeline had, generalized. `openrouter-image`
supports i2i by attaching the source image (Gemini-image-class models).

## fal / replicate  (lanes: still, motion)

The remote-video seam the original pipeline declared but never implemented.
Generic by design — model id + payload shape live in options:

```jsonc
{ "type": "fal", "options": {
    "model": "fal-ai/ltx-video", "models": ["fal-ai/ltx-video"],
    "prompt_key": "prompt", "image_key": "image_url",
    "extra_payload": {"num_frames": 97} } }
{ "type": "replicate", "options": {
    "model": "owner/model-name",      // or a 64-char version hash
    "image_key": "image", "extra_input": {} } }
```

Results are found by walking the response for media URLs, so most models
need zero code. A fal/replicate motion backend slots straight into the cel
pipeline: crop → hosted i2v → composite back onto the plate locally.

## Motion profiles  (the live window is a backend property)

Every motion-capable backend row carries `options.motion_profile`, and
`GET /api/backends` returns the effective one on each motion row:

```json
{
  "seconds_default": 5.0,        // clip length when nobody says otherwise
  "seconds_max": 5.0,            // longest clip the model will make
  "seconds_options": [5.0],      // discrete durations, where the API has them
  "live_seconds_default": 5.0,   // how long it holds before it drifts (ADVICE)
  "live_seconds_max": 5.0,
  "fps": 16,
  "frames_options": [81],        // frame counts the model accepts
  "resolutions": ["480p", "580p", "720p"],
  "cost_per_clip_usd": 0.05      // or cost_per_second_usd
}
```

`POST /api/projects/{pid}/generate/motion` accepts `seconds` (converted to
frames at the profile's fps and clamped to what the model supports) and, as an
explicit opt-in, `live_seconds` → `freeze_after`. The agent tool
`generate_takes(lane:"animate")` takes the same two arguments and reports the
profile it used; `describe_shot` shows the motion lane's profile.

**Clips play in full.** Freeze-tail and chain-stitching are SURGICAL repair
tools: when a clip is good for its first N seconds and then drifts, keep the
good frames and hold or continue from them instead of rerolling the whole clip.
They are not defaults. The historical FIRST-SECOND LAW (2026-07) applied to the
local LTX lane only — LTX holds about a second, hosted Wan-class models hold
three to five, so the number belongs in config, not in the tools. Holds are
still **true freezes** (no zoom), and boil never auto-plays.

Seeding and overrides:

* `seed_backends()` writes a profile onto every motion-capable row from the
  model table in `cutroom/adapters/motion_profiles.py`.
* `CUTROOM_MOTION_PROFILE_<BACKEND_ID>` (JSON, dashes → underscores) replaces
  a row's profile outright, on new and existing rows.
* An admin editing `options.motion_profile` in Settings sets a *partial*
  override: keys given win, the rest of the model table survives.
* Per-project overrides use the existing `CUTROOM_LANE_MOTION=fal:<model>`
  (for example `CUTROOM_LANE_MOTION=fal:fal-ai/pixverse/v6/image-to-video`),
  which pins the project's motion lane to that backend and model. The global
  default stays `CUTROOM_FAL_MOTION_MODEL`.

### fal endpoints with a payload map

`FAL_PAYLOAD_MAPS` in `cutroom/adapters/queue_apis.py` holds the per-endpoint
request shape, so adding a model is a table row rather than a code change.
Verified against each endpoint's OpenAPI schema on 2026-09-02; prices are what
the model page publishes. See `docs/research/motion-bakeoff/RESULTS.md`.

| endpoint | 5 s price | duration field | anime control |
|---|---|---|---|
| `fal-ai/wan/v2.2-a14b/image-to-video/turbo` (default) | $0.05 @480p, $0.075 @580p, $0.10 @720p | **none** — fixed ~5 s / 81 f | none; the look comes from the plate |
| `fal-ai/bytedance/seedance/v1/pro/fast/image-to-video` | ~$0.108 @720p (token priced) | `duration`, string, 2–12 | `camera_fixed: true` locks the frame |
| `fal-ai/pixverse/v6/image-to-video` | $0.175 @540p ($0.035/s) | `duration`, **integer**, 1–15 | `style: "anime"` |
| `fal-ai/pixverse/v4.5/image-to-video` | $0.15 @540p flat | `duration`, string, "5" or "8" | `style: "anime"` + a named `camera_movement` enum |

Wan turbo also has no `negative_prompt`; the adapter logs and drops one rather
than sending a field the endpoint rejects.

## Direction providers  (lane: direction)

- **anthropic** — hosted-safe agent chat + EditPlan planner.
  `options: {"model": "claude-sonnet-5"}`; key auto-seeded from
  `ANTHROPIC_API_KEY`.
- **openai-chat** — any compatible endpoint (LM Studio `http://127.0.0.1:1234/v1`,
  mlx, OpenRouter). Plans via JSON mode; chat is advisory.
- **claude-cli** — self-host power mode (`CUTROOM_ALLOW_CLAUDE_CLI=1`):
  spawns `claude -p` in the project workspace with the platform API
  documented in its preamble.

## Hosted demo  (`CUTROOM_DEMO=1`)

The public demo runs the same server with real providers, two roles, a
rate limit and a spend cap. Nothing here changes a self-host: with
`CUTROOM_DEMO` unset every request is `admin`, no limit applies, and no
budget is enforced.

### Roles

| token | who | may |
|---|---|---|
| `CUTROOM_ADMIN_TOKEN` | the studio owner | everything |
| `CUTROOM_AUTH_TOKEN` | judges / viewers | everything **creative** |

Both authenticate; which one you present decides your role. `?token=` works
on GETs, so the judge link is one click. Admin-only (403 with a friendly
`detail` otherwise): backend create/edit/delete, lane-default edits, project
create/import, project + server pause, comp delete, and the remote-worker
routes. `GET /api/system` reports `{demo, role, budget:{spent,limit}}`.

Rate limits per token: **60 job submissions/minute**
(`CUTROOM_DEMO_JOBS_PER_MIN`) and **12 paid-backend jobs/hour**
(`CUTROOM_DEMO_PAID_JOBS_PER_HOUR`). Over either → 429 pointing at `mock`.

### Providers wired from the environment

`seed_backends()` creates or updates these at every boot. A key in the env
enables its backend; without one the row stays a disabled template. The
configured model applies either way, so pasting a key into Settings is
enough to go live.

| env key (first non-empty wins) | backend | type | lanes | model env (default) |
|---|---|---|---|---|
| `OPENROUTER_API_KEY` / `OPEN_ROUTER_API_KEY` | `openrouter` | openai-chat | direction | `CUTROOM_OPENROUTER_MODEL` (`z-ai/glm-5.3-flash`) |
| (same key) | `openrouter-image` | openrouter-image | still, i2i | `CUTROOM_OPENROUTER_IMAGE_MODEL` (`google/gemini-2.5-flash-image`) |
| `FAL_KEY` / `FAL_AI_API_KEY` / `FAL_API_KEY` | `fal` | fal | still, motion | `CUTROOM_FAL_MOTION_MODEL` (`fal-ai/wan/v2.2-a14b/image-to-video/turbo`) |
| `ELEVEN_LABS_API_KEY` / `ELEVENLABS_API_KEY` | `elevenlabs` | elevenlabs | vo, sfx, music | `options.model` (`eleven_v3`) |
| `ANTHROPIC_API_KEY` | `anthropic` | anthropic | direction | `options.model` |

Prices at the time of writing: GLM 5.3 Flash **$0.075/M in, $0.25/M out**
(a planning turn is well under a cent); gemini-2.5-flash-image ≈ **$0.04**
per image; Wan 2.2 A14B turbo i2v **$0.05 per clip at 480p** (`$0.075` at
580p, `$0.10` at 720p — the backend seeds `extra_payload.resolution: 480p`).

Per-project lane defaults come from `CUTROOM_LANE_<LANE>=<backend>[:<model>]`
(`still`, `i2i`, `motion`, `vo`, `sfx`, `music`, `direction`), applied to the
demo project at boot. Unset lanes fall through to the first enabled backend,
which on the demo is `mock`. The `direction` lane genuinely routes the
planner and the director chat, model included.

### Spend cap

Each backend carries `options.cost_usd` — dollars per produced take — seeded
from `CUTROOM_COST_<BACKEND_ID>` (dashes → underscores) with defaults: mock
and ComfyUI `0`, `openrouter` `0.001`, `openrouter-image` `0.04`, `fal`
`0.05`, `elevenlabs` `0.02`. Every recorded take charges the rolling 24h
ledger (`$CUTROOM_DATA/spend-ledger.json`). When a paid submission would push
the 24h estimate past `CUTROOM_DEMO_BUDGET_USD` (default `10`), it returns
**402** with a flat `{detail, spent, budget, estimate, backend}`. `mock`
never counts and never trips.

### The demo dataset

```bash
cutroom demo-bundle <path-to-a-studio-folder> /tmp/bundle.tar.zst   # prints the size
```

Packs `prompts/{shots,characters}.jsonl`, `renders/curation.json`, the
`dashboard/state` overrides + comps, the audio cue manifests, and all of
`renders/**` + `audio/**`, excluding `assembly/` and any media file over
25 MB. The real film packs to **278 MB** (941 files, 290 MB raw). Falls back
to `.tar.gz` when `zstd` is not installed.

Attach it to a GitHub Release and point the instance at it:

```bash
CUTROOM_DEMO_BUNDLE=https://…/bundle.tar.zst
CUTROOM_DEMO_BUNDLE_TOKEN=<PAT>      # private repo: sent as Bearer, with
                                     # Accept: application/octet-stream
CUTROOM_DEMO_PROJECT=next-year       # default
```

At boot, if the instance has no projects, it downloads to
`$CUTROOM_DATA/demo-src`, extracts, imports, enables `mock`, applies the
`CUTROOM_LANE_*` defaults and queues `thumbs.warm` — in a background thread,
so the API answers while it works. Idempotent; progress in
`$CUTROOM_DATA/logs/boot.log`. Force it by hand with `cutroom demo-import
--force`.

### Cast index

The importer reads `prompts/characters.jsonl` into
`project.settings.cast = [{id, name, aliases[], descriptor}]`, served by
`GET /api/projects/<p>/cast`. Aliases are the name, its tokens, and the role
phrase after the em dash plus its head noun — so a cast row reading "Ada
Lovelace — the veteran engineer" answers to `ada`, `lovelace`, `ada lovelace`,
`veteran engineer` and `engineer`. Refresh an already-imported project without re-copying media:

```bash
cutroom reimport-cast next-year <path-to-a-studio-folder>
```

# Backends — plugging generation into Genga Studio

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
request params.

**Voice treatments.** `treatment` on a vo generation names what the line is
heard *through*. The clean take is always kept; the treated one is recorded
next to it as a second vo take.

| `treatment` | chain |
|---|---|
| `none` (default) | nothing — the line as recorded |
| `radio` | bandpass 300–3400Hz, speaker resonance, saturation, AGC, wow/flutter, band-matched static bed |
| `phone` | bandpass 400–2800Hz, mid lift, a little grit, no bed |
| `megaphone` | bandpass 500–3800Hz, hard 2.2kHz honk, hard clip |
| `hall` | the dry line plus damped early reflections |

Nothing defaults to a treatment: a platform has no house sound. `futz: true`
was the single-film spelling of `treatment: "radio"` and still works for one
release. The chains live in `cutroom.engine.audio` as plain functions over
numpy; a new one is a new recipe over the primitives already there.

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

**Negatives on chat-completion image models.** Neither endpoint has a negative
field — `/images/generations` has no such parameter, and a Gemini-image model
reached through `chat/completions` has nowhere to put one — so until 2026-09-02
the negative was collected, stored on the Take and then silently dropped: "text,
watermark, photorealistic" never reached the model at all. Both adapters now
fold it into the prompt as a closing `Avoid: …` sentence
(`http_images.fold_avoid`). Adapters that do have a real negative field
(ComfyUI) keep using it. Treat a folded negative as a strong preference rather
than a constraint: Gemini still draws glyph marks on props with `text, lettering`
in the list, so anything that must not appear belongs out of the subject, not
just in the negative.

**Style references.** `openrouter-image` sets `accepts_style_refs = True`, so
the project's style register can attach reference frames ahead of the prompt as
`image_url` content parts. Turn it off with `options.style_refs: false`.
`openai-images` cannot: `/images/generations` takes no image input.

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
  (for example `CUTROOM_LANE_MOTION=fal:seedance` — a registry key or a full
  endpoint id both work), which pins the project's motion lane to that backend
  and model. The global default stays `CUTROOM_FAL_MOTION_MODEL`.

## Motion models  (the registry an agent picks from)

A `motion_profile` says how long a clip is and what it costs. The **motion
model registry** (`cutroom/adapters/motion_models.py`, served at
`GET /api/motion-models` and merged into the fal row's `motion_profile` on
`GET /api/backends`) answers the question above it: *which model should this
shot use*. Two models are seeded, both proven on the plates in
[`research/motion-bakeoff/RESULTS.md`](research/motion-bakeoff/RESULTS.md).

| rank | key | endpoint | 5 s price | seconds | good at | fails by | fallback |
|---|---|---|---|---|---|---|---|
| 1 | `seedance` | `fal-ai/bytedance/seedance/v1/pro/fast/image-to-video` | ~$0.108 @720p ($0.0216/s) | `duration`, string, 2–12 | legible text, effects bursts, wide tableaux. `camera_fixed` holds screen text for a full 5 s | may replace dark close-ups with a brighter room; grade drifts warm on wides | `wan` |
| 2 | `wan` | `fal-ai/wan/v2.2-a14b/image-to-video/turbo` | $0.05 @480p ($0.075 @580p, $0.10 @720p) | **none** — fixed ~5 s / 81 f | dark close-ups, wide tableaux. Never invents a camera move; cheapest and fastest | small motion amplitude; drops fine text after ~2 s | `seedance` |

**Seedance when the budget allows, Wan when it is thin** — and Wan for a dark
close-up either way, because that is the register it was measured to win.
`plan_motion` makes that choice per shot as the budget drains and reports the
model with a one-line reason; `apply_motion_plan` passes it through;
`generate_takes` accepts `model: "seedance" | "wan"` as well as a full endpoint
id. The `payload_map` on each record is what the adapter sends: seedance takes
`duration` as a string and locks the frame with `camera_fixed`, Wan turbo has
no duration field and rejects a `negative_prompt` (the adapter logs and drops
one rather than sending a field the endpoint refuses).

**The demo's motion lane stays `wan`.** It is the cheap floor: a judge who
never opens the planner still gets a five-cent clip from the model with the
best plate fidelity. `DEFAULT_MODEL_KEY` in the registry, and
`CUTROOM_FAL_MOTION_MODEL` on the deployment, both say so.

**If a clip is unfaithful to the plate, switch models and rerun.** Faithfulness
is a model property, not a prompt problem — a plate that got replaced is not a
sentence that was worded badly. Every record carries `failure_modes` and a
`fallback`, and `generate_takes`, `apply_motion_plan`, `reroll_layer` and
`describe_shot` all return a `next_if_unfaithful` line naming the model to
rerun on. Narrow the registry with `CUTROOM_MOTION_MODELS=wan`.

PixVerse v4.5 and v6 were measured in the same bake-off and **rejected** —
v4.5's `style: "anime"` overrode the plate outright, v6 invented camera moves
and broke a shot's stated rule. They are deliberately absent from the code;
the evidence stays in RESULTS.md.

## Image models  (the registry the still lane picks from)

The same idea one lane down. A director asked for two monitors showing the word
GOODBYE in perfectly legible letters and the agent used the default model,
because nothing told it that legibility is a place these models differ. The
**image model registry** (`cutroom/adapters/image_models.py`, served at
`GET /api/image-models`, listed on the `openrouter-image` row of
`GET /api/backends`, and offered as the choices in
`GET /api/backends/openrouter-image/models?lane=still`) is what tells it.
Prices are **measured**, from OpenRouter's own `usage.cost`, in
[`research/image-models/RESULTS.md`](research/image-models/RESULTS.md).

| rank | key | model id | $/still | latency | good at | fails by | fallback |
|---|---|---|---|---|---|---|---|
| 1 | `flash` | `google/gemini-2.5-flash-image` | **$0.0387** | 7–12 s | the cheap default; one short word on a screen comes out legible | drops a letter once the frame carries several strings ("SYSTEM OFLINE", measured); drifts photoreal on text-heavy plates | `pro` |
| 2 | `pro` | `google/gemini-3-pro-image` | **$0.1387** | 41–65 s | `legible_text`, `typography`, `complex_composition`. The only model that got both text plates perfect, in the cleanest anime register | bakes its own letterbox bars into the 16:9 canvas; 3.6× the price and takes a minute | `flash3` |
| 3 | `flash3` | `google/gemini-3.1-flash-image` | **$0.0672** | 12–14 s | `typography`, `complex_composition`. Spells like `pro` on distinct strings at half the price | a repeated line ghosts into the one below it; invents people the prompt never mentioned | `pro` |

**`flash` by default, `pro` when the letters have to be readable.** That
sentence is carried by `generate_takes`, `describe_shot`, `list_backends` and
both director system prompts, so an agent that has never read this file still
knows to pass `model: "pro"` for a sign, a screen or a title. When a still
prompt contains text words and the cheap model drew it anyway, the tool result
comes back with `hint: "This shot asks for readable text: consider
model:\"pro\" (≈$0.14 per still)."`

`generate_takes` and `POST /generate/still|i2i` accept a registry key
(`"pro"`) or a full OpenRouter id; anything the registry does not know passes
through, so an operator can still name a model nobody has measured. Narrow the
list with `CUTROOM_IMAGE_MODELS=flash,pro`.

**A still records what it actually cost.** The adapter sends
`usage: {include: true}`, so OpenRouter's own billed number lands on the Take
as `params.cost_usd` (the registry's measured price is the fallback), the 24h
ledger charges that number, and `/api/projects/{pid}/spend` prices each take at
what ran rather than one flat figure per backend, which matters the moment a
$0.139 `pro` still sits next to a $0.039 `flash` one on the same backend.

`google/gemini-3.1-flash-lite-image`, `openai/gpt-5-image` and
`openai/gpt-5-image-mini` were measured and **rejected**: lite and the mini
ignore the anime register (and the mini ignored the 16:9 request outright), and
`gpt-5-image` refused the plate on policy ("I can't create images that include
extensive on-screen text") and billed $0.021 for the refusal. They are
deliberately absent from the code; the evidence stays in RESULTS.md.

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

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

Defaults reproduce the verified game7 recipes exactly; every knob overrides
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

## openai-images / openrouter-image  (lanes: still / still+i2i)

The two adapters the old dashboard had, generalized. `openrouter-image`
supports i2i by attaching the source image (Gemini-image-class models).

## fal / replicate  (lanes: still, motion)

The remote-video seam the old dashboard declared but never implemented.
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

## Direction providers  (lane: direction)

- **anthropic** — hosted-safe agent chat + EditPlan planner.
  `options: {"model": "claude-sonnet-5"}`; key auto-seeded from
  `ANTHROPIC_API_KEY`.
- **openai-chat** — any compatible endpoint (LM Studio `http://127.0.0.1:1234/v1`,
  mlx, OpenRouter). Plans via JSON mode; chat is advisory.
- **claude-cli** — self-host power mode (`CUTROOM_ALLOW_CLAUDE_CLI=1`):
  spawns `claude -p` in the project workspace with the platform API
  documented in its preamble.

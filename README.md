# CUTROOM

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/ryan-the-brodsky/cutroom/actions/workflows/ci.yml/badge.svg)](https://github.com/ryan-the-brodsky/cutroom/actions/workflows/ci.yml)
[![WebMCP](https://img.shields.io/badge/WebMCP-document.modelContext-8a63d2)](docs/WEBMCP-PLAN.md)

> **Live demo:** _(hosted URL — pending first deploy)_ ·
> **Third-party code:** [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) ·
> **Prior work vs. new work:** [`docs/PRIOR-WORK.md`](docs/PRIOR-WORK.md)

The game7 pipeline, refactored into a hosted web application: one server,
N film projects, M pluggable generation backends. The original `bin/` +
`dashboard/` components remain untouched in the repo root; this directory is
the product.

```
platform/
  server/    FastAPI app + engine library + adapters + job queue  (python)
  web/       React/Vite SPA                                       (typescript)
  deploy/    Dockerfile · docker-compose · env template
  docs/      ARCHITECTURE.md · BACKENDS.md · DEPLOYMENT.md
  dev.sh     run on this machine
```

## Quick start (this machine)

```bash
cd platform
./dev.sh build       # build the SPA into the server (one-time / on UI change)
./dev.sh server      # http://127.0.0.1:8770
```

Then in the UI: **Projects → Import** with
`/Users/ryan-the-brodsky/Documents/programming/game7` — shots, keepers,
overrides, comps, and 500+ takes come in with their lineage. Start ComfyUI
(`~/.local/share/henchmen/ComfyUI`) and the `local-comfyui` backend serves
the still/i2i/motion lanes exactly like the old lanes (same graphs, same
recipes — but over HTTP upload/download, so a remote ComfyUI works too).

Dev mode with hot reload: `./dev.sh` (API :8770 + vite :5173).

## What it does

- **Storyboard / shot lab** — takes galleries, keeper curation (with
  history), reference attach, per-shot generation console with **model
  pickers**: every lane (still · img2img · motion · voice) is served by a
  configurable backend; ComfyUI backends list their installed checkpoints
  live, ElevenLabs lists your voices.
- **The cel system** — comps = an untouched background plate + z-ordered
  animated cel layers. Draw a region on the plate, give the cel a motion
  prompt; layers reroll independently; the background restyles under
  persistent layers (low denoise keeps staged geometry). Deterministic
  re-render from the data model.
- **Motion edits under the FIRST-SECOND LAW** — freeze-tail (true freezes,
  zooms banned platform-wide), breath-stitching chains, trims.
- **Natural-language direction** — instructions compile to previewable
  **EditPlans** (a validated ops vocabulary). The deterministic grammar
  handles the documented edit language with zero API keys ("keep the first
  second", "hold his pose for the rest of the line" — it probes the real VO
  duration); an Anthropic/OpenAI-compatible planner handles the rest.
  Director chat gives Claude hosted-safe *function tools* (inspect the film,
  run plans) — no shell in hosted mode; `claude-cli` power mode exists for
  self-hosts (`CUTROOM_ALLOW_CLAUDE_CLI=1`).
- **Panel screens** — the Ping Pong/Dezaki grammar as a render job
  (spec JSON → mp4 + SFX cue sidecar).
- **Cut the film** — the assembler builds the animatic from current state
  (keepers + overrides + takes): true still holds, last-frame freezes for
  short clips, VO placed with audio-fit + head pad, slate for missing shots.
- **Jobs** — DB-backed queue; GPU backends run strictly serial per backend
  (the 16GB discipline, generalized); CPU work runs parallel. Remote workers
  on GPU VMs claim jobs over HTTP (`cutroom-worker`).

## Drive Cutroom with an agent (WebMCP)

Cutroom has about a hundred distinct actions across two rooms, five tabs and
four generation consoles. Finding any of them means clicking. WebMCP lets the
page hand an agent the whole list instead.

One **action registry** (`web/src/agent/registry.ts`) is the single source of
truth for every feature: its name, its JSON Schema, where it lives in the UI,
how a human performs it by hand, and how to run it. Three surfaces come off
that one list. WebMCP tools, published on `document.modelContext`. A ⌘K
command palette for humans. And a "show me" behaviour that navigates to a
feature and rings its control.

Tools execute **through the UI you are looking at**. `generate_takes` opens
the Film Editor, walks into the shot, switches to the Generate tab, fills the
prompt, and presses submit. You learn the app by watching the agent drive it.
Reads are the only silent calls, an Agent trail drawer logs every step, and
paid backends refuse to spend without an explicit `confirm_cost`.

Open the app in ChatGPT Desktop's browser (Settings › Browser › Enable site
tools) or Chrome 149+ with `chrome://flags/#enable-webmcp-testing` on, then
ask:

> "Make a few more generative cuts of the David Ross close-up."
> "Keep the first second of the newest one and freeze the rest."
> "Cut act 1."

Architecture and tool catalogue: [`docs/WEBMCP-PLAN.md`](docs/WEBMCP-PLAN.md).
Test evidence and the cross-client checklist:
[`docs/TESTING-WEBMCP.md`](docs/TESTING-WEBMCP.md).

## Verification status

- 36 pytest tests green (engine on synthetic media, API surface, direction
  grammar, fake-ComfyUI adapter, queue + remote-worker protocol).
- End-to-end on the real film: imported 97 shots/567 takes/7 comps; compiled
  and applied director grammar on the real dial shot; freeze-tail and comp
  re-render produced verified frames; **act 1 assembled to a 194s 720p
  animatic with 24 VO items**.

See `docs/ARCHITECTURE.md` for the design, `docs/BACKENDS.md` for adapter
configuration, `docs/DEPLOYMENT.md` for hosting.

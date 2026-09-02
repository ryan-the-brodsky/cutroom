# Prior work vs. new work

> **Status: skeleton.** Workstream D wrote the prior-work half; **workstream F
> completes the "New for the WebMCP Challenge" section** with the final file
> list, commit hashes and line counts once the WebMCP layer lands.

Devpost's rules require pre-existing projects to "provide clear documentation
distinguishing prior work from new work, including evidence that it was
meaningfully extended with WebMCP within the Submission Period." This file is
that documentation.

---

## The line

| | |
|---|---|
| **Everything before** | commit [`cebcf93`](https://github.com/ryan-the-brodsky/cutroom/commit/cebcf93) — *"Cutroom — prior-work snapshot (built 2026-07-12..15, pre-WebMCP)"* |
| **Everything after** | commit `b7d04e0` onward — the WebMCP layer, built 2026-09-01 → 2026-09-03 |

`cebcf93` is 147 files / 21,827 lines and contains **no WebMCP code of any
kind**. Everything the challenge should be judged on is in the commits that
follow it.

### A note on commit dates

This repository was `git init`-ed on 2026-09-01, when Cutroom was split out of
the private parent repository into its own public repo. So
`cebcf93`'s *commit* timestamp is 2026-09-01 even though the *work* is from
July. The independent evidence that the snapshot predates the submission period:

- **File modification times** inside the snapshot, all July: `server/cutroom/`
  and `web/src/` 2026-07-12 → 2026-07-22; `server/tests/` 2026-07-12 → 07-22;
  `deploy/` 2026-07-12.
- **Dated documents committed in the snapshot itself**:
  `docs/FOUNDATION.md` records the FreeCut audit and its go/no-go spike run
  *"2026-07-14, run first-hand"*; `docs/PLAN.md` and `docs/ARCHITECTURE.md`
  carry the same July authorship.
- The snapshot's own verification log (README "Verification status"): 36 pytest
  tests, 97 shots / 567 takes / 7 comps imported, act 1 assembled to a 194 s
  animatic — all done in July.
- **The parent repository.** Cutroom was extracted from a private parent
  repository, where it lived as a subdirectory. The private parent repository
  (commit `b05a754`) holds the film pipeline this was built out of.

**Why the history is short.** This repo was `git init`-ed on 2026-09-01 and its
history was rewritten once that same day, to remove a test fixture that carried
the film's private script. So there is no July commit history to show here, and
`cebcf93`'s commit date is 2026-09-01 while the code inside it was written
2026-07-12..15. The dated session logs committed *inside* that snapshot
(`docs/PLAN.md` and `docs/UX-NOTES.md`, both written as the work happened) are
the contemporaneous record, and the parent repo holds the original history.

---

## Prior work — what `cebcf93` already contained (built 2026-07-12..15)

Cutroom was already a complete, working, tested application before the
hackathon. Top-level areas, all pre-existing:

- **`server/cutroom/` (58 files)** — the FastAPI application and engine library:
  - `api/` — projects, media, generate, comps, direction, jobs, backends,
    system, timeline, separate routers
  - `adapters/` — pluggable generation backends (ComfyUI, ElevenLabs, fal,
    replicate, OpenAI/OpenRouter images, mock) behind one registry
  - `engine/` — cels/comps compositing, ffmpeg wrapper, freezes and motion
    edits, inpaint, matte, images, audio, the panel engine, the assembler
  - `director/` — the deterministic edit grammar, the ops vocabulary,
    EditPlan compile/apply, and the LLM planner + providers
  - `jobs/` — the DB-backed queue with GPU-serial / CPU-parallel pools and the
    remote-worker claim protocol
  - `timeline/` — the timeline model, compiler, edit verbs and interchange
  - `importer/folder.py`, `models.py`, `storage.py`, `config.py`, `film.py`
- **`web/src/` (55 files)** — the React/Vite SPA: Projects, Film Editor, Shot,
  Composer, Timeline, Jobs, Chat and Settings pages; the comp editor, region
  canvas, model pickers, plan preview; `runtime/player/` (the lifted FreeCut
  player — see `THIRD_PARTY_NOTICES.md`); `timeline/` model and edit verbs.
- **`server/tests/` (12 files)** — the 36-test pytest suite.
- **`deploy/`** — Dockerfile, docker-compose, env template.
- **`docs/`** — ARCHITECTURE, BACKENDS, DEPLOYMENT, FOUNDATION, PLAN, UX-NOTES.

None of this was written for the challenge, and none of it is being claimed as
challenge work.

---

## New for the WebMCP Challenge (2026-09-01 → 2026-09-03)

Commit range **`cebcf93..HEAD`**, first WebMCP commit **`b7d04e0`** (the frozen
contract). 46 commits, `112 files changed, 18384 insertions(+), 217 deletions(-)`. Of that, `web/src/agent/**` is
**10,596 lines across 41 files, every one of them new**.

**Why this counts as meaningfully extended:** the WebMCP layer is a new
subsystem, not a wrapper. It adds an action registry that becomes the single
source of truth for every feature in the app, 35 tools published on
`document.modelContext`, a natural-language shot resolver that did not exist,
URL state and page handles that had to be built before any tool could drive the
UI, and a cost guard that gates real spending. None of it existed in `cebcf93`.
The proof is a film: **"Two Claudes"**, a 130-second short that an agent
produced end to end on the hosted demo through these tools, in 257 tool calls
across 15 distinct tools, for about $1.50. The pre-existing app could not have
been driven that way, because it published nothing to drive.

### The agent layer (new, `web/src/agent/**`, 41 files, 10,596 lines)

| File | What it adds |
|---|---|
| `contract.ts` | The `ActionDef` contract: name, description, JSON Schema, annotations, `where` a feature lives, `howTo` a human performs it, `execute`. `TOOL_NAMES`, the anchor vocabulary and Chrome's budget constants. Frozen at G0 (`b7d04e0`). |
| `registry.ts` | `register` / `all` / `get` / `perform`. `perform` validates args, stamps the trail, clips output to 1.5K chars keeping identifiers intact, and never throws. |
| `webmcp.ts` | The bridge. Reads `document.modelContext`, registers every tool under one `AbortController`, normalizes Chrome's JSON-string input, resolves errors instead of rejecting. Optional polyfill behind a flag, off by default. |
| `context.ts`, `index.ts` | The shared `ActionContext` and the app-mount entry point. |
| `urlState.ts` | Query-param state so tools and humans share deep links. |
| `pageHandles.ts` | Imperative handles React pages publish on mount, plus `waitFor(page, identity)`. Tools call handlers, not the DOM. |
| `presence.tsx` | `data-action` anchors, the `pulse()` ring, and the Agent trail drawer that logs and replays every step. |
| `resolve.ts` | The shot resolver and cast index: sid, ordinal, ordinal words, beat, act, shot type, cast alias and free-text scoring, returning `best`, `candidates` and a confidence including `ambiguous`. |
| `Palette.tsx` | The ⌘K palette, the human projection of the same registry, and the `show_me` teaching path. |
| `jobs.ts` | The async pattern: `submitAndSettle` over the existing SSE watch, and bounded waiting. |
| `guard.ts` | Cost and doctrine guard. Resolves the effective backend per lane, classifies free versus paid, requires `confirm_cost`, applies FIRST-SECOND LAW defaults. |
| `tools/**` | The 35-tool catalogue: `find.ts`, `navigate.ts`, `generate.ts`, `motion.ts`, `picks.ts`, `timing.ts`, `audio.ts`, `music.ts`, `direct.ts`, `film.ts`, `jobs.ts`, `comp.ts`, `settings.ts`, plus `deps.ts`, `util.ts`, `fakeContext.ts` and `descriptions.md`. The palette-only feature registry (111 entries) lives in `agent/features.ts`. |
| `__tests__/**`, `tools/__tests__/**` | Registry contract tests against Chrome's budgets, resolver pins, page-handle and palette tests, per-tool units, and the hero journeys as runnable evals. |

The 35 tool names, in `contract.ts` order: `find_shots`, `describe_shot`,
`get_context`, `list_features`, `show_me`, `open_shot`, `generate_takes`,
`freeze_tail`, `trim_clip`, `select_take`, `set_keeper`, `set_timeline_source`,
`set_shot_timing`, `synthesize_vo`, `direct_shot`, `apply_plan`, `cut_film`,
`get_jobs`, `wait_for_jobs`, `generate_music`, `generate_sfx`, `place_cue`,
`list_cues`, `add_cel_layer`, `reroll_layer`, `restyle_background`,
`set_background`, `set_layer`, `remove_layer`, `render_comp`, `list_layers`,
`list_backends`, `set_lane_default`, `export_timeline`, `render_timeline`.

### Changes to pre-existing files (`server/cutroom/**`: 18 files, +1,548 / -83)

- **`web/src/pages/ShotPage.tsx`**: URL state for `tab`, `sub`, `take` and
  `kind`, so `/p/two-claudes/shot/B03-S1?tab=generate&sub=still` is a real deep
  link. Page handles on mount. `data-action` anchors on every driven control.
- **`web/src/pages/FilmEditorPage.tsx`**: URL state for `sel`, `view`, `scope`
  and `res`; page handles; anchors on the strip, the quick panel, the Cut
  control and the cue strip.
- **`web/src/App.tsx` / `main.tsx`**: registry mount, WebMCP registration at
  app start, the topbar tools chip, the trail drawer, `?token=` intake so the
  judge link is one click, `?agent_speed=` and `?agent_debug=`.
- **`web/src/styles.css`**: the `.agent-pulse` ring, palette and trail styles.
- **`server/cutroom/importer/folder.py`**: reads `prompts/characters.jsonl` and
  stores a cast index on the project, which the importer never did before.
- **`server/cutroom/api/`**: `GET` and `POST /api/projects/{pid}/cast`, the
  music and SFX cue sheet, `budget` on `GET /api/system`, and the demo-mode
  and rate-limit guards on the generate and system routes.
- **`server/cutroom/main.py` / `config.py`**: demo mode, judge and admin token
  roles, boot-time provider seeding from env, per-lane defaults from
  `CUTROOM_LANE_<LANE>`, and the rolling 24-hour cap
  `CUTROOM_DEMO_BUDGET_USD`.
- **`server/cutroom/demo.py`** (new): demo policy, bundle import at boot, rate
  limiting, reset.
- **Assembler**: music bed mixing and SFX cue placement.
- **Motion**: full-frame cels stream through ffmpeg instead of the in-memory
  compositor, after the 1 GB demo box ran out of memory in production.
- **`server/tests/`**: cast import, demo mode, budget cap and bundle tests
  added; the pre-existing suite stays green.

Several of these were found by driving production, not by reading code:
`ed48a0b`, `1ec04b0`, `67d66de`, `f81f8d2`, `c4fae81`.

### Test and eval work

- `web/` vitest suite. The repo had **no front-end tests** before.
- Playwright end-to-end against real Chrome and the native API (`b54a205`,
  `d271abe`), plus `web/scripts/agent-drive.mjs`, which drives a page through
  `document.modelContext` from system Chrome.
- `docs/TESTING-WEBMCP.md` §1 is an empirical probe of the WebMCP API as it
  actually behaves in Chrome 152.0.7977.65, not as documented.

### The demo film

`docs/demo-films/two-claudes/` (`4bea5df`): shots, cast, source notes and the
script for a 130-second short, written for this submission. The agent then
produced it on the hosted instance through the tools. See its README.

### Infrastructure added for the submission

- `THIRD_PARTY_NOTICES.md` — FreeCut attribution and the LGPL exclusion.
- `.github/workflows/ci.yml` — web build, pytest, Docker image build, and the
  GHCR publish Railway pulls from.
- `docs/DEPLOYMENT.md` § "Hosted demo (Railway)" — the hosted judge instance.
- `scripts/seed-film.py`, `scripts/make-run-steps.py`.
- `docs/SUBMISSION.md`, `docs/VIDEO-SCRIPT.md`, `docs/DEMO-RUNBOOK.md`, and
  this file.

### Evidence

```
$ git diff --shortstat cebcf93..HEAD
112 files changed, 18384 insertions(+), 217 deletions(-)

$ git log --format='%h %ad %s' --date=short cebcf93..HEAD
82f5343 2026-09-01 plan: cut 5 log
3bef4e6 2026-09-01 music tools: default cue gains -8 dB (music) / -4 dB (sfx) — -16 buried a -17 dB RMS bed under the VO on the hosted demo
274e447 2026-09-01 plan: scored cut log
5b6ff68 2026-09-01 plan: music & SFX log
4d0e445 2026-09-01 elevenlabs: restricted keys pass the health probe via /v1/voices
c056362 2026-09-01 Music & SFX: cue sheet, assembler mixing, 4 WebMCP tools
7721e7b 2026-09-01 plan: cut 3 log
f81f8d2 2026-09-01 set_timeline_source: capture the monitor selection before navigating (re-opening the page without ?take= reset it)
33fabf9 2026-09-01 plan: production cycle 2 log
67d66de 2026-09-01 picks: set_keeper/set_timeline_source honour the monitor selection (found driving production); run steps drop the second freeze
c4fae81 2026-09-01 motion: full-frame cels stream through ffmpeg instead of the in-memory compositor (1 GB demo box OOMed); cast test uses the client fixture
7b221a9 2026-09-01 plan: first production cut log
51bf8f8 2026-09-01 make-run-steps: --skip-stills, configurable motion waits
1ec04b0 2026-09-01 found driving production: crop intermediates are never 'the newest clip'; page handles carry the server's rejection text; wait_for_jobs accepts job objects; admin exempt from demo rate limits
7f62a71 2026-09-01 plan: production-drive log
ed48a0b 2026-09-01 tools: failed VO/motion jobs report ok:false; single-job tools also return jobs[]; resolver reads ordinal words; seeder print fix (found driving production)
e0d3c72 2026-09-01 scripts: make-run-steps — full production run as agent-drive steps
7da4495 2026-09-01 docs: runbook matches the live demo
4bea5df 2026-09-01 demo film: Two Claudes, a 2 minute limited animation short
ed145da 2026-09-01 api: POST /projects/{pid}/cast (admin) for API-created projects; scripts/seed-film.py
02c9d09 2026-09-01 scripts: agent-drive — drive a Cutroom page through native WebMCP tools from real Chrome
579086b 2026-09-01 deploy: ship the SPA in the image (it was being silently dropped)
982a7b4 2026-09-01 plan: go-public log
e5ad145 2026-09-01 ci: publish the demo image as ghcr.io/<owner>/cutroom-demo (fresh package linked to the public repo)
d6890fb 2026-09-01 plan: safety-pass log
a2b8280 2026-09-01 web: @types/node for the fixture loader; ESM-safe path via import.meta.url
9b166b3 2026-09-01 docs: demo bundle moves to the private cutroom-demo-data repo
e639fab 2026-09-01 tests: sanitized film fixture in the repo; full recording stays private (real-data pins skip without it)
199d48d 2026-09-01 docs: hosted-demo runbook — final lanes, demo bundle, registry credentials
f179661 2026-09-01 webmcp: list_features lists every tool; clip() keeps identifiers intact and flags truncation; G1 log
d271abe 2026-09-01 webmcp(E): e2e green against the native API — 19 passing, 2 real gaps flagged
5b053d4 2026-09-01 docs: DEPLOYMENT.md — hosted demo (Railway) runbook
679687a 2026-09-01 webmcp B: shot resolver, cast index, demo mode, providers, spend cap, bundle
ff69538 2026-09-01 agent: the 19-tool WebMCP catalogue (workstream C)
6d7feaa 2026-09-01 web: target ES2022 (Array.prototype.at in tests)
acdf222 2026-09-01 webmcp(A): adopt B's makeResolver(api) factory with the real api
091922b 2026-09-01 deploy: build the image in CI and push to GHCR; Railway pulls it
a5d2282 2026-09-01 webmcp(A): front-end spine — URL state, page handles, anchors, registry, bridge, trail, palette
b54a205 2026-09-01 webmcp(E): Playwright harness, e2e specs, eval journeys, agent-Chrome launcher
ff15c8c 2026-09-01 docs(F): fold E's measured Chrome 152 flag findings into judge instructions
4a66a6c 2026-09-01 docs: submission package draft (F) — Devpost copy, video script, demo runbook
d139e7c 2026-09-01 webmcp(E): native-API probe — empirical WebMCP findings for Chrome 152
39fcc64 2026-09-01 repo: MIT third-party notices, CI, prior-work skeleton, README status block
c49b70d 2026-09-01 webmcp(E): vitest harness — jsdom config, CSS.escape shim, npm test/e2e scripts
5659cc1 2026-09-01 plan: G0 results log
b7d04e0 2026-09-01 webmcp: G0 contract — action registry types, anchors, tool names, budgets
```

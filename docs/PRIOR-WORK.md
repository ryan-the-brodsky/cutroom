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
the author's private `game7` film repository into its own public repo. So
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
- <!-- F: add the game7 private-repo commit reference or a `git log` excerpt if
  Ryan is willing to show it, plus any dated screenshots/render outputs. -->

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
  - `importer/game7.py`, `models.py`, `storage.py`, `config.py`, `film.py`
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

> **PLACEHOLDER — workstream F completes this section.** Keep the headings; fill
> in the file list, the commit range, and the line counts from
> `git diff --stat cebcf93..HEAD`.

### The agent layer (new files)

<!-- F: final list. Expected, per docs/WEBMCP-PLAN.md §3:
     web/src/agent/contract.ts     — the action registry contract (G0, b7d04e0)
     web/src/agent/webmcp.ts       — document.modelContext bridge
     web/src/agent/presence.tsx    — page handles, anchors, the execution trail
     web/src/agent/pageHandles.ts
     web/src/agent/resolve.ts      — shot resolver + cast index
     web/src/agent/Palette.tsx     — the ⌘K palette and "show me"
     web/src/agent/jobs.ts         — the async job pattern
     web/src/agent/guard.ts        — cost and doctrine guard
     web/src/agent/tools/*         — the v1 tool catalogue
     web/src/agent/__tests__/*     — unit tests
     server/cutroom/demo.py        — demo mode + bundle importer
     evals/journeys.json           — the hero journeys as evals
     docs/TESTING-WEBMCP.md, docs/SUBMISSION.md
-->

### Changes to pre-existing files

<!-- F: e.g. App.tsx (registry mount, ?token= intake), main.py / config.py
     (demo mode, budget cap, env-seeded lanes), the pages that expose anchors. -->

### Infrastructure added for the submission

- `THIRD_PARTY_NOTICES.md` — FreeCut attribution and the LGPL exclusion.
- `.github/workflows/ci.yml` — web build, pytest, Docker image build.
- `docs/DEPLOYMENT.md` § "Hosted demo (Railway)" — the hosted judge instance.
- This file.

### Evidence

<!-- F: paste `git log --format='%h %ad %s' --date=iso cebcf93..HEAD` and the
     `git diff --shortstat cebcf93..HEAD` line. -->

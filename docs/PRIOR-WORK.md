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

Everything below was written after the submission period opened on 2026-08-25,
in a sprint that started 2026-09-01 16:00 PDT. Commit range
`<COMMIT RANGE: cebcf93..HEAD>`; per-commit log and diffstat under "Evidence".

**Why this counts as meaningfully extended:** the WebMCP layer is a new
subsystem, not a wrapper. It adds an action registry that becomes the single
source of truth for every feature in the app, <TOOL_COUNT> tools published on
`document.modelContext`, a natural-language shot resolver that did not exist,
URL state and page handles that had to be built before any tool could drive the
UI, and a cost guard that gates real spending. None of it existed in `cebcf93`,
and the pre-existing app cannot be driven by an agent without it.

### The agent layer (new files, `web/src/agent/**`)

| File | What it adds | Commit |
|---|---|---|
| `contract.ts` | The `ActionDef` contract: name, description, JSON Schema, annotations, `where` a feature lives in the UI, `howTo` a human performs it, `execute`. Anchor vocabulary and Chrome's budget constants. | `b7d04e0` |
| `registry.ts` | `register` / `all` / `get` / `perform`. `perform` validates args, stamps the trail, clips output to 1.5K chars, and never throws. | `<COMMIT>` |
| `webmcp.ts` | The bridge. Reads `document.modelContext` (deprecated `navigator.modelContext` fallback), registers every tool under one `AbortController`, normalizes Chrome's JSON-string input, and resolves errors instead of rejecting. Optional polyfill behind a flag, off by default. | `<COMMIT>` |
| `pageHandles.ts` | Imperative handles React pages publish on mount, plus `waitFor(page, identity)`. Tools call handlers, not the DOM. | `<COMMIT>` |
| `presence.tsx` | `data-action` anchors, the `pulse()` ring animation, and the Agent trail drawer that logs and replays every step. | `<COMMIT>` |
| `resolve.ts` | The shot resolver and cast index: sid, ordinal, beat, act, shot type, cast alias and free-text scoring, returning `best`, `candidates` and a confidence including `ambiguous`. | `<COMMIT>` |
| `Palette.tsx` | The ⌘K command palette, the human projection of the same registry, plus the `show_me` navigation and teaching path. | `<COMMIT>` |
| `jobs.ts` | The async pattern: `submitAndSettle` over the existing SSE watch, and the bounded `wait_for_jobs` behaviour. | `<COMMIT>` |
| `guard.ts` | Cost and doctrine guard. Resolves the effective backend per lane, classifies free versus paid, requires `confirm_cost`, and applies FIRST-SECOND LAW defaults. | `<COMMIT>` |
| `tools/**` | The v1 catalogue of <TOOL_COUNT> tools (`docs/WEBMCP-PLAN.md` §4), each executing visibly through the UI. | `<COMMIT RANGE>` |
| `__tests__/**` | Registry contract tests against Chrome's budgets, resolver pins, and tool unit tests with a fake context. | `<COMMIT RANGE>` |

### Changes to pre-existing files

- **`web/src/pages/ShotPage.tsx`**: URL state for `tab`, `sub`, `take` and
  `kind`, so `/p/next-year/shot/B10-S2?tab=generate&sub=still` is a real deep
  link. Page handles registered on mount. `data-action` anchors on every
  control a tool drives. `<COMMIT RANGE>`
- **`web/src/pages/FilmEditorPage.tsx`**: URL state for `sel`, `view`, `scope`
  and `res`; page handles; anchors on the strip, the quick panel and the Cut
  control. `<COMMIT RANGE>`
- **`web/src/App.tsx` / `main.tsx`**: registry mount, WebMCP registration at
  app start, the topbar tools chip, the trail drawer, and `?token=` intake so
  the judge link is one click. `<COMMIT RANGE>`
- **`web/src/styles.css`**: the `.agent-pulse` ring, palette and trail styles.
  `<COMMIT>`
- **`server/cutroom/importer/game7.py`**: reads `prompts/characters.jsonl` and
  stores a cast index on the project, which the importer never did before.
  `<COMMIT>`
- **`server/cutroom/api/`**: `GET /api/projects/{pid}/cast`, and the demo-mode
  and budget guards on the generate and system routes. `<COMMIT RANGE>`
- **`server/cutroom/main.py` / `config.py`**: demo mode, judge and admin token
  roles, boot-time provider seeding from env (`OPENROUTER_API_KEY`, `FAL_KEY`,
  `ELEVEN_LABS_API_KEY`), per-lane defaults from `CUTROOM_LANE_<LANE>`, and the
  rolling 24-hour spend cap `CUTROOM_DEMO_BUDGET_USD`. `<COMMIT RANGE>`
- **`server/cutroom/demo.py`** (new): demo-mode policy, the bundle download and
  import at boot, rate limiting, and the reset path. `<COMMIT>`
- **`server/tests/`**: cast import, demo mode, budget cap and bundle tests
  added; the pre-existing suite stays green. `<COMMIT RANGE>`

### Test and eval work

- `web/**` vitest suite (the repo had no front-end tests before). `<COMMIT RANGE>`
- Playwright end-to-end against real Chrome with the native API. `<COMMIT RANGE>`
- `evals/journeys.json`: the hero journeys from `docs/WEBMCP-PLAN.md` §5 as
  runnable evals. `<COMMIT RANGE>`
- `docs/TESTING-WEBMCP.md`: recorded runs and the cross-client checklist.
  `<COMMIT RANGE>`

### Documentation written for the submission

- `docs/WEBMCP-PLAN.md`: the implementation plan the build followed.
- `docs/research/webmcp-api-brief.md`, `docs/research/webmcp-challenge-brief.md`.
- `docs/SUBMISSION.md`, `docs/VIDEO-SCRIPT.md`, `docs/DEMO-RUNBOOK.md`.
- The README section "Drive Cutroom with an agent (WebMCP)".

### Infrastructure added for the submission

- `THIRD_PARTY_NOTICES.md` — FreeCut attribution and the LGPL exclusion.
- `.github/workflows/ci.yml` — web build, pytest, Docker image build.
- `docs/DEPLOYMENT.md` § "Hosted demo (Railway)" — the hosted judge instance.
- This file.

### Evidence

```
<PASTE: git log --format='%h %ad %s' --date=iso cebcf93..HEAD>
```

```
<PASTE: git diff --shortstat cebcf93..HEAD>
```

Summary line to fill at finalization: *<N> commits between 2026-09-01 and
2026-09-03, <N> files changed, <N> insertions, of which `web/src/agent/**` is
<N> lines across <N> files, all new.*

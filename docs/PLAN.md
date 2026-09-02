# Genga Studio timeline foundation + engine lift — phased plan

> The build plan for the decision in [FOUNDATION.md](./FOUNDATION.md): give Genga Studio a real
> rational-time timeline and drive rendering/preview with FreeCut's lifted engine, without
> hard-forking the app. Phases are ordered so each one leaves the tree green and, where a
> browser surface exists, e2e-verifiable in Chrome. Estimates are engineer-time for a focused
> build, not wall-clock.

## The through-line

Today `Shot.seconds` is a slot duration; the source always plays from frame 0; `assemble.py`
butt-concats one segment per shot. The entire plan is the consequence of one change: **a shot
is a unit of production; a clip is a unit of time, with a source in/out and media handles.**
Once that model exists, trims, transitions, J/L cuts, freeze-tail-as-an-edit, and interchange
export stop being features to build and become properties of the model.

We keep our server (generation, Take lineage, jobs/pools, adapters, director grammar, bible).
We add a timeline model above the shot model, and we drive frames through FreeCut's engine —
first as a co-process service (fast to stand up), later lifted into our app for interactive
preview.

## Two integration modes for the engine

- **Service mode (early phases).** FreeCut's `window.freecut.renderProject({project, settings,
  media:[{mediaId,url}]})` runs the real engine in headless Chrome; `headless/serve.mjs` wraps
  it as a warm `POST /render` HTTP service. Our server compiles a timeline → a FreeCut project
  and calls the engine. Proven working in the spike (§9a of FOUNDATION.md): our VP9/H.264
  footage, served by URL, rendered frame-exact.
- **Lift mode (later phases).** Lift `runtime/player` (3.2k LOC, zero store coupling) +
  `runtime/composition-runtime` (16k, one cut-line file) + `export` + `keyframes` + `gpu-*`
  into `web`, bound to our own stores. This is what buys interactive scrubbing in our
  own two-room UI. Larger and riskier; deferred until the model and the service path are solid.

---

## Phase 1 — Timeline data model  ·  foundation, no UI  ·  ~3–5 days

The non-negotiable. Rational/frame time; clip source in/out; media handles; stable IDs.

- **TS** `web/src/timeline/model.ts`: `Timeline`, `Track`, `Clip` (discriminated:
  video/image/audio/text), `Transition`, `Marker`. Frame-based (`from`, `durationInFrames`,
  `sourceStart`, `sourceEnd`, `sourceDuration`, `sourceFps`) mirroring FreeCut's proven shape
  so the compiler → FreeCut mapping is near-identity. UUID ids. Carries a namespaced
  `cutroom` metadata block per clip (shot sid, take path, prompt/model/seed lineage) — the
  thing OTIO can't hold and our product turns on.
- **Python** `server/cutroom/timeline/model.py`: dataclasses + `to_dict`/`from_dict`
  + `validate()` (frame integers, non-negative, source range within `sourceDuration`,
  handle-aware). This is the server-side source of truth.
- **Tests** `server/tests/test_timeline_model.py`: round-trip, validation failures,
  handle math.

Exit: `pytest` green; types compile. No browser surface yet.

## Phase 2 — Film → Timeline compiler  ·  ~3–5 days

Turn the sample film *Next Year* (project `next-year`, 123 shots) into a real timeline,
and emit the FreeCut project.

- `server/cutroom/timeline/compile.py`:
  - `compile_film(store, session, project) -> Timeline`: each shot → a clip on **V1** using
    `film.active_source` precedence; `seconds`→`durationInFrames` at project fps; source
    in/out defaults to full source (probed), so trims are expressible immediately; each shot's
    VO → an **A1** audio clip at `head_pad + vo_offset`; music/sfx cues → cue clips. Stills
    hold true-still (image clip). Carries shot lineage into `clip.metadata.cutroom`.
  - `to_freecut_project(timeline) -> (projectObject, media[])`: emit `{metadata:{fps,w,h},
    timeline:{items,tracks,compositions}}` + `media:[{mediaId,url}]`. mediaId = the
    project-relative asset path; url = our media endpoint (or the render script's media server).
- **Endpoints** (`api/timeline.py`): `GET /api/projects/{p}/timeline` (our model),
  `GET /api/projects/{p}/timeline/freecut` (engine project). Wire into `main.py`.
- **Tests**: compile next-year, assert clip count == shot count, total duration matches the
  assembler's, VO placement, lineage present, FreeCut project validates.

Exit: `pytest` green; endpoints return correct JSON for the real film.

## Phase 3 — Render the real timeline through the engine  ·  browser-verified  ·  ~2–4 days

Prove the model + compiler drive the real engine end-to-end, in a browser, on the real film.

- `server/cutroom/engine_render/`: a render module that productionizes the spike —
  spins up `media-server.mjs` over the compiled media's real file paths, drives the FreeCut
  engine (`renderProject`) in headless Chrome via Playwright, returns the mp4. (Later swap to
  a warm `serve.mjs` co-process for speed.)
- **Endpoint** `POST /api/projects/{p}/timeline/render` → job → mp4 Take.
- **Genga Studio UI** `web/`: a **Timeline** view that fetches the compiled model and draws
  the clips as a real strip (in/out, per-clip duration, track lanes, total runtime), with a
  "render via engine" action that plays the result inline.
- **e2e (claude-in-chrome):** load the app over the LAN URL (`CUTROOM_HOST=0.0.0.0`, the
  extension can't reach 127.0.0.1), open the Timeline view, verify the 123-shot film renders as
  clips with in/out (not slots), trigger a scoped engine render, verify the mp4 plays.

Exit: real film visible as a real timeline in our UI; engine render plays; screenshotted.

## Phase 4 — Interactive preview: lift the transport  ·  the real lift begins  ·  ~3–4 weeks

- Lift `runtime/player` + `runtime/composition-runtime` into `web` behind our stores
  (the 9 store bindings concentrate in one `deps` file — that's the cut line). Vite config gains
  COOP/COEP `require-corp`; mediabunny + WebGPU pipeline come along.
- Media loads **by URL** from our server (the seam is ~80% there in FreeCut: the media funnel
  already falls through to `UrlSource`); set `crossOrigin='anonymous'` on video elements; our
  media endpoint must send CORP + Range.
- **e2e:** scrub the playhead in our own UI; frames update from our server's media. The thing
  Genga Studio has never had.

## Phase 5 — Track view + edit verbs  ·  ~3–5 weeks

- Lift `timeline-content.tsx` (prop-driven) or build our track view on our stores. Trim handles
  → non-destructive source in/out. **Freeze-tail becomes a trim + freeze item, not a render
  job.** Ripple/roll, blade, snapping, markers. J/L cuts fall out of link/unlink.
- Design **async-undo first** (before generation writes): FreeCut's `execute()` silently drops
  async mutations and `addUndoEntry` has no staleness/context guard — our long-running
  generation jobs need a context assertion + revision guard.

## Phase 6 — Shots as `CompositionItem`; generation on the timeline  ·  ~3–5 weeks

- Model a shot as a `CompositionItem` (nested sub-timeline for cel layers), **not** a 10th
  union kind — dodges ~615 dispatch sites and two silent-default switches, and inherits
  per-shot undo stacks. Cel comps map onto the sub-composition's tracks.
- Our director ops (`gen_still/i2i/motion/vo`, `create_comp`, `add_layer`) target timeline
  clips; Takes become clip source variants (Auditions). Port FreeCut's tool-contract shape
  (name/schema/flags/summarize) onto our `OPS`, but keep our async job runtime.

## Phase 7 — Master render + interchange  ·  ~2–4 weeks

- MLT (LGPL build) as the authoritative server-side master render: compile our timeline JSON →
  `.mlt`, `melt` subprocess. Keeps the Shotcut round-trip escape hatch.
- OTIO + EDL export at the boundary (TS serializer, no Python dep): Resolve/Nuke/Kdenlive open
  our cut. Namespace lineage under our vendor key; `GeneratorReference` + `ExternalReference`
  pairs per generated clip.
- Rip out LGPL SoundTouch (2 files, library-neutral export names already) → signalsmith (MIT),
  or drop it if we don't pitch-retime.

---

## Sequencing rules

1. **Model before UI, always.** Phase 1 gates everything.
2. **Service mode before lift mode.** Prove the engine on our data (Phases 2–3) before paying
   the lift cost (Phase 4+).
3. **Async-undo design lands before any generation writes to the timeline** (Phase 5, before 6).
4. **Keep the existing Film Editor + `assemble.py` working** until the timeline UI replaces
   them — no big-bang cutover.

## This session's target

Phases 1–3: the data model, the compiler on the real film, and a browser-verified engine render
through a Genga Studio Timeline view. Phase 4+ (the interactive lift) is subsequent work.

---

## Session results (2026-07-14) — Phases 1–3 landed

**Phase 1 — timeline model.** `cutroom/timeline/model.py` (frame-time, clip source in/out,
media handles, lineage) + the TS mirror `web/src/timeline/model.ts`. 17 model tests green;
web typecheck clean.

**Phase 2 — compiler.** `cutroom/timeline/compile.py`: `compile_film` (film → Timeline via the
`active_source`/VO precedence) + `to_freecut_render_input` (the proven engine shape). Endpoints
`GET /timeline` and `/timeline/freecut` wired in `main.py`. 4 compiler tests green. Live compile
of the sample film *Next Year*: **186 clips (76 stills · 21 motion · 89 VO), 7:43, validates.**

**Phase 3 — engine render + Timeline view.**
- `web/src/pages/TimelinePage.tsx` (+ route + nav): the film as a real clip strip — V1 clips
  (stills as true holds, motion with in/out + thumbnails), A1 VO offset under each shot, ruler,
  zoom, per-clip detail (source in/out, head/tail handles, lineage).
- Verified in a **real browser** (Playwright + system Chrome) against the running Genga Studio server:
  186 clip elements, header "186 clips · 7:43 · 24fps · 1920×1080", zero page errors.
- **End-to-end on real data:** pulled the compiler's `/timeline/freecut` output for the real
  film, scoped to 24s, served the real media by URL, drove the FreeCut engine → **frame-exact
  576-frame / 24.0s / 1080p H.264 mp4 with the VO on an AAC track, `warnings:[]`**, showing the
  real opening footage. Model → compiler → engine proven on the actual film.

**Bug fixed in passing (important):** the test harness was writing into the user's **production
`~/.cutroom` db** — `data_dir` used the pydantic prefix (`CUTROOM_DATA_DIR`) while the docs/tests
set `CUTROOM_DATA`, so the env was only honored at import and per-test isolation silently failed.
Fixed with an explicit `validation_alias="CUTROOM_DATA"` (config.py); cleaned the leaked test
projects from the real db. Full server suite now **61 passed**, isolated, real db untouched.

**Not done this session (as planned):** the interactive-preview lift (Phase 4) — the Timeline
view is a compiled strip, not yet a scrubbing playhead; and the server-side render endpoint
(`POST /timeline/render`) is proven via a standalone harness but not yet wired as a job.

**Caveat:** the `claude-in-chrome` extension could not drive the page (it reverts navigation and
returns "can't interact with this URL" for the LAN host — a per-host site-permission grant in the
extension that must be enabled manually). Browser verification was done via Playwright against the
same server instead.

---

## Session 2 results (2026-07-15) — Phases 4–7 landed (partial), agent-team build

Ran as an architect over a 4-agent team (edit-ops, interchange, compiler enrichments, lift recon)
plus a self-owned integration spine. **Full server suite: 115 passed, 1 skipped. Every surface
below verified live in the M3 Chrome via claude-in-chrome** (once the right device was selected —
there were two connected browsers; see [[claude-in-chrome-device]]).

**Phase 3 completion — render through the product.** `POST /api/projects/{p}/timeline/render`
(a `timeline.render` job) drives the engine via a self-contained node CLI (`render-cutroom.mjs`,
serves dist harness + media through `createHarnessServer`, no dev server) → an mp4 Take.
`engine_render.py` shells out (the license/swappability firewall; `CUTROOM_ENGINE_DIR` /
`CUTROOM_NODE_BIN`). The Timeline view has a scope selector + render button + an "Engine renders"
gallery. Verified: clicked render → job → **`timeline-24s.mp4`, 24s, 15 clips**, playable in the
gallery.

**Phase 4 — interactive preview lift (the crown jewel).** Surgically lifted FreeCut's
`runtime/player` (27 files, one dependency) + `shared/logging` into `web/src/runtime`;
added a `@`→src alias (vite + tsconfig) and `vite-env.d.ts`. Wrote `PreviewStage`/`PreviewClip`
(~150 lines) driving `HeadlessPlayer` + `Sequence`; media loads **same-origin** through the
server (no COOP/COEP needed, per the recon). Verified live: a **scrubbable preview** composites the
real film's media by URL; clicking a clip seeks (the right frame appeared for B02-S5), the red
playhead + scrubber stay in sync. This is the thing Genga Studio never had. (Video/stills scrub; audio
playback is a later pass.)

**Phase 5 (partial) — edit-ops library.** `timeline/edits.py` + `edits.ts` (35 tests): slip,
ripple-trim start/end, split, move, remove, `freeze_tail_trim` (the FIRST-SECOND-LAW as a
non-destructive edit). Pure functions over the model; not yet wired to drag-handles in the UI.

**Phase 6 (partial) — compiler enrichments.** Multi-VO **per scripted dialogue line** (not per
take variant — the first cut of this ballooned the film to 22 min; corrected to cap by
`len(shot.dialogue)` and anchor VO per-shot, restoring 7:43), plus MUSIC/SFX cue tracks from
`Project.settings` and `scope="actN"` filtering. The real film now compiles to **299 clips across
4 tracks (V1/A1/MUSIC/SFX), 7:43**, with the real cues (`01-drought-opening.mp3`, radio-tuning,
crowd-swell, …) visible on the timeline.

**Phase 7 (partial) — interchange.** `to_otio` (`.otio` JSON, gapless, lineage under
`metadata.cutroom`, GeneratorReference for generated clips) + `to_edl` (CMX3600). Endpoints
`GET /timeline/otio` and `/timeline/edl` live and verified on the real film (Resolve/Nuke/Kdenlive
can open the cut). MLT master render still not started.

**Not done (honest):** edit-ops not surfaced as drag-handles; interchange has no UI download
buttons (curl only); preview is video-only; freeze-tail *hold* (two-item) still deferred; MLT
(Phase 7 server master render) not started; the engine still points at the scratchpad FreeCut
clone (needs vendoring for a real deploy).

**Bug caught & fixed mid-flight (orchestration in action):** a sub-agent's multi-VO change passed
its own tests but ballooned the real film to 22 minutes by laying every VO *take variant* per shot;
corrected to cap by scripted dialogue-line count and drop the cross-shot watermark.

### UX pass (post-hands-on feedback)

Four fixes from driving the real UI, all verified in the M3 Chrome:
1. **Preview overflow** — the lifted player rendered its 1920×1080 composition near-native and spilled
   over the timeline. Fixed with an explicit `layoutSize` (scale the composition into a 480×270
   monitor) + `overflow:hidden`.
2. **Persist between navigations (the big one)** — every view switch re-ran the **5.5s cold compile**.
   Added (a) a server-side fingerprint cache on `compile_film` (**5.48s → 0.01s** on hit, invalidated
   by shots/takes/overrides/settings) and (b) a client stale-while-revalidate cache in `usePoll`
   (shows last data instantly on remount). Navigating away and back is now instant.
3. **Loading UI** — a layout-mimicking skeleton (shimmer) replaces the bare "compiling…" text; only
   shows on the first cold compile.
4. **Sidebar dead-end** — project links (Film Editor/Timeline/Director chat) vanished on global routes
   (Jobs/Settings); now the last project is remembered so they persist.

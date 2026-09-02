# Cutroom × WebMCP — implementation plan

> Architect's plan (Fable, 2026-09-01 15:45 PT). Status: **PLAN ONLY — nothing implemented.**
> Execution model: the architect orchestrates Opus sub-agents, one per workstream (§6), against
> the gates in §7. Companion research: [`research/webmcp-api-brief.md`](research/webmcp-api-brief.md)
> and [`research/webmcp-challenge-brief.md`](research/webmcp-challenge-brief.md). Read both before
> building; they contain the exact API shapes and the challenge rules this plan is designed around.

## 0. The one-paragraph version

Cutroom has ~97 distinct user-facing actions across two rooms, five tabs, four generate
sub-tabs, a cel workbench, a timeline, jobs and settings — and no way to find any of it except
by clicking. WebMCP lets the page itself hand an agent a tool list. The plan is to build **one
action registry** that is the single source of truth for every feature (name, description,
schema, *where it lives in the UI*, how a human does it by hand, and how to execute it), and
derive three things from it: (1) `document.modelContext` tools for agents, (2) a ⌘K command
palette for humans, (3) a "show me" behaviour that navigates to a feature and pulses the control.
Every agent tool **executes through the UI the human is looking at** — it navigates, opens the
tab, fills the console, highlights the button, then submits — so the director learns the app by
watching the agent drive it. The hero sentence comes from a real note: *"make a few more generative cuts
of the David Ross close-up"* → `find_shots` → `open_shot` → `generate_takes ×3`, in one turn.

**Hard constraint discovered in research:** the challenge closes **Thu 2026-09-03 13:00 PDT**
(~45 hours from the time of writing). It requires a public open-source repo, a live HTTPS URL
judges can open in ChatGPT's browser or flagged Chrome, and a <3-minute public YouTube video.
Existing apps qualify if the WebMCP work is clearly documented as new. So this is a 45-hour
sprint plan with a submission package, and a v2 roadmap after it.

## 1. Facts this plan is built on

### 1.1 WebMCP as it exists today (details in the API brief)

- Entry point is **`document.modelContext`** (`navigator.modelContext` is a deprecated alias).
  `registerTool(tool, { signal })`; unregister by aborting the signal. No `provideContext`,
  no `unregisterTool`. `getTools()`, `executeTool()`, `toolchange` event.
- Tool = `{ name (≤30 chars, [A-Za-z0-9_.-]), title, description (≤500), inputSchema
  (JSON Schema, param descriptions ≤150), annotations { readOnlyHint, untrustedContentHint,
  (Chromium: consequentialHint) }, async execute(input, { signal }) }`. Output ≤1.5K chars.
- **Never reject from `execute`** — a rejection surfaces as an opaque `UnknownError`. Resolve
  with `{ ok:false, error, hint }`.
- Chrome passes `executeTool` input as a **JSON string**; the spec says object. Normalize.
- **Secure context only**: `https://`, `http://localhost`, `http://127.0.0.1`. The LAN URL we
  use for claude-in-chrome is *not* a secure context — `document.modelContext` will be absent
  there. Develop on localhost; demo on the hosted HTTPS URL.
- No progress/streaming API. Minutes-long jobs → submit-and-return `{job}`, plus a
  `readOnlyHint` status tool and a bounded wait tool.
- Chrome 152.0.7977.65 is installed here. Enable `chrome://flags/#enable-webmcp-testing` and
  `#devtools-webmcp-support`; DevTools › Application › WebMCP lists tools and runs them by hand.
- Clients that can call page tools **today**: ChatGPT Desktop's browser (native, the judges'
  primary environment), Chrome DevTools pane (manual), the Model Context Tool Inspector
  extension, **`chrome-devtools-mcp` v1.8.0 with `--categoryExperimentalWebmcp=true`** (this is
  how Claude Code drives them, the author's daily path), and MCP-B's local relay. The Claude in
  Chrome extension does not speak WebMCP.

### 1.2 The challenge (details in the challenge brief)

- OpenAI-run, Devpost-administered; Chrome, Cloudflare, Shopify, Vercel, Render, Netlify sponsor.
  Judges include Sarah Drasner (Chrome) and Alex Nahas (MCP-B).
- Judging: WebMCP leverage · Execution (complete product, not a PoC) · Potential impact (real
  problem, real audience) · Creativity & ambition. Equal weights, ties broken in that order.
- Organizer guidance: "Show the project working in the first 10 to 15 seconds." "Show the
  agent actually using your tools." Describe use cases, not features ("one turn instead of six
  screens"). Drasner: features that "only surface when an AI agent actually needs them."
- Required: live URL · public repo with a visible OSS license · <3 min public YouTube video with
  audio · description answering four set questions · documentation separating prior work from
  work done after 2026-08-25 (timestamped commits).

### 1.3 The codebase (from the survey; file:line refs are current as of today)

- React 18 + react-router 6 + Vite 5, no state library, no front-end tests, no ⌘K, no modals
  except `Spotlight`. Server: FastAPI, ~52 routes, DB-backed job queue with SSE watch.
- **The Shot Editor tab is not in the URL** (`ShotPage.tsx:25`), nor is the selected take,
  kind filter, active comp, or generate sub-tab. Deepest link: `/p/:pid/shot/:sid`.
  Film Editor `view/scope/res` and Timeline `ppf/scopeSec` are also local state.
- **No search, no numeric shot addressing, no cast index.** Shots are `B10-S2`-style sids with
  an `order_idx`. "Shot 37" = 37th in film order (in the sample film *Next Year* that is
  `B11-S4`, a still). A character close-up by name is `B10-S2` (HERO). The cast lives in
  `prompts/characters.jsonl` (one row per character, `"Name — the role"`), which the
  importer never reads. So the two phrasings in that one hero sentence point at *different*
  shots — the resolver must surface that, not guess.
- Every generative action returns `{job}`; `mock` backend returns real footage instantly;
  GPU/paid backends take minutes and cost money; backend fallback is "first enabled backend
  serving the lane" (`handlers.py:87-94`) — an agent that omits `backend` can hit a paid API.
- Existing NL surface: `POST /direct` → EditPlan preview → `POST /plan/apply` (two-step by
  design), plus a 4-tool Anthropic director chat. `GET /api/ops` publishes the 19-op vocabulary.
- Doctrine the tools must encode: true freezes only (no zoom op exists), boil never auto-plays,
  FIRST-SECOND LAW defaults, mock takes never auto-promote, never overwrite takes, explicit
  backend or confirmed default, pause sentinel honoured by non-cpu pools.
- The code has **no remote and no LICENSE** yet; it is untracked. `~/.cutroom/projects/
  next-year` is ~300 MB of renders + audio (assembly excluded) — a viable hosted demo dataset.

## 2. Design principles

1. **One registry, three surfaces.** Every feature is an `ActionDef`. WebMCP tools, the ⌘K
   palette and "show me" are projections of it. A feature that isn't in the registry doesn't
   exist for discovery purposes; that is the discipline that stops the drawer sprawl.
2. **Execute through the UI, visibly.** A tool navigates to where the feature lives, pulses the
   control, fills the same state the human would, and calls the same handler the button calls.
   Silent API calls are reserved for read-only tools. The activity is logged in an on-screen
   "agent trail" the human can replay. This is the "learn by watching" loop and the judges'
   "human-agent experience".
3. **App-level tools with explicit arguments.** Register the catalogue once at app mount with
   `shot` as an explicit string argument, and let each tool navigate as needed. Page-scoped
   registration is used only for context-bound tools (selection, comp layers). Reason: an agent
   holding a stale tool list can still act; `toolchange` reliability differs by client; and
   pre-Chrome-153 unregistration aborts in-flight executions.
4. **Accept human language, resolve in code.** `shot: "37" | "B10-S2" | "the Ross close-up"`,
   `count: "a few"` → 3. Return candidates when ambiguous. Enums for lanes/roles, never IDs.
5. **Async is the product.** Generation tools return immediately with jobs; a bounded wait tool
   and a read-only status tool close the loop; mock finishes in under a second so the demo is
   crisp.
6. **Cost and doctrine guards live in the tool, not the prompt.** Paid backends require
   `confirm_cost: true`; the tool reports the backend, its cost class and what will happen.
   Doctrine defaults (freeze after ~1s, no zoom) are the tool defaults.

   > **Amended 2026-09-02 (workstream N).** The freeze-after-1s default is withdrawn. The
   > live window turned out to be a property of the *backend*, not of image-to-video: the
   > local LTX rig holds about a second, hosted Wan-class models hold three to five. Every
   > motion backend now carries a `motion_profile` (clip length, fps, frame counts,
   > resolutions, price) and **clips play in full** at that length. Freeze-tail and
   > chain-stitching are SURGICAL repair tools: when a clip is good for its first N seconds
   > and then drifts, keep the good frames and hold or continue from them instead of
   > rerolling the whole clip. They are not defaults. The historical FIRST-SECOND LAW
   > (2026-07) applied to the local LTX lane only. The zoom ban and the boil ban stand.
7. **Budgets are contract.** Names ≤30, descriptions ≤500, param descriptions ≤150, outputs
   ≤1.5K chars, enforced by a unit test over the registry.

## 3. Architecture

All new front-end code lives in **`web/src/agent/`**. Server additions are small and listed.

### 3.1 The action registry contract (`web/src/agent/contract.ts`)

```ts
export type Anchor = string;                       // a data-action value, see §3.3
export interface Where {
  route: string;                                   // "/p/:pid/shot/:sid"
  query?: Record<string, string>;                  // { tab: "generate", sub: "still" }
  anchor?: Anchor;                                 // control to pulse
  label: string;                                   // "Shot Editor → Generate → Still"
}
export interface ActionDef<A = Record<string, unknown>, R = unknown> {
  name: string;                                    // ^[a-z][a-z0-9_]{0,29}$
  title: string;                                   // palette label
  description: string;                             // ≤500 chars, positive verb phrase
  inputSchema: JSONSchema7;                        // param descriptions ≤150 chars
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
  where: Where | ((args: Partial<A>) => Where);    // where the feature lives
  keywords?: string[];                             // palette / show_me matching
  howTo?: string;                                  // "how a human does this by hand", 1–2 sentences
  surfaces?: { agent?: boolean; palette?: boolean };   // default both true
  summarize?: (args: A) => string;                 // "Generate 3 stills for B10-S2"
  execute: (args: A, ctx: ActionContext) => Promise<R>;
}
export interface ActionContext {
  signal: AbortSignal;
  project: string | null;                          // current :pid or remembered last project
  nav: (to: string) => Promise<void>;              // react-router navigate + await route mount
  page: PageHandles;                               // imperative handles pages register on mount (§3.3)
  api: typeof import("../api").api;
  resolve: ShotResolver;                           // §3.4
  trail: Trail;                                    // §3.3
  speed: "watch" | "fast";                         // "watch" adds ~350 ms per visible step; tests use "fast"
}
export type ToolResult =
  | { ok: true; summary: string; [k: string]: unknown }
  | { ok: false; error: string; hint?: string; candidates?: unknown[] };
```

`registry.ts` exports `register(def)`, `all()`, `get(name)`, `perform(name, args, ctx)`.
`perform` wraps every execution: validates args (ajv or a tiny hand validator), stamps the trail,
runs `execute`, clips the result to 1.5K chars (`clip()` truncates arrays first, then strings,
and appends `"…(truncated)"`), catches everything and returns `{ ok:false }` — it never throws.

### 3.2 The WebMCP bridge (`web/src/agent/webmcp.ts`)

- `const mc = document.modelContext ?? (navigator as any).modelContext` at app mount; if absent
  and `import.meta.env.VITE_WEBMCP_POLYFILL === "1"` (or `?webmcp=polyfill`), dynamically import
  `@mcp-b/webmcp-polyfill@5.1.0` with `installTestingShim: true`. Default: no polyfill (the
  judges' environments are native).
- Registers every `ActionDef` with `surfaces.agent !== false` once, with one app-level
  `AbortController`. `execute` adapter: parse input if it is a string; call `perform`; return the
  `ToolResult` object (the browser JSON-stringifies it).
- Sets `annotations.readOnlyHint` from the def; also sets `consequentialHint` (harmless extra key
  on spec-shaped implementations).
- `useAgentTools(defs, deps)` hook for page-scoped tools: registers on mount with its own
  controller, aborts on unmount **after** any in-flight execution settles (tracks a counter).
- Exposes `window.__cutroomAgent = { list(), call(name, args) }` **only** when
  `import.meta.env.DEV` or `?agent_debug=1` — the Playwright harness uses it when the native API
  is unavailable.
- Status chip in the topbar: "🤖 tools: 16 · native | polyfill | unavailable (needs https or
  localhost)" so the human and the video can see the API is live.

### 3.3 Visible execution: page handles, anchors, trail (`web/src/agent/presence.tsx`, `pageHandles.ts`)

- **Page handles.** Pages register imperative handles on mount:
  `usePageHandles("shot", { sid, setTab, setSub, selectTake, setKindFilter, setGen(field, v),
  submitGenerate(sub), submitFreeze(live), submitTrim(end), submitVo(...), direct(instruction),
  applyPlan(plan) })`, similarly `"film"` (`selectShot, setScope, setRes, cutFilm, setOverride`)
  and `"comp"` (v2). `ctx.page.waitFor("shot", { sid })` resolves when a page with matching
  identity has mounted (5 s timeout → `{ok:false, error:"page did not mount"}`). Tools call
  handlers, not the DOM — inputs that commit on blur (`onBlur` seconds/offset fields) are a
  known trap for DOM driving.
- **Anchors.** Controls get `data-action="…"` attributes; `pulse(anchor)` scrolls into view and
  applies a 1.2 s ring animation (`.agent-pulse`). Anchor vocabulary (fixed at G0):
  `app.nav.{projects,film,timeline,chat,jobs,settings}` · `app.pause` ·
  `film.{cut,scope,res}` · `film.shot[data-sid]` · `film.quick.{seconds,vo_offset,mute,open,source}` ·
  `shot.tab.{compose,generate,motion,audio,script}` · `shot.direct.{input,submit}` · `shot.plan.apply` ·
  `shot.takes.filter[data-kind]` · `shot.take[data-path]` · `shot.take.{keeper,source,freeze,compose}` ·
  `shot.gen.sub.{still,restyle,animate,chain}` · `shot.gen.{still,restyle,animate,chain}.{prompt,seeds,denoise,frames,steps,cfg,freeze_after,mode,beats,submit}` ·
  `shot.gen.model` · `shot.motion.{live,freeze,trim}` · `shot.audio.{text,voice,treatment,submit,vo_offset,mute}` ·
  `timeline.{render,scope}` · `settings.backend[data-id].{enable,health,save,delete}`.
- **Trail.** `trail.step({ tool, title, anchor?, detail?, job? })` appends to an activity store
  rendered as a collapsible bottom-right drawer ("Agent trail": time · tool · summary · job link;
  click a step to re-pulse its anchor). The topbar chip shows the count. Steps are paced by
  `ctx.speed` so a human can follow: navigate → tab → sub-tab → fields → submit.
- **URL state (prerequisite).** `ShotPage` syncs `tab`, `sub`, `take`, `kind` to query params;
  `FilmEditorPage` syncs `sel`, `view`, `scope`, `res`. Deep links become real:
  `/p/next-year/shot/B10-S2?tab=generate&sub=still`. (Also fixes a long-standing UX gap.)

### 3.4 Shot resolver + cast index (`web/src/agent/resolve.ts`; server: importer + one route)

- Server: the importer reads `prompts/characters.jsonl` when present and stores
  `project.settings.cast = [{ id, name, aliases[], descriptor }]` (aliases = name tokens plus
  role words after the em dash: `"Ada Lovelace — the veteran engineer"` → `ada`, `lovelace`,
  `engineer`, `veteran engineer`). New route `GET /api/projects/{pid}/cast`. A one-off `cutroom reimport-cast
  <project> <src_root>` refreshes existing projects without re-importing media.
- Client: `ShotResolver.index()` loads `/film` + `/cast` once (SWR-cached) and derives per shot:
  `ordinal` (1-based film order), `beat`, `act`, `type`, `characters` (cast aliases found in
  `image_prompt`'s subject clause or `dialogue[].character`), `summary` (first 90 chars after
  "Subject:" if present, else of `image_prompt`).
- `resolve(query)` scoring, in order: exact sid (`B10-S2`, case-insensitive, `B10 S2`) →
  ordinal (`37`, `#37`, `shot 37`) → beat (`B10`, `beat 10`) → cast alias hits → shot-type words
  (`close-up|cu|hero` → HERO, `wide|tableau|establishing` → STILL) → free-text token overlap with
  `image_prompt`/`register`/`render_notes`. Returns `{ best, candidates[≤8], confidence:
  "exact"|"high"|"ambiguous"|"none" }`. When a query contains *both* an ordinal and a name that
  disagree (the hero sentence above), confidence is `ambiguous` and both are returned with reasons.
- Unit tests pin: `"37"` → `B11-S4`; `"the David Ross close-up"` → `B10-S2` first;
  `"David Ross close up, shot 37"` → ambiguous with both.

### 3.5 Human surfaces: ⌘K palette and "show me" (`web/src/agent/Palette.tsx`)

- ⌘K / Ctrl+K opens a palette listing every registry entry: title · `where.label` · howTo on
  focus. Fuzzy filter over title/keywords/description. Enter on an arg-less action performs it;
  on an action needing args, it navigates to `where` and pulses the anchor so the human
  finishes by hand. Recent actions float up (localStorage).
- `show_me` tool (§4) is the agent-side twin: it explains where a feature lives, navigates there,
  pulses it, and returns `howTo`.

### 3.6 Jobs pattern (`web/src/agent/jobs.ts`)

- `submitAndSettle(jobIds, { settleMs })`: waits up to `settleMs` (default 8 s; mock finishes in
  <1 s) via the existing SSE `GET /api/jobs/{id}/watch`; returns per-job
  `{ job, status, takes?: [{path, thumb}] }`. Beyond the window: `status:"running"` and the hint
  "call wait_for_jobs".
- `wait_for_jobs` tool caps at 60 s and honours `signal` (bridges time out around 65 s).

### 3.7 Cost & doctrine guard (`web/src/agent/guard.ts`)

- Before any generation: resolve the effective backend for the lane (`GET /api/lanes` +
  `GET /api/projects/{pid}/lanes` + explicit arg) and classify `free` (mock, local comfyui) vs
  `paid` (fal, replicate, openai-images, openrouter-image, elevenlabs). Paid without
  `confirm_cost: true` → `{ ok:false, error:"needs_confirmation", backend, cost_class,
  hint:"re-call with confirm_cost:true" }`. An explicitly disabled backend → the server's 400
  passes through as a descriptive error.
- Doctrine defaults: `animate` uses 49 frames + `freeze_after: 1.0` unless overridden; no zoom
  parameter exists; `freeze_tail` refuses stills with the server's own guard message.

  > **Amended 2026-09-02 (workstream N).** `animate` now takes `seconds` and derives frames
  > from the motion backend's `motion_profile`; `freeze_after` is applied **only** when a
  > caller passes `live_seconds` (or `freeze_after`) explicitly. `generate_takes` reports the
  > profile it used. The no-zoom rule and the `freeze_tail`-on-stills guard are unchanged.

### 3.8 Demo mode + hosting (server `config.py`, `main.py`, new `cutroom/demo.py`)

- `CUTROOM_DEMO=1`: backend create/edit/delete, project import, comp delete and pause endpoints
  return 403 with a friendly message; every lane is pinned to `mock`; job submissions are
  rate-limited per IP (60/min) ; the Settings page shows a "demo instance" banner. Everything
  else (generation via mock, freezes, trims, comps, cut-the-film via ffmpeg) works for real.
- `CUTROOM_DEMO_BUNDLE=<url>`: at boot, if no projects exist, download a `.tar.zst` studio-folder
  bundle (shots.jsonl, characters.jsonl, curation, overrides, renders/, audio/) into
  `$CUTROOM_DATA/demo-src` and run the importer as project `next-year`, then warm thumbs.
  The bundle is built by `cutroom demo-bundle <studio-folder> <out.tar.zst>` (excludes assembly/
  and anything >25 MB; expected ~300 MB) and attached to a GitHub Release of the public repo.
- Hosting: **Railway** (the author's account is connected via MCP; `deploy/Dockerfile` already builds
  the SPA + server; mount a volume at `/data`; `CUTROOM_HOST=0.0.0.0`, `CUTROOM_DEMO=1`,
  `CUTROOM_DEMO_BUNDLE`, `CUTROOM_AUTH_TOKEN` empty). Railway provides the HTTPS domain WebMCP
  requires. Fallback: Render (sponsor credits) with the same image.

## 4. Tool catalogue v1 (16 tools)

All app-level unless marked page-scoped. `shot` args accept sid, ordinal, beat or a description.

| # | name | annotations | arguments | where it executes (visibly) | returns |
|---|---|---|---|---|---|
| 1 | `find_shots` | readOnly | `query` (string) | none (silent) | candidates ≤8: sid, ordinal, beat, act, type, summary, characters, has_keeper, has_motion, plays; confidence |
| 2 | `describe_shot` | readOnly | `shot` | none | prompts, dialogue, seconds, keeper, active source, takes by kind (counts + latest 5 paths with thumb URLs), comps, lane defaults with cost class |
| 3 | `get_context` | readOnly | — | none | route, project, current shot/tab/sub/selected take, running jobs, WebMCP mode, agent speed |
| 4 | `list_features` | readOnly | `query?` | none | registry entries (name, title, where.label, howTo) — includes palette-only features so the agent can teach them |
| 5 | `show_me` | — | `feature` (string) | navigates to the feature, pulses its control | `howTo`, where.label, what is now on screen |
| 6 | `open_shot` | — | `shot`, `tab?` enum, `sub?` enum, `take?` | Film Editor strip → Shot Editor → tab → sub-tab | resolved sid, what is visible |
| 7 | `generate_takes` | consequential | `shot`, `lane` enum still/restyle/animate, `count` (1–4, default 3), `prompt?`, `prompt_mode?` enum replace/append, `source_take?`, `denoise?`, `region?` [l,t,r,b], `frames?`, `backend?`, `model?`, `confirm_cost?` | Shot Editor → Generate → sub-tab; fills prompt/seeds/denoise; submits N times with distinct seeds | jobs[], backend, cost_class, settled takes with thumbs, hint |
| 8 | `freeze_tail` | consequential | `shot`, `take?`, `live_seconds` (default 1.0) | Motion edits tab; sets live; submits | job, settled take |
| 9 | `trim_clip` | consequential | `shot`, `take?`, `end_seconds` | Motion edits tab | job, settled take |
| 10 | `select_take` | — | `shot`, `take` (path or "latest"/"newest still"/"keeper") | takes rail → monitor | selected path, kind, duration |
| 11 | `set_keeper` | consequential | `shot`, `take?` (default selected), `note?` | ★ on the take | applied, previous keeper (history kept) |
| 12 | `set_timeline_source` | consequential | `shot`, `take?` | ⬆ on the take (or clear) | applied, what plays now |
| 13 | `set_shot_timing` | consequential | `shot`, `seconds?`, `vo_offset?`, `mute_vo?` | Film Editor quick panel (or Audio tab) | applied override |
| 14 | `synthesize_vo` | consequential | `shot`, `text?`, `voice?`, `treatment?` (none\|radio\|phone\|megaphone\|hall, default none), `confirm_cost?` | Audio tab; fills; submits | job, settled take, treatment |
| 15 | `direct_shot` | readOnly (plan only) | `shot`, `instruction` | Direct box; types; compiles → PlanPreview shown | the EditPlan (ops with summaries) or a 422 message; nothing runs |
| 16 | `apply_plan` | consequential | `shot`, `plan` (from 15) | ▶ apply plan | jobs[], applied ops |
| 17 | `cut_film` | consequential | `scope` enum full/act1..4, `res` enum 720/1080 | Film Editor → Cut the film | job; on settle: animatic path + duration |
| 18 | `get_jobs` | readOnly | `jobs?` (ids) | none | status, log tail, result paths |
| 19 | `wait_for_jobs` | readOnly | `jobs`, `timeout_s` ≤60 | none (progress visible in topbar/Jobs) | statuses, take paths |
| 20 | `generate_music` | consequential | `prompt`, `seconds?` (5–120, default 30), `instrumental?`, `shot?`, `start?`, `gain?` (dB), `fade_in?`, `fade_out?`, `place?`, `backend?`, `confirm_cost?` | Shot Editor → Audio → Music & SFX; fills the music console; ▶ music; then the cue lands on the shot's cue list and the Film Editor cue strip | job, take, backend, cost_class, the placed cue (id, film time, gain) |
| 21 | `generate_sfx` | consequential | `shot`, `prompt`, `seconds?` (1–10, default 3), `offset?`, `gain?` (dB), `prompt_influence?`, `place?`, `backend?`, `confirm_cost?` | Shot Editor → Audio → Music & SFX; ▶ sfx; cue pinned to the shot | job, take, the placed cue |
| 22 | `place_cue` | consequential | `kind?` (inferred from the path), `take`\|`path`, `shot`\|`start`, `offset?`, `duration?`, `gain?`, `fade_in?`, `fade_out?`, `loop?`, `label?` | Film Editor → cue strip | the cue with its id and resolved film time |
| 23 | `list_cues` | readOnly | `kind?`, `scope?` | none | the cue sheet: film time, file, shot, gain in dB, length; ids for removal |

| 24 | `add_cel_layer` | consequential | `shot`, `region` [l,t,r,b] (plate px or 0-1), `prompt`, `frames?` (49), `comp?`, `background?`, `confirm_cost?` | Shot Editor → compose; draws the region on the stage, fills the motion prompt, ▶ add layer & generate cel | comp (created from the keeper, or `background`, when absent), layer id, snapped region, true plate dims, job |
| 25 | `reroll_layer` | consequential | `shot`, `layer` (id\|"newest"\|"selected"), `prompt?`, `seed?`, `backend?`, `model?`, `comp?`, `confirm_cost?` | Cel workbench → layer → 🎲 reroll (or 🎛 directed reroll) | job; the old cel stays as a variant |
| 26 | `restyle_background` | consequential | `shot`, `prompt`, `mode?` edit\|regen, `strength?`, `comp?`, `confirm_cost?` | Cel workbench → Background console | job, lane, previous plate, layers kept. Refused on a clip background |
| 27 | `set_background` | consequential | `shot`, `take` (path or "keeper"/"newest motion"/"plays"), `comp?` | Cel workbench → Background → stored plates | background, `background_kind` still\|video, previous |
| 28 | `set_layer` | consequential | `shot`, `layer`, `opacity?`, `z?` front\|back\|number, `matte?` window\|figure, `region?`, `comp?` | Cel workbench → layer card controls | applied patch + the before values. ONE write, so the auto-render debounce renders once |
| 29 | `remove_layer` | consequential | `shot`, `layer`, `comp?` | Cel workbench → layer → remove | removed id, layers left; the clips stay as takes |
| 30 | `render_comp` | consequential | `shot`, `comp?`, `promote?` | Cel workbench → ▶ render composite (then ⬆ use in timeline) | job, rendered take, what plays now |
| 31 | `list_layers` | readOnly | `shot`, `comp?` | none | comps with background + `background_kind`, duration, stored plates, and each layer's region/prompt/z/opacity/matte/variant count |
| 32 | `list_backends` | readOnly | — | none | id, type, lanes, enabled, key set, cost class and cost_usd; plus the project's lane defaults. Never probes |
| 33 | `set_lane_default` | consequential | `lane` enum, `backend`, `model?` | Settings → Lane defaults | the new default; a demo's 403 text is relayed verbatim |
| 34 | `export_timeline` | readOnly | `format?` otio\|edl | Timeline → export links | download URL, byte count, event count and a 300-char preview |
| 35 | `render_timeline` | consequential | `scope_sec?`, `container?` | Timeline → render via engine | job; `engine offline` (cleanly) when the engine is not configured |

| 36 | `create_project` | consequential | `id?` (slug), `title`, `fps?` | Projects → New empty project; types the slug, presses create, then opens the new Film Editor | project id, url, the lane defaults it inherited |
| 37 | `write_script` | consequential | `project?`, `shots[]` (sid?, beat?, act?, type?, seconds?, register?, image_prompt, negative?, motion_prompt?, narration?, dialogue?, sfx?, ambient?, cut?, render_notes?), `replace?` | Film Editor → the strip; one batch POST; then the first shot's Script tab | count, sids, total_seconds, and what to call next |
| 38 | `set_project_cast` | consequential | `project?`, `characters[]` ({id?, name, descriptor, aliases?}) | Film Editor (the cast index is not a screen) | the cast with the aliases it derived |
| 39 | `list_projects` | readOnly | — | none | every film: id, title, shot count, paused, url |

| 40 | `play_cut` | — | `project?`, `cut?` ("latest" \| file name \| index from newest, 1 = newest), `from?` (seconds \| "mm:ss" \| shot sid \| "act2" \| "start"/"end" \| a description), `to?` (seconds), `muted?` | Film Editor → Cuts → the poster pulses → the screening room opens over it | cut, duration, from, from_meaning, now_playing_shot, chapters (count); `needs_click:true` when the browser refused autoplay |
| 41 | `play_take` | — | `shot`, `take?` (same words as `select_take`), `from?` | Film Editor (shot selected) → the screening room | shot, take, kind, is_still, seconds, from |
| 42 | `stop_playback` | — | — | Screening room → ✕ close | was_playing, closed, stopped_at. Safe when nothing is playing |
| 43 | `preview_timeline` | — | `project?`, `from?` (same grammar), `play?` (default true), `scope_sec?` | Timeline → playhead to `from`, clip selected, ▶ | from, now_playing_shot, duration, clips, note ("live compiled preview, video only; use play_cut for the rendered cut with audio") |
| 46 | `set_style` | consequential | `preset?` enum anime-cel/anime-noir/anime-pastel, `prefix?` (custom look), `avoid?` (the negative every still carries), `refs?` (style-reference frames; `[]` turns reference conditioning off), `project?` | Film Editor header → the style chip (`film.style`) names the register; its prefix is the hover title | project, the register (name, prefix, avoid, ref count) |
| 47 | `attach_reference` | consequential | `shot`, `image` (a take path, "keeper of B02-S2", "newest still of B04-S2", "plays", or an http(s) url the server fetches), `role?` enum character/prop/setting/style, `note?` | Shot Editor → Generate → References strip (`shot.gen.refs`, one item `shot.gen.ref[data-path]`) | shot, the reference (image, role), what the role means, the whole strip |
| 48 | `remove_reference` | consequential | `shot`, `image?` (path, file name, or "all"), `role?` (drops every reference in it) | Shot Editor → Generate → References → ✕ (`shot.gen.ref.remove`) | shot, how many went, the strip as it stands |
| 49 | `list_references` | readOnly | `shot` | Shot Editor → Generate → References | the references with roles, slots left (4 is the cap) |

(19 rows because status/wait and select/keeper/source are kept atomic per Chrome guidance;
"16" was the working count — the number is not load-bearing. Stay under ~25 for v1.
Rows 20–23 are workstream H's music/SFX set, appended 2026-09-01 — 23 tools total.
Gain is decibels in every cue argument; cues live in `settings.music_cues` /
`sfx_cues` and the assembler mixes them into the cut. See docs/BACKENDS.md.
Rows 24-35 are workstream I's cel workbench and lane/export set, appended
2026-09-01 — 35 tools total. The comp tools drive `CompEditor` through new
`CompPageHandles` (`kind: "comp"`, registered alongside the page it mounts in);
regions are TRUE background pixels snapped to /32, and a comp background may be
a still plate or a clip.
Rows 36-39 are workstream K's "start a film from nothing" set, appended
2026-09-02 — 39 tools total. They exist because a judge asked the site to
"build a new comical short anime about the French Revolution" and there was no
tool that made a project or wrote a shot. Server side: `POST /projects` is
viewer-allowed in demo mode under `CUTROOM_DEMO_PROJECTS_PER_TOKEN` (3 per
rolling 24 h, admin exempt) and applies `CUTROOM_LANE_*` to the new project so
a fresh film never falls through to "first enabled backend"; new
`POST /projects/{pid}/shots/batch` upserts a whole script in order (order_idx =
position, sids auto-assigned `B01-S1…` one beat per act, seconds 2-20 default
6, 300 s and 40 shots the ceilings); `POST /projects/{pid}/cast` is
viewer-allowed too, since a visitor who just wrote a script has to be able to
name its cast and per-project ownership is not modelled. `write_script`'s
descriptions carry the house prompt style — setting sentence, "Subject: …",
framing, "cinematic anime film still", narration ≤ 25 words, dialogue ≤ 12 — so an
LLM that has never seen the app writes prompts the still lane can use.

Rows 40-43 are workstream M's screening room, appended 2026-09-02, for 43 tools
total. They exist because "play the film" produced a thumbnail-sized `<video>`
inside a Cuts-gallery card: the only playback surface an agent could reach was
a 300px poster. `ScreeningRoom` (`web/src/components/ScreeningRoom.tsx`, grown
out of `Spotlight`) is a full-viewport overlay driven by a tiny observable
store (`web/src/screen/store.ts`), so the gallery, the take rail and the tools
all open it the same way and the room hands its `<video>` back for a tool to
seek and press play. It registers `ScreenPageHandles` (`kind: "screen"`) while
open. It is an overlay, not a page, so `current()` still reports the editor
underneath. Its chapter strip is the cut's own EDL: the assembler now records
`meta.edl` on the animatic take, and `GET /projects/{pid}/cuts/{name}/edl`
serves it (recomputing from the film, minus audio-fit stretch, for cuts
assembled before that). Deep link: `?screen=<rel>&t=<seconds>` on any project
route. The `from` grammar is shared by all four tools and falls through to the
shot resolver, which is what makes "show me the film from the lighthouses" land
on a frame. Row 43 is the same problem on the Timeline, whose transport existed
only as palette-only registry rows: `TimelinePageHandles` (`kind: "timeline"`)
exposes it in seconds, so nothing has to know the fps.)

Row 46 is workstream P's style register, appended 2026-09-02 (44-45 are
workstream N's `plan_motion` / `apply_motion_plan`, numbered here but not yet
written into this table). It exists because the same judge who asked for a
French Revolution short got western political cartoon out of the still lane:
the agent had written "hand-painted 2D satire" and "caricature" into its own
prompts, and nothing server-side had an opinion about how the film should look.
The look is now a project fact — `project.settings.style`, seeded on every new
project, applied to every still and i2i, exposed as `GET`/`POST
/api/projects/{pid}/style` (viewer-allowed, like casting). `create_project`
takes a `style`; `write_script`'s description and its `image_prompt` field now
say plainly not to write style words or ask for text in frame; `describe_shot`
and `get_context` both report the register by name, so an agent that reads the
room knows the look is already handled. See docs/ARCHITECTURE.md "Style
register" and the measured a/b/c in
docs/research/style-register/RESULTS.md.

### Feature registry (`web/src/agent/features.ts`, `features.screen.ts`)

A tool executes; a **feature** teaches. Every user-facing action that is not a
tool — 111 of them, from ⏸ pause to the cel workbench's ⌘Z undo to the options
JSON on a backend card — is registered as a palette-only `ActionDef`
(`surfaces: { agent: false }`) carrying `title`, a one-sentence description,
`where` (route + query + anchor + label), `keywords`, `howTo` and a `group` (the
screen it lives on). Its `execute` is the shared `walkTo`: navigate to `where`,
pulse the anchor, return the how-to. So `list_features` and `show_me` cover the
whole application (146 registry entries: 35 tools + 111 features) rather than the
subset that happens to be automatable, and ⌘K lists every one of them.
`list_features` with no query returns the 35 tools plus a count per screen; with
a query it searches everything and flags palette-only rows. A unit test
(`web/src/agent/__tests__/features.test.ts`) asserts that every anchor in the
registry — tools included — is actually rendered as a `data-action` somewhere in
`web/src`, which is the one failure that is invisible in the browser.
`features.screen.ts` (workstream M) adds three more, merged into `ALL_ACTIONS`
from `tools/index.ts` alongside `FEATURES`: "Screening room" (opens the newest
cut), "Next / previous chapter" and "Close the screening room". They are a
separate file because they act rather than walk: the room is an overlay, so
there is no route to navigate to.)

**Descriptions** are written by workstream C to the budgets, in the verb-first house style,
e.g. `generate_takes`: "Generate new takes for a shot in Cutroom — stills, restyles of an
existing take, or animated cel clips. Opens the shot's Generate console on screen, fills it,
and submits one job per take with a fresh seed. Returns job ids and, when the backend is fast,
the finished takes. Paid backends require confirm_cost."

**v2 (post-challenge)**: shipped as rows 24-35 above, except `chain_beats` and
`separate_figure` (SAM points), which remain palette-only features.

## 5. Hero journeys (these are also the evals)

| # | Human says | Expected tool sequence | Visible result |
|---|---|---|---|
| J1 | "Make a few more generative cuts of the David Ross close-up." | `find_shots("David Ross close-up")` → `B10-S2` (high) → `generate_takes(shot:"B10-S2", lane:"still", count:3)` | Film Editor → Shot Editor B10-S2 → Generate → Still; prompt fills; 3 submits; 3 new stills appear in the rail; trail shows 5 steps |
| J1b | "…the David Ross close up, shot 37" | `find_shots` → ambiguous (`B10-S2` by name, `B11-S4` by number) → agent asks which | nothing runs until the human answers |
| J2 | "Keep the first second of the newest one and freeze the rest." | `select_take(shot, "newest motion")` → `freeze_tail(shot, live_seconds:1)` | Motion edits tab opens; live=1; ❄ pulses; new frozen take |
| J3 | "How do I do that by hand?" | `show_me("freeze tail")` | navigates + pulses ❄, returns howTo |
| J4 | "Cut act 1 at 720." | `cut_film(scope:"act1", res:"720")` → `wait_for_jobs` | Cut button pulses; animatic appears in Cuts gallery and plays |
| J5 | "Hold his pose for the rest of the line on the dial shot." | `find_shots("dial shot")` → `direct_shot(instruction)` → plan preview → human clicks apply (or agent `apply_plan` after confirmation) | the film's own grammar produces the plan on screen |
| J6 | "Make this take the keeper and use it in the timeline." | `set_keeper` → `set_timeline_source` | ★ then ⬆ pulse; Film Editor shows the new pick |

## 6. Workstreams and agent briefs

Six Opus sub-agents plus the architect. Each agent works in its own git worktree of the public
repo (§6.D creates it at T+0), commits small, runs its tests before reporting, and reports with
a diff summary + test output. **File ownership is exclusive**; cross-cutting edits go through
the architect. All agents read this plan and both research briefs first.

### Architect (this session)
- Writes `web/src/agent/contract.ts` (§3.1 types + anchor constants + tool-name list) at T+0 so
  everyone imports the same contract. Freezes it at G0.
- Runs gates, integrates worktrees, resolves conflicts, keeps this doc's "results" log.

### A — URL state, page handles, registry core, bridge, trail, palette (front-end spine)
- **Owns**: `web/src/agent/{registry,webmcp,pageHandles,presence,Palette,jobs,guard}.ts(x)`,
  edits to `App.tsx`, `main.tsx`, `ShotPage.tsx`, `FilmEditorPage.tsx`, `styles.css`,
  `ModelPicker.tsx` (anchor attrs only).
- **Deliverables**: query-param state sync (§3.3); `data-action` anchors everywhere in the
  vocabulary; `usePageHandles` for `shot` and `film`; registry + `perform` + `clip`; WebMCP bridge
  with feature detection + optional polyfill + debug hook; trail drawer + pulse; topbar chip;
  ⌘K palette; `speed` setting (`?agent_speed=fast`, localStorage).
- **Tests**: vitest unit tests for `registry` (name/description budgets, schema validity, clip),
  `pageHandles.waitFor` timeout, palette filtering. Manual: DevTools WebMCP pane lists tools on
  `http://localhost:8770` with the flag on.
- **Done when**: `open_shot` and `show_me` (stub tools registered by A for smoke) drive the UI
  visibly on localhost in Chrome 152 with the flag; `tsc` clean; vitest green.
- ~8 agent-hours. Starts T+0.

### B — Resolver, cast index, server additions, demo mode
- **Owns**: `web/src/agent/resolve.ts` (+ tests), `server/cutroom/importer/folder.py` (cast),
  `server/cutroom/api/projects.py` (`GET …/cast` only), `server/cutroom/demo.py`, `config.py`,
  `main.py` (demo boot hook), `server/cutroom/__main__.py`/CLI entries `demo-bundle`,
  `reimport-cast`, `server/tests/test_cast.py`, `test_demo.py`.
- **Deliverables**: §3.4 and §3.8 server side; rate limit; 403 lockouts; bundle builder;
  boot-time import from bundle.
- **Tests**: pytest for cast parsing (aliases from the real `characters.jsonl`), resolver pins
  (§3.4), demo-mode 403s, bundle round-trip on a tiny synthetic project.
- **Done when**: `cutroom demo-bundle` on the real film produces a ≤350 MB archive that boots a
  fresh data dir into a browsable `next-year` project with mock lanes; full pytest green.
- ~6 agent-hours. Starts T+0.

### C — Tool implementations
- **Owns**: `web/src/agent/tools/*.ts` (one file per tool group: `find.ts`, `navigate.ts`,
  `generate.ts`, `motion.ts`, `picks.ts`, `audio.ts`, `direct.ts`, `film.ts`, `jobs.ts`),
  `web/src/agent/tools/index.ts` (the catalogue), `web/src/agent/descriptions.md` (copy deck).
- **Inputs**: `contract.ts` (T+0), page-handle names (fixed in this plan), resolver API.
  Until A lands, C develops against a `fakeContext` and unit-tests execution logic.
- **Deliverables**: every §4 tool with description/schema to budget, `summarize`, `howTo`,
  `where`; cost guard use; settle logic; error envelopes with hints; ambiguity handling.
- **Tests**: vitest per tool with a mocked `ActionContext` (asserts navigation calls, handle
  calls, API bodies, result shape and size); the J1–J6 sequences as table tests over the
  resolver + tools with recorded `/film` fixtures.
- **Done when**: all tools pass unit tests and J1/J2/J4/J6 run end-to-end on localhost via
  `window.__cutroomAgent.call` against the mock backend.
- ~10 agent-hours. Starts T+0 (descriptions/schemas/tests first), integrates with A at G1.

### D — Repo, license, hosting, deploy pipeline
- **Owns**: repo scaffolding (`LICENSE`, `THIRD_PARTY_NOTICES.md` — the lifted FreeCut player
  in `web/src/runtime/` is MIT and needs its notice), `README.md` top section, `deploy/*`,
  Railway service + volume + env, GitHub Release with the demo bundle, `docs/PRIOR-WORK.md`
  skeleton (F finishes it), `.github/workflows/ci.yml` (tsc + vitest + pytest).
- **Sequence**: (1) split the platform subdirectory out of the private parent repository into
  a standalone `cutroom` working tree; `git init`;
  MIT `LICENSE`; first commit `"Cutroom — prior-work snapshot (built 2026-07-12..15)"`;
  **stop for the owner's approval before `gh repo create … --public --push`** (outward-facing).
  (2) Railway: create project/service from the Dockerfile, volume at `/data`, env per §3.8,
  `generate-domain`; deploy the snapshot to prove the pipeline before the WebMCP code exists.
  (3) When B's bundle exists: upload as a Release asset, set `CUTROOM_DEMO_BUNDLE`, redeploy,
  verify `https://<domain>/p/next-year` shows the film.
- **Tests**: `curl https://<domain>/api/health`; a Playwright smoke from E against the domain.
- **Done when**: public repo exists with a visible license; HTTPS URL serves the demo film;
  `git log` shows the snapshot commit before any WebMCP commit.
- ~6 agent-hours + waits. Starts T+0.

### E — Test harness, e2e, evals, cross-client checklist
- **Owns**: `web/vitest.config.ts`, `web/e2e/*` (Playwright), `web/package.json` devDeps/scripts,
  `docs/TESTING-WEBMCP.md`, `evals/journeys.json`.
- **Deliverables**: vitest wired (`npm test`); Playwright using **system Chrome 152 with
  `--enable-features=WebMCP,WebMCPTesting`** so tests hit the *native* API via
  `navigator.modelContextTesting` / `document.modelContext.getTools()`; fallback to
  `window.__cutroomAgent` when the API is absent (CI). E2E specs: tools registered ≥16; J1, J2,
  J4, J6 end-to-end against a server started in mock/demo mode on a temp `CUTROOM_DATA`; trail
  renders; deep links restore tab state. Evals file = §5 journeys with expected tool sequences,
  runnable by hand through `chrome-devtools-mcp` from Claude Code (document the command in
  TESTING-WEBMCP.md) and, if time, via GoogleChromeLabs' WebMCP Evals CLI.
- **Cross-client checklist** (manual, with the owner): DevTools WebMCP pane on localhost; Model
  Context Tool Inspector; ChatGPT Desktop site tools against the hosted URL; Claude Code via
  `chrome-devtools-mcp --categoryExperimentalWebmcp=true --autoConnect`.
- **Done when**: `npm test` + `npm run e2e` green locally; the checklist has dated ticks.
- ~8 agent-hours. Starts T+0 (harness), e2e specs land after G1.

### F — Submission package
- **Owns**: `docs/PRIOR-WORK.md`, `docs/SUBMISSION.md` (the four description answers, testing
  instructions for judges, links), `docs/VIDEO-SCRIPT.md` + a deterministic demo runbook
  (exact prompts, expected tool calls, reset steps), README "Drive Cutroom with an agent"
  section, YouTube description text, the Devpost form field contents.
- **Sequence**: draft at T+12h from this plan; finalize against the real build at G3; support
  the recording session at G4 (reset the demo instance, pre-warm thumbs, open the right windows).
- **Done when**: every Devpost field has final text in `SUBMISSION.md`; PRIOR-WORK cites the
  snapshot commit hash and the first WebMCP commit hash; the video runbook has been executed
  once end-to-end without surprises.
- ~6 agent-hours + ~2 h of recording.

## 7. Schedule and gates (Pacific time; T+0 = Tue 2026-09-01 16:00)

| Gate | When | Exit criteria |
|---|---|---|
| **G0 contract** | Tue 18:30 (T+2.5h) | `contract.ts` + anchor vocabulary + tool names frozen; repo snapshot committed; A/B/C/D/E running |
| **G1 local hero** | Wed 02:00 (T+10h) | J1 and J2 run on `http://localhost:8770` in Chrome 152 (flag on) through the DevTools pane or `chrome-devtools-mcp`; trail + pulse visible; vitest green |
| **G2 hosted** | Wed 12:00 (T+20h) | HTTPS URL serves the demo film in demo mode; tools register there; J1/J2/J4 verified in ChatGPT Desktop *or* flagged Chrome against the hosted URL; public repo pushed |
| **G3 complete** | Wed 20:00 (T+28h) | All v1 tools pass unit + e2e; palette + show_me polished; cross-client checklist ticked; PRIOR-WORK and SUBMISSION drafted; CI green |
| **G4 media** | Thu 08:00 (T+40h) | Video recorded and uploaded (public); description final; repo README final; last redeploy |
| **Submit** | **Thu 11:00 (T+43h)** | Devpost form submitted, 2 h before the 13:00 deadline; confirmation screenshot saved |

The owner's touchpoints: approve repo publish (T+1h), approve Railway deploy (T+2h), confirm
footage may be hosted publicly (T+1h), enable ChatGPT site tools + Chrome flags (any time before
G2), record the video (G3→G4), press submit.

## 8. Testing strategy (summary)

- **Registry contract tests** (vitest): every tool name matches the regex and ≤30 chars,
  description ≤500, every param description ≤150, `inputSchema` compiles, `where.anchor` exists
  in the anchor vocabulary, `howTo` present, `clip()` keeps outputs ≤1.5K.
- **Resolver tests**: the §3.4 pins plus beat/act/type queries and no-match behaviour.
- **Tool unit tests** with a fake context (C).
- **E2E in real Chrome with the native API** (E), against a mock/demo server on a temp data dir.
- **Server pytest** for cast import, demo mode, bundle (B); existing 115 stay green.
- **Evals** = §5 journeys; run by hand via `chrome-devtools-mcp` before G3 and recorded in
  `TESTING-WEBMCP.md`.
- **Manual cross-client checklist** before G3.

## 9. Submission package (what judges receive)

1. **Live URL**: the Railway HTTPS domain, demo mode, no login. Testing instructions: "Chrome
   149+: enable `chrome://flags/#enable-webmcp-testing` (and `#devtools-webmcp-support` to see
   the tool list under DevTools › Application › WebMCP), restart, open the URL. ChatGPT Desktop:
   Settings › Browser › Enable site tools, open the URL in the in-app browser, ask: *'Make a few
   more generative cuts of the David Ross close-up.'*"
2. **Repo**: public, MIT, README top section explains the agent layer with a 20-line code
   excerpt of `registerTool`, links to `docs/WEBMCP-PLAN.md`, `PRIOR-WORK.md`, `TESTING-WEBMCP.md`.
3. **Video (≤3:00)** storyboard — 0:00–0:15 the hero sentence typed into the agent; the UI
   navigates itself (Film Editor → shot → Generate → Still), three takes land, trail visible.
   0:15–0:40 the problem: a fast scroll through the ⌘K palette's ~100 features — "this is the
   Photoshop problem; nobody finds anything." 0:40–1:20 J2 + J3: freeze the tail; "show me how"
   pulses the control; the human repeats it by hand. 1:20–1:50 J4: cut act 1; the animatic
   plays. 1:50–2:30 how it's built: one registry → WebMCP tools + palette + show-me; execution
   through the UI; the same tools called from Claude Code via chrome-devtools-mcp. 2:30–2:50
   why it matters for every deep creative tool. Show working software in the first 10 seconds.
4. **Description**: four answers (draft in `SUBMISSION.md`): fit — a 97-action creative tool is
   exactly the discoverability problem WebMCP exists for; better UX — one sentence replaces six
   screens and teaches the UI while doing it; new together — director states intent, agent
   drives the room the director is looking at, plans are previewed before anything renders,
   cost is guarded; implementation — registry → `document.modelContext.registerTool`, visible
   execution through page handles, resolver, async job pattern, demo mode.
5. **PRIOR-WORK.md**: snapshot commit hash (all of Cutroom as built 2026-07-12..15) vs the
   WebMCP commits (2026-09-01..03); a file-level list of what is new.

## 10. Decisions for the owner (recommendation first; the plan assumes the recommendation)

1. **Public repo shape** — *Recommended*: a new `cutroom` repo holding the platform code at its
   root, with the film's script, style bible and prompts staying in the private parent
   repository. Alternative: publish the parent repository whole. The demo bundle is a Release
   asset, not tracked files.
2. **Host the film footage publicly on the demo instance** — *Recommended yes*; it is the
   author's own work, judges need real media, and the repo itself does not need it.
3. **Hosting** — *Recommended Railway* (connected, Dockerfile-ready, volume + HTTPS). Render as
   fallback.
4. **License** — *Recommended MIT* (matches the lifted FreeCut code).
5. **Primary demo client in the video** — *Recommended* ChatGPT Desktop's browser (the judges'
   own environment) for J1–J4, then a short Claude Code + `chrome-devtools-mcp` segment (the author's
   real workflow, and Alex Nahas will recognise the MCP bridge story). If ChatGPT site tools
   are unavailable on that account, the Model Context Tool Inspector with the flag is the
   fallback.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `document.modelContext` undefined on the demo URL (flag/OT confusion) | Topbar chip states the mode; judges' instructions name the exact flag; polyfill toggle available; the video shows it working regardless |
| ChatGPT's safety review blocks generation tools or demands confirmation | That is the human-in-the-loop story — show it once in the video; keep `readOnlyHint` accurate so reads are not gated |
| Tool executes while the human is on another page | Tools navigate first; `waitFor` page handles with timeout; error envelope explains |
| Unregister-aborts-execution on Chrome 152 | App-level registration; page-scoped tools only in v2 |
| Public demo abuse | Demo mode lockouts, rate limit, mock-only lanes, nightly reset from bundle |
| `GET /timeline` cold compile after mutations | Not on any v1 tool path |
| Agents editing the same files | Exclusive ownership in §6; architect integrates |
| Time | Gates with explicit cut lines: if G1 slips past Wed 06:00, drop `synthesize_vo`, `trim_clip`, `direct_shot`/`apply_plan` from v1 and keep the palette; if G2 slips past Wed 16:00, demo from localhost in the video and host a static preview — the live URL is still required, so hosting is the last thing to cut |

## 12. Post-challenge roadmap

- v2 tools (§4) including page-scoped comp-layer tools inside `CompEditor` and timeline edit
  verbs (`edits.ts` is already implemented and untested in UI).
- Server-side MCP twin: expose the same catalogue over the existing director provider so
  hosted Claude chat and WebMCP share one contract (FOUNDATION.md §7's "take the contract").
- Origin-trial token in `index.html` so the demo works without the flag once Chrome 157 ships.
- Progress reporting when the spec lands `reportProgress` (#196).
- Tool-usage analytics into the trail → "features the agent used that you never opened".

---

## Results log

*(the architect appends gate results here as they land)*

---

## Addendum A (the owner, 2026-09-01 16:05 PT) — real providers on the hosted demo, gated and capped

Supersedes the "mock-only" parts of §3.8. The hosted demo must do **real generation** for judges
at low cost, with the owner able to toggle providers without redeploying.

- **Direction lane → OpenRouter**, model GLM 5.3 Flash (near-free). Uses the existing
  `openai-chat` adapter with `base_url=https://openrouter.ai/api/v1`; the planner (`planner.py`)
  and director chat use it. Agent B verifies the exact OpenRouter model id via
  `GET https://openrouter.ai/api/v1/models` (expected `z-ai/glm-5.3-flash` or similar) and
  makes it an env var.
- **Still lane → cheap hosted image model** (OpenRouter image modality or fal flux-schnell class,
  ~$0.003–0.04 per image). **Motion lane → fal** (already integrated and keyed locally; Wan 2.2
  ≈ $0.20 per 5 s clip at 480p; agent B picks the cheapest model that still looks like anime
  motion and makes it env-configurable). **VO → ElevenLabs** (key exists). Everything not keyed
  falls back to `mock`.
- **Boot-time seeding from env** (`main.py seed_backends` extended): `OPENROUTER_API_KEY`,
  `FAL_KEY`, `ELEVEN_LABS_API_KEY` create/enable backends; `CUTROOM_LANE_<LANE>=<backend>:<model>`
  sets project lane defaults for the demo project (`still`, `i2i`, `motion`, `vo`, `direction`).
- **Toggleable without redeploy**: demo mode no longer freezes Settings; it splits roles.
  `CUTROOM_AUTH_TOKEN` = judge/viewer token (required; given in Devpost testing instructions;
  accepted via `?token=` in the URL so the judge link is one click — A adds the query-param
  intake in `App.tsx`). `CUTROOM_ADMIN_TOKEN` = the owner; only admin may edit backends/lanes/keys,
  import, delete, or pause. Judges can generate, edit shots, cut the film.
- **Spend cap**: `CUTROOM_DEMO_BUDGET_USD` (default 10) per rolling 24 h, tracked server-side
  from per-lane cost estimates (`options.cost_usd` on each backend, seeded from env
  `CUTROOM_COST_<BACKEND>=0.20`); when exceeded, paid lanes return 402 with a clear message and
  the WebMCP tools relay it (`{ok:false, error:"budget exhausted", hint}`); `mock` keeps working.
  Also: per-token limit of 12 paid jobs per hour; `generate_takes.count` ≤ 4.
- The WebMCP cost guard (§3.7) reads the backend's `cost_usd` and reports it in the
  needs-confirmation envelope: "3 stills on openrouter-image ≈ $0.12".

- **G0 (Tue 16:25 PT)** — the platform code initialised as its own repo; snapshot commit `cebcf93`;
  MIT LICENSE; `contract.ts` frozen (`b7d04e0`); Addendum A (real providers, gated + capped)
  folded in; workstreams A–F launched in parallel on Opus at ~16:25.
- **G1 (Tue 17:20 PT, ~9 h early)** — A/B/C/E/F all landed. Hero journey J1 runs on
  `http://localhost` in Chrome 152 through the **native** `document.modelContext`
  (`--enable-features=WebMCP` alone suffices; `navigator.modelContextTesting` does not exist in
  152, so the harness drives `document.modelContext` from page script). 19 tools registered;
  253 web unit tests, 153 server tests green; Playwright 19/21 (soft: animatic gallery after
  cut_film). Architect fixes: `clip()` no longer truncates identifiers and flags `truncated`;
  `list_features` lists every tool compactly instead of the first 12. Hosting (D) is blocked on
  Railway's builder for this workspace; GHCR image workaround built, waiting on the owner for package
  visibility or a packages-scoped token.
- **Safety pass before going public (Tue 17:40–18:05 PT)** — history and tree scanned for
  secrets: clean. A recorded test fixture held the film's full shot list (prompts, dialogue,
  render notes); history rewritten to purge it, a sanitized fixture committed, the full
  recording kept private in the parent repository (`prompts/fixtures/`) with real-data pins skipping when
  absent. Demo bundle moved off the code repo to the private `cutroom-demo-data` release;
  `CUTROOM_DEMO_BUNDLE_TOKEN` (fine-grained, contents:read on that repo only) is now
  permanently required. Docs checked for quoted dialogue: none. Residual: GitHub keeps
  force-pushed commits reachable by hash until GC — recommended a fresh repo before the flip.
- **Go public (Tue 18:20 PT)** — the owner deleted the original repo; recreated
  `github.com/ryan-the-brodsky/cutroom` PUBLIC from the clean history (MIT detected). CI now
  publishes `ghcr.io/ryan-the-brodsky/cutroom-demo:latest` (fresh package). Demo data stays
  private on `cutroom-demo-data`; boot import needs `CUTROOM_DEMO_BUNDLE_TOKEN`.
- **Production drive (Tue 18:50–19:05 PT)** — hosted demo live at
  https://cutroom-production-0f3c.up.railway.app (image pinned by sha tag; source detached; two
  Dockerfile bugs fixed by D: SPA dropped by setuptools, healthcheck port). Seeded a NEW film
  over the API (`scripts/seed-film.py`): *Two Claudes*, 15 shots / 120 s, written from This
  American Life #896 Act Two "Escape Claudes" (2026-08-28). Drove it through the **native**
  `document.modelContext` from real Chrome (`web/scripts/agent-drive.mjs`): first still landed
  via Gemini Flash Image in 10 s ($0.04), keeper set, UI visibly navigated. Bugs found and
  fixed in the loop: VO lane had no voice (set River, ElevenLabs); `synthesize_vo` reported
  ok on a failed job; single-job tools lacked `jobs[]` for `wait_for_jobs`; resolver ignored
  ordinal words ("the first shot"); `POST /projects/{pid}/cast` added for API-created projects.
  Full 120-step run launched at 19:05 PT.
- **First full production cut (Tue 19:10 PT)** — 120 tool calls through native WebMCP produced
  `assembly/animatic-full-720p.mp4` (124 s, 15 shots, 11 VO tracks) for *Two Claudes* on the
  hosted demo: Gemini stills ≈10 s each, ElevenLabs lines ≈6 s, spend $0.76. Five shots were
  slates and both fal motion clips died: the container (**1 GB memory limit**) hit the limit
  and restarted, orphaning in-flight jobs ("worker task lost"). Also found: admin token was
  rate-limited like a judge; page handles hid the server's 429 text; "newest motion" matched a
  crop intermediate; `wait_for_jobs` rejected job objects. All four fixed (1ec04b0); memory
  limit raise + cpu pool 1 delegated to D; retry runs staged for the 5 slates + 3 motion shots.
- **Production cycle 2 (Tue 19:15–19:45 PT)** — Railway workspace is an inactive Hobby trial:
  memory hard-capped at 1 GB, volume at 500 MB, source builder dead (D verified via the
  limits API; a paid plan clears all three). Within the cap: cpu pool 1, CPU 2 vCPU, and the
  full-frame cel path now streams through ffmpeg instead of the in-memory compositor. Result:
  fal motion clips land without restarts (B02-S2, B04-S2 with the doctrine freeze). Slate
  shots re-generated (5 stills + 5 VO, zero failures). Found + fixed: `set_timeline_source` /
  `set_keeper` ignored the monitor selection; run steps double-froze. Finishing run + re-cut
  in flight. New workstream H: ElevenLabs music + SFX as film cues and WebMCP tools (the owner).
- **Cut 3 (Tue 19:58 PT) — the loop closes.** *Two Claudes* assembled with every shot
  generated (15 stills, 3 fal motion bursts with doctrine freezes playing as timeline sources,
  15 ElevenLabs lines), no slates, entirely through native WebMCP tool calls from real Chrome
  against the hosted demo. Last fix: `set_timeline_source` captured the monitor selection
  before navigating. Total production spend ≈ $1.3.
- **Music & SFX (Tue 20:25 PT, workstream H)** — cue sheet API (`/cues`), assembler mixes
  music/SFX cues with dB gain, fades, loop and shot anchoring (RMS-verified test), four new
  tools (`generate_music`, `generate_sfx`, `place_cue`, `list_cues`; 23 total), "Music & SFX"
  section on the Audio tab and a cue strip under the Cuts gallery. ElevenLabs live: 10 s music
  in 4 s, 3 s SFX in 2.4 s. Restricted keys now pass the health probe. Score run on the hosted
  *Two Claudes* in flight (120 s bed + 3 SFX + cut 4).
- **Cut 4, scored (Tue 20:40 PT)** — `generate_music` (120 s instrumental bed, -18 dB, fades)
  + three `generate_sfx` cues anchored to shots + `cut_film`: 13 tool calls, zero failures,
  through native WebMCP on the hosted demo. ElevenLabs music for 120 s returned in 17 s.
- **Cut 5, scored properly (Tue 20:55 PT)** — first score pass was buried (tool default -16 dB
  on a -17 dB RMS bed); re-placed at -8 dB via `place_cue` + `cut_film`; residual score level
  now ≈3 dB under the VO. Tool defaults changed to -8/-4 dB. Spend to date ≈ $1.5.
- **Regression pass (Tue 21:35 PT)** — full Playwright suite in real Chrome: the three real
  failures closed (`list_features` now returns every tool as a structured row under a
  per-tool `outputLimit`; the Film Editor's refresh handle awaits its refetches so `cut_film`
  shows the animatic; Cuts gallery items carry `data-cut`); the bundled-Chromium annotation
  check is skipped by design. 300 web unit tests, 166 server tests green. Submission package
  finalized by F (only `<YOUTUBE_URL>` open); B-roll kept outside this repo.
- **Workstream I launched (Tue 22:05 PT, the owner: "Go")** — cel workbench tools (add/reroll/
  restyle/set/remove layer, render_comp, list_layers), lane/settings/export tools, and a
  palette-only registry entry for every remaining UI action (~97 → all discoverable via ⌘K,
  `list_features`, `show_me`). Memory gate on region composites for the 1 GB demo box.
- **Video backgrounds (Tue 22:15 PT, the owner)** — comps must support a moving background under
  moving cels. Today `render_comp` opens the background with PIL (stills only). Added to
  workstream I: streaming compositor with video backgrounds (loop/hold), API + UI + tools
  (`add_cel_layer.background`, `set_background`), moving-background test.
- **Workstream I landed (Tue 23:00 PT)** — 12 new tools (35 total): cel workbench (add/reroll/
  set/remove layer, restyle_background, set_background, render_comp, list_layers) and lanes/
  export (list_backends, set_lane_default, export_timeline, render_timeline). 111 palette-only
  registry entries (146 in all) so ⌘K, `list_features` and `show_me` cover every UI action.
  Compositor now streams through ffmpeg pipes and accepts a VIDEO background (loop/hold);
  moving-background test green; peak RSS 131 MB python / 174 MB ffmpeg. 423 web + 170 server
  tests. Pinned `sha-685034c`; production cel run (still bg + video bg) in flight.
- **Video-background comp on the box (Tue 23:40 PT)** — production run: still-background cel
  worked end to end (24 s cel, 6 s render); the clip-background comp died with a silent
  `BrokenPipeError` in the streaming encoder. Fixed (I, `ad8a00b`): encoder stderr captured
  into `FFmpegError` (Jobs log now carries ffmpeg's words, incl. "killed by signal 9" = OOM),
  even-dim rounding, size-proof background frames, `CUTROOM_ENCODER_THREADS` (2 on the demo
  box; x264 child 310 → 251 MB), `render_comp` settles 45 s. Also: OpenRouter image lane now
  requests 16:9 (`image_config.aspect_ratio`, verified 1344×768). Retry run in flight.
- **Video-on-video verified on the box + Railway upgraded (Tue 23:55 PT)** — retry run: cel over
  a clip background generated (41 s), rendered and promoted (24 s), cut 7 done, zero failures.
  The owner subscribed to the paid Railway plan; service limits raised to **8 GB / 8 vCPU**
  (`serviceInstanceLimitsUpdate` accepted); `CUTROOM_CPU_POOL_SIZE=2`, `CUTROOM_ENCODER_THREADS=4`.
  Volume still 500 MB; growing it next.
- **Judge-path test (Wed 09:30 PT)** — Ryan drove the hosted demo from ChatGPT Desktop's
  built-in browser: the page chip read "35 tools · native", ChatGPT described the app from
  `list_features`, then asked for a brand-new film and hit the admin gate on project creation
  (friendly message, as designed). Decision: judges must be able to start a film from nothing.
  Workstream K: `create_project` (viewer-allowed, capped per token), `write_script` (batch shot
  upsert), `set_project_cast`, `list_projects`. Public-facing scrub (J) landed and pinned.
- **Start a film from nothing (Wed 2026-09-02 09:30 PT, workstream K)** — four tools
  (`create_project`, `write_script`, `set_project_cast`, `list_projects`; 39 total),
  a viewer-allowed capped `POST /projects`, and `POST /projects/{pid}/shots/batch`.
  Live check on a scratch demo instance with the VIEWER token, through the native
  `document.modelContext` in real Chrome: empty server → project → a 6-shot
  satirical French Revolution script (38 s) → cast → mock still → mock VO →
  `assembly/animatic-full-720p.mp4`. Seven calls, zero failures. The project cap
  answered the fourth create with its own 429 text.
- **Wed 11:20 PT — four workstreams landed and pinned (`sha-1d6a5f7`)**: K (`create_project`
  capped per judge token, `write_script` batch upsert, cast, list; viewer can start a film from
  nothing), L (per-shot audio plan + Web Audio mix in the monitor; stills play as held frames),
  M (screening room with chapters and deep links; `play_cut`, `play_take`, `stop_playback`,
  `preview_timeline`), N (motion profiles per backend, no default freeze, `plan_motion` /
  `apply_motion_plan` / `/spend`, fal bake-off + a two-model motion registry the agent picks
  from per shot: Seedance when the budget allows, Wan as the cheap floor and for dark
  close-ups). 45 tools. Suites: 607 web, 223 server. Landing page
  + `/app` move (O) in progress.
- **Wed 11:55 PT — the mock lane is gone from the hosted demo.** ChatGPT, starting a film from
  nothing, reasoned its way to the free instant test backend and built 13 mock stills. Ryan:
  judges must never see it. Disabled live; boot seeding no longer forces it on in demo mode
  (`CUTROOM_DEMO_MOCK=1` opts in for local tests); viewers only see enabled backends. Per-token
  caps removed (only the daily spend cap remains, $15). Bake-off delivered (Wan turbo default).
- **Wed 12:40 PT — the origin film is out of the platform (workstream Q).** Cutroom was
  extracted from one film whose narration was a radio broadcast, and the film's own
  vocabulary had become the product's: a shot column literally called `radio`, and a
  "radio futz" checkbox as the only thing you could do to a voice. A judge's agent wrote a
  French Revolution script into a field called `radio`. Two renames, both back-compatible
  for one release. **`radio` → `narration`** on the Shot row (§4 rows 14 and 37 above):
  `db.migrate_db()` runs on every boot, adds the column and copies the old one across; the
  importer, `POST /shots` and `POST /shots/batch` accept either spelling and write
  `narration`; `GET /shots/{sid}` and `/film` return both. **`futz` → `treatment`** on
  `POST /generate/vo` and `synthesize_vo`: a named chain the line is heard through, one of
  `none` (default) · `radio` · `phone` · `megaphone` · `hall`, implemented in
  `engine.audio` over the primitives the futz chain was already built from. `futz: true`
  still means `treatment: "radio"`. The Audio tab's checkbox is a select; the anchor
  `shot.audio.futz` is now `shot.audio.treatment`. Nothing anywhere defaults to a
  treatment — the platform has no house sound.
- **Wed 12:20 PT — judge-path round 2 and the fal refusal.** ChatGPT built "revolution-of-rags"
  from one paragraph: project, 15-shot script, stills (real lane after the mock removal),
  narration, SFX, a 33 s score, two cuts, $0.92. Motion failed twice: fal's input checker on
  Wan turbo refused a crowd plate (content policy); the adapter reported it as "no downloadable
  outputs". Seedance accepted the same plate. Fixed: the adapter now states the refusal and
  names the fallback; the motion model registry (N) lets the agent pick `seedance`/`wan` per
  shot, with failure modes and fallbacks in the records; PixVerse removed. Landing page + skin
  + `/app` (O) deployed with it (`sha-a4def0a`). Style register (P) and the origin-film
  generalization sweep (Q: `radio`→`narration`, futz→voice treatment) in flight.
- **Wed 12:50 PT — style register (P) and the generalization sweep (Q) landed.** Every still
  gets the project's style prefix first and the avoid list folded in (same shot, same seed:
  caricature → anime cel); reference frames opt-in per backend. `radio` → `narration` with a
  boot migration; "radio futz" → voice `treatment` (none default; radio, phone, megaphone,
  hall); baseball and dial leftovers removed from copy. 632 web / 256 server tests. 46 tools.

## Rebrand (2026-09-02)

The product was renamed from Cutroom to **Genga Studio**, on the domain
**gengastudio.com**. 原画 *genga* is the Japanese term for the key drawings in
animation.

Every "Cutroom" above is left as written. This document is the record of what
was planned and when, not a description of the current product, so restating it
under the new name would falsify the record. Read those mentions as the old
name for the same thing.

Nothing internal changed. The Python package and import path `cutroom`, the
`cutroom` CLI, the `CUTROOM_*` environment variables, the Docker image and
Railway service names, the `~/.cutroom` data directory, the API paths and the
WebMCP tool names are all unchanged, so the tool catalogue and the test
evidence in this plan still describe the shipped build exactly.
- **Wed 14:15 PT — Genga Studio is live.** Product renamed (workstream R: 118 user-facing
  mentions, identifiers kept), wordmark + favicon, hero "Key frames from you. Holds, cels, and
  cuts from the studio." Domain gengastudio.com on Cloudflare DNS → Railway custom domain,
  certificate valid; `https://gengastudio.com` serves the landing page, `/app` the studio, native
  tools register there. GitHub repo renamed `ryan-the-brodsky/genga-studio` (old URL redirects).
  Pinned `sha-4a684bc`.
- **Wed 15:20 PT — Two Claudes, motion throughout.** Through the tools on the live studio:
  `plan_motion` ($3 budget, 5 s clips) → `apply_motion_plan` animated all 15 shots (Seedance
  first, Wan where the register won or the budget thinned) for $1.56 in one 9.5-minute call;
  every shot now plays its newest full-length clip; cut 9. Shots without a motion prompt now
  animate with a derived locked-camera ambient prompt. "revolution-of-rags" deleted via the
  new admin route; only Two Claudes remains on the demo.

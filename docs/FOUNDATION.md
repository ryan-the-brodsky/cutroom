# FOUNDATION — should Cutroom extend an existing editor?

> Landscape evaluation, 2026-07-14. Six parallel research passes: open-source browser
> editors, open-source engines, OTIO/interchange, the commercial AI-film field, a pro-NLE
> parity checklist, and an adversarial code audit of the leading fork candidate.
>
> Provenance note: everything below came from research agents. The FreeCut audit is the
> only pass that **cloned, built, typechecked, tested and ran** the code — treat its claims
> as verified. The rest are sourced to primary docs and the GitHub API but are not
> first-hand. Anything marked ⚠️ is the kind of claim to re-check before it costs money.

## 0. The finding that reframes the question

**We did not build a video editor. We built a shot database with a render button.**

Cutroom is ~10k lines: `Project → Shot → Take → Comp → Job`, adapters, a director
grammar, and a linear assembler. The Film Editor is a strip of shot cells with a `seconds`
field. `engine/assemble.py` renders one segment per shot and concats them.

There is **no track model, no clip, no in/out point, no overlap, no transition**. Every
shot butt-cuts to the next. `Shot.seconds` is a duration, and the source always plays from
frame zero.

That single absence explains the shape of the whole codebase:

- `freeze-tail.py` and `chain-gen.py` exist as **render jobs** because, with no in/out on a
  clip, "keep the first second" cannot be expressed as an edit. It has to burn a new mp4.
  We do destructive editing because we never had a non-destructive timeline to edit.
- `UX-NOTES.md`'s "opportunities" list — drag-reorder, markers, A/B compare, audio cues on
  the timeline, scrub-in-place — is a list of NLE table stakes, being rediscovered one at a
  time. That is the "hacking our way through each feature" problem, and it has a root cause.

An independent parity audit reached the same diagnosis from the outside:

> "Cutroom is an excellent generative shot manager with a genuinely novel NL edit surface —
> and its `Take`/variant model already gives it FCP Auditions for free. But it is not yet an
> NLE, and the reason is precise and singular: **it has no time model.** Shots are slots,
> not clips-on-a-track-with-in-and-out-points."

So the question is not "which editor do we fork." It is **"what do we adopt so that we stop
reinventing the timeline."** Those have different answers.

## 1. The competitive read: our ideas are table stakes, our doctrine is not

The uncomfortable half first. **Project-first object model, model picker, shot library, AI
director — these are not white space.** LTX Studio has them. Adobe's Firefly video editor
(browser, genuinely multi-track, generation-history panel, 30+ routed partner models) has
them. Several free ComfyUI workstations have them. The instinct was right: these are
features other things already have, and building them from scratch was waste.

But **nobody has shipped a tool where a director can actually cut a film.** Google Flow's
Scenebuilder is a single-track clip sequencer that reportedly breaks past ~8–9 clips; at 123
shots we'd be dead on arrival. The one incumbent with a real timeline (Adobe) got there by
refusing to bet on a single model and bolting a router onto an NLE — the same architectural
instinct as our adapter layer.

What is genuinely unoccupied:

1. **Anime grammar as executable constraint.** `bible/` + the panel-shot skill + the
   director-cut grammar. Nobody encodes technique as data.
2. **Motion restraint as a first-class rule.** The FIRST-SECOND LAW, true freezes, boil
   banned. This is *structurally impossible* for anyone billing per generated second — their
   business model needs you to generate more motion, not less.
3. **Zero marginal cost per retake.** The universal complaint across every hosted tool is
   pay-to-preview: credits burn on failures before you see anything. ⚠️ (Specific credit
   figures in the research were flagged unverified; the pattern is well-attested.)
4. **Local generation on Apple Silicon.** Not one incumbent — OpenAI, Google, Adobe, Amazon,
   Apple — permits self-hosted or BYO-weights generation. LTX's local mode is NVIDIA-only.

Conclusion: **our moat is upstream of the cut, not in the cut.** That is an argument for
adopting someone else's timeline rather than authoring one, and for handing finishing off to
Resolve rather than reimplementing it.

## 2. The one non-negotiable move (true in every scenario below)

**Adopt a real timeline data model.** Three properties, all cheap now and brutal later:

1. **Rational time, never float seconds.** OTIO's `opentime` — `RationalTime(value, rate)`,
   `TimeRange(start, duration)` — or integer frames + a project fps. Our `Shot.seconds:
   Float` is precisely the mistake this exists to prevent.
2. **A clip with source in/out separate from timeline position.** `from`, `duration`,
   `sourceStart`, `sourceEnd`. Without this there is no trim, and freeze-tail/chain-gen stay
   destructive forever.
3. **Media handles — frames beyond the visible in/out.** This is the one that quietly kills
   browser editors. A one-second dissolve needs one second of media *past* the left clip's
   out-point. If the model can't represent it, transitions are not "unbuilt" — they are
   *unimplementable* until the timeline is rewritten. Both Premiere and FCP have explicit
   ugly failure modes for insufficient handles; that's how load-bearing it is.

Plus **command-pattern undo from the first commit.** Every team that bolts undo on later
rewrites the timeline.

Everything else in this document is downstream of, and separable from, this refactor.

## 3. The engine question: MLT, and it isn't close

For **server-side authoritative render**, the winner is the engine *underneath* the editors,
not any editor.

**MLT** (LGPL-2.1 core) powers both Kdenlive and Shotcut. It was originally built as a
broadcast playout server, so headless rendering is its native use case. It gives us, for
free, the things we are hand-rolling badly: a real keyframe system with Catmull-Rom easing
and easing functions (which matters more than effect count given our motion doctrine),
transitions, compositing, proxies, hardware encode, time remap, LUTs, keying, and the entire
libavfilter catalogue exposed as MLT filters.

The sleeper feature: **`.mlt` XML is the same format Kdenlive and Shotcut read.** The server
emits a `.mlt`; a human can open that exact file in Shotcut, fix a shot by hand, and hand it
back. No other engine has that escape hatch.

**License:** GPL has no SaaS trigger — the FSF says so explicitly (`gpl-faq#UnreleasedMods`),
so running GPL code server-side obliges us nothing. But build MLT `-DGPL=OFF -DGPL3=OFF`
against an LGPL FFmpeg **anyway**. You lose `qtblend` and rotoscoping; you keep libavfilter,
LUTs, keying, masks, time remap, and NVENC/VideoToolbox hardware encode. It costs little, it
means the desktop-app and on-prem conversations never happen, and it deletes the
Qt-needs-a-display problem in Docker. ⚠️ The `GPL=OFF` build path is less-travelled — budget
for papercuts.

Rejected, with reasons:

- **libopenshot** — links a JUCE fork, and **JUCE is now AGPL**, which *does* have a SaaS
  trigger and could oblige us to publish source to our own web users. Real business risk.
- **Olive** — the most beautiful architecture in the field (node-based, OCIO, 32-bit float);
  zero releases ever, dead of single-maintainer burnout.
- **GStreamer GES** — LGPL-clean and headless-capable, but the API is documented as *not
  thread-safe*, and the ecosystem is one maintainer and one consumer (Pitivi).
- **Raw `filter_complex`** — no timeline model, no keyframes, no partial re-render. A
  200-shot film becomes an undebuggable multi-kilobyte string where changing shot 3
  re-renders all 200. This is what we are doing today, and it is a three-year path to a worse
  MLT.
- **Remotion** — not an editor; a React→video renderer. Its licence forbids selling a
  derivative and its "Automators" tier meters at **$0.01/render forever** on precisely our
  use case.

## 4. Interchange: steal the time model, emit the format, don't adopt the schema

OTIO splits into three separable decisions:

- **Adopt `opentime` semantics** → **yes, unambiguously.** Highest ROI item in the research.
- **Adopt `.otio` as our source of truth** → **no, this is the trap.** OTIO's own feature
  matrix marks **Audio/Video Effects: ✖** in the OTIO column. An `Effect` is a name string
  plus an opaque blob — no parameters, no keyframes, no curves. `cel-composite`,
  `panel_engine`, `freeze-tail`, `chain-gen`, `frost-glass` — the entire creative payload of
  this project — would have no schema home and would live in metadata blobs, at which point
  OTIO buys us a JSON envelope and nothing else. It also cannot do instancing (repeated media
  becomes identical copies, breaking our asset-centric model), has no UUIDs, no undo, no
  mutation protocol, and no production JS binding. Still 0.18.1 and "beta" after nine years;
  1.0 was due 2026-04-10 and is still open.
- **Emit and ingest `.otio` at the boundary** → **yes, and it's days of work in TypeScript.**
  Resolve (free *and* Studio), Nuke Studio, Kdenlive and OpenRV open it natively. Ship EDL
  (CMX3600) too — a few hundred lines, and the most universally accepted interchange there is.

Two details that make the handoff actually work, and that are invisible until they fail:

- **Source timecode and reel names.** Boring metadata; the *only* thing that makes a conform
  work. Skip it and the first colorist who imports our cut sees every clip come up offline.
- **Per-shot render mode.** Resolve's `Individual Clips` export — per-shot files, source
  timecode preserved, N-frame handles. This is exactly the export mode an AI film tool needs,
  and Resolve already designed it.

⚠️ **Resolve's external scripting API is Studio-only** ($295). Console scripting works in
free; "our web app pushes a cut into your Resolve" does not. Workflow Integration Plugins
(the Electron-panel system) are Studio-only too. File export works everywhere — another vote
for the boundary over the integration.

## 5. The front-end: the star counts are lying

The three projects we'd most likely have picked on reputation are all traps:

- **OpenCut** (68k★) — merged a `rewrite` branch that deleted ~90% of the product. `main` is
  now a shadcn scaffold: **no timeline, no export, no renderer.** The real editor survives
  only at the dead `pre-rewrite` tag. Forking it today forks a starter kit.
- **Remotion** (53k★) — see above. Not an editor; licence forbids the derivative; meters you.
- **Diffusion Studio** (1.2k★, "MPL-2.0") — the repo is a *playground*; the engine ships as a
  closed bundled binary on npm with **no source**, and burns a watermark into output.

Also dead or disqualified: designcombo/OpenVideo (dormant, and it stacks *two* Remotion-style
licences), Motion Canvas (17 months idle), omniclip/WebAV (stalled), Etro (GPL), editly and
FFCreator (Node, abandoned), OpenReel (single author, ships a crypto token).

**The one real candidate is FreeCut** (`github.com/walterlow/freecut`), and it survived an
adversarial audit that cloned it, built it, and ran it.

### What the audit verified first-hand

- **It is not AI slop.** Cross-file duplication 0.46%. Real dead code ~300 LOC out of 314k.
  Zero test files whose assertions are all trivial. Feature-sliced architecture with a
  `deps/` anti-corruption layer, enforced by nine custom CI boundary scripts.
- **The tests are real and green.** 3,351/3,352 pass on Node 22 (the one failure is a test bug
  hardcoding `Ctrl` on macOS). 8,238 assertions. The slip-edit test correctly asserts that
  `sourceStart`/`sourceEnd` shift *while `from` and `duration` stay fixed* — that is the
  actual semantic definition of a slip, not stub generation.
- **It builds and it renders.** `npm run build` clean in 6s. 0 type errors across 1,996 files.
  The headless harness launched real Chrome, ran the actual export pipeline, and produced a
  real video. 14/14 checks passed.
- **The time model is sound — the feared flaw is absent.** Integer frames + project fps, with
  `sourceStart`/`sourceEnd`/`sourceDuration`/`sourceFps` fully separate from timeline
  position. Ripple, roll, slip, slide, rate-stretch, freeze-frame, sync-lock, linked edits,
  adjustment layers, and **nested compositions** all implemented and tested.

### What the audit found that the first pass missed

1. **⚠️ The MIT premise is false.** `src/infrastructure/audio/time-stretch.ts` is SoundTouch
   JS — **LGPL-2.1**, vendored verbatim, with the full LGPL text sitting inside `src/`. It is
   **load-bearing**: it powers pitch-preserved speed changes across the export pipeline, an
   AudioWorklet, and preview playback. LGPL §6 requires users be able to relink — very hard to
   satisfy in a bundled, minified SPA. Fine for FreeCut (it's open source); **a commercial
   closed-source fork inherits the obligation.** Fixable and bounded (swap in
   `signalsmith-stretch`, MIT), but scope it now, don't discover it in diligence.
2. **The "4 contributors" is one person.** 2,297 commits from `walterlow`; the next-largest
   author is almost certainly his alt account. 335 commits in the last 30 days, with the
   codebase turning over roughly every quarter. If he stops, we own 314k lines we didn't write
   with nobody upstream.
3. **Two severe export bugs are open**, and the audit confirmed one architecturally: audio
   export renders the **whole timeline through a single `OfflineAudioContext`** — ~690MB of
   Float32 for a 30-minute stereo render. Irrelevant for a 9-minute film; a must-fix for a
   general product. Also **Chromium-only** (WebGPU + WebCodecs + OPFS).

### The surprise

A startling amount of what we wanted to "bolt on" is already in FreeCut's tree: an **LLM
agent with a tool registry and MCP support** that drives the timeline; AI workers (TTS,
upscale, frame interpolation, transcription, CLIP embeddings); a **content-addressable
AI-output store with versioned lineage envelopes** recording service/model/params, with
refcounting; a scene browser with CLIP/text embeddings; and `SubComposition` — real nested
timelines — plus multiple top-level sequences.

Its lineage is *analysis* lineage (derived **from** media) rather than *generation* lineage
(media generated **from** prompts). We'd extend it. But the bones are there.

### The risk the audit did not weigh, and I think is the biggest one

**FreeCut is local-first; Cutroom is server-authoritative.** FreeCut's `PRODUCT.md` is
explicit: local-first, no cloud, no subscription. It persists to **OPFS** via a
`workspace-fs` layer. Cutroom keeps project state in a DB, media on the server, and jobs in a
server-side queue with GPU pools.

Marrying them means rewiring FreeCut's storage/persistence layer — and its undo
`captureSnapshot`/`restoreSnapshot` enumerate **8 hardcoded stores**, so any store we add is
silently absent from undo unless we edit core. Combined with the fact that our required edits
land in the two hottest files in the repo (`types/timeline.ts`, 23 commits/90d;
`stores/items-store.ts`, 18), **tracking upstream on a modified fork is not realistic.** Take
a snapshot, hard-fork, own it, cherry-pick deliberately.

## 6. Where the engineering weight actually is

The single most useful thing in the parity research:

> **The GPU made the "effects" column cheap. Nothing has made the "time" column cheap.**

Nearly every *trivial* item is a pixel operation: blend modes (~27, one shader file), LUTs
(one `texture3D` sample), ASC CDL (ten numbers, four lines of shader), scopes, safe areas,
crop, opacity, typography, SRT, EDL.

Nearly every *hard* item is a time operation: frame-accurate seek, multi-layer playback,
render cache, undo, trim modes, retime curves, audio scrubbing.

So: **spend the hard engineering on transport, not effects.** It demos badly and it is the
whole ballgame. And take the free wins immediately — a tool with a vectorscope and a LUT
looks ten times more serious for about a week of work.

Rough weights, for a team that already knows WebCodecs:

| Scope | Weight | Result |
|---|---|---|
| Tier 0 (playhead, clips, trim, ripple/roll, undo, J/L cuts, waveforms, markers, export) | ~4–8 eng-months | An editor stops laughing |
| + Tier 1 (3-point editing, slip/slide, dissolves, keyframes, LUTs, scopes, snapshots, EDL/OTIO) | ~12–20 eng-months | **An editor will genuinely use this** |
| Full parity | Don't | Category error |

Three domains an AI-film tool gets to **delete outright**: proxies and relinking (media is
generated, not captured), multicam, and colour finishing (export to Resolve). And one it gets
**for free**: variants/rerolls are already FCP Auditions and Resolve Take Selectors — a real
pro-NLE concept that falls out of our `Take` model. Premiere doesn't even have it.

## 7. The agent layers are orthogonal — and ours is ahead

FreeCut's agent layer is **1,408 lines whose entire intelligence is a 35-line system prompt.**
Thirteen tools (`find_clips`, `split`, `trim_clip`, `set_speed`, `add_transition`,
`remove_silence`, …) — every one a mechanical timeline operation. No creative op, no grammar,
no doctrine. Its few-shot examples top out at *"add a title that says Welcome."*

It is not even a tool-calling loop: it's a single-shot JSON planner with one corrective retry
and one read-only "resolve hop," because it runs a **4B on-device Gemma over WebGPU**. No
cloud key, no model picker, no API path (repo-wide grep for `anthropic`/`openai`/`apiKey`:
zero hits). Its MCP support is 81 lines of inert scaffolding — no SDK, no transport, no
client, no server.

**It cannot generate pixels.** No t2i, no i2v, no diffusion anywhere in the dependency tree.
Its AI is analysis (Whisper, CLIP, VLM captioning) and enhancement (Anime4K, RIFE) plus local
audio gen (Kokoro, MusicGen). Its own constants file admits the upscaler *"cannot invent
texture."* It has no FIRST-SECOND LAW because it has no generation whose failure modes would
require one.

Its `ai-outputs` store — which the first audit called a lineage store — is an **analysis
cache**: `transcript | captions | scenes`. For generated media it records **no prompt and no
seed**, and overwrites in place. Its MusicGen output is literally irreproducible. Our `Take`
model is a different universe.

**So: delete their agent layer, keep their engine.** But steal four mechanisms:

1. **Clip-ref grounding** — hand the model a live inventory as `c1`/`c2`/`c3`; their code
   calls it *"the single biggest lever on tool-call accuracy."* Port into `get_film`.
2. **Capability flags on ops** — `readOnly` / `destructive` / **`handoff`**. That last is a
   pattern we lack: *a tool whose execution is "open a review UI for the human."* Exactly
   right for `set_keeper`.
3. **`summarize(args) → string` co-located with each op**, so a plan renders as prose.
4. **Their tool-contract shape** — name, schema, flags, `validate`, `summarize`, `execute`,
   co-located, feeding three consumers from one registry. Better than our `OPS` dict.

⚠️ **Take the contract, not the runtime.** Their `ToolResult` is `{ok, message, data}` — it
assumes the tool *finished*. Every generative op we have returns a **job id** against a GPU
pool; `gen_motion` takes minutes. Their registry has no job queue, no lanes, no pools.

## 8. The fork decision: lift the engine, don't fork the app

The bend-cost audit overturned the framing. The question is not "hard-fork vs. vendor the
types." It is **which module is actually the prize** — and it is not the one we assumed.

| Module | LOC | Store coupling | Verdict |
|---|---|---|---|
| `runtime/player` (clock, transport, VideoSourcePool) | 3,247 | **zero** Zustand, **zero** `@/features` imports | **Lift outright** |
| `runtime/composition-runtime` (frame renderer) | 16,225 | 9 bindings, **all via one 10-line file** | Clean lift; that file is the cut line |
| `features/export` (WebCodecs pipeline) | 21,055 | — | Lift |
| `features/keyframes` (bezier, dopesheet, value graph) | 18,356 | — | Lift — directly useful for cel animation |
| `infrastructure/gpu-*` (WebGPU compositor) | 13,074 | — | Lift |
| **`features/timeline`** | **71,813** | **41 module-level singletons, 0 React contexts, 614-file import closure** | ⚠️ **The trap** |

**The hard, expensive, bug-ridden part of an NLE — a frame-accurate clock, A/V sync, seek,
decoder pooling, the compositor, and the WebCodecs export path — is a ~40k-LOC module with
near-zero coupling.** Meanwhile the thing we assumed we'd keep, the timeline UI, is the most
coupled artifact in the repo: no provider boundary anywhere, nothing to inject, nothing to
scope. Among the 41 stores we'd inherit: `tts-generate-dialog`, `mic-recording-store`,
`silence-removal-dialog`, `ui-sound-store`.

`src/headless/` is the proof: a dedicated Vite entry that runs *the exact same render engine*
with **no React UI, no router, no storage layer**, with media injected as URLs. The engine is
already demonstrated to stand alone.

**Why hard-forking is the trap** — and not for the reason expected. The dead-weight ratio is
only 24.7% (and ~32k of that 77k is app shell, dead *to us*, not bad code). What kills it:

1. **Upstream moves at ~300 commits/month.** Delete 77k lines and rewire storage, and every
   merge is a hand-conflict. You get the fork's costs and none of its benefits. Fork with
   intent to never merge again — at which point you're maintaining 236k lines you didn't write
   and the surgical lift is strictly better.
2. **`features/timeline` is the coupling monster.** "Keep the timeline + preview + transport"
   sounds like the cheap option and is the expensive one.

| Path | Substrate | Product | **Total** |
|---|---|---|---|
| (A) Hard-fork all 314k | ~4–5 eng-mo (incl. learning someone else's 314k) | 3–4 | **7–9 mo** + permanent divergence tax |
| **(B) Surgical lift of the engine** ⭐ | ~1.5–2 eng-mo | 3–4 | **5–6 mo**, no divergence tax, no dead weight, no LGPL |
| (C) From scratch on mediabunny | ~8–12 eng-mo | 3–4 | **11–16 mo** |

Path C is anchored: FreeCut burned ~40 engineer-months to reach 314k LOC. mediabunny gives
demux/decode/encode/mux and **nothing** for the clock, the compositor, or edit semantics —
which is exactly where NLEs die.

**Take: `runtime/` + `types/` + `timeline/stores/actions/` + `export/` + `keyframes/` +
`gpu-*` (~60–80k LOC, MIT). Own our stores, our persistence, and our track view from day one.**
Optionally lift `timeline-content.tsx` (1,919 LOC, genuinely prop-driven) for canvas and
virtualization.

### Three decisions that de-risk it, in order

1. **Model a shot as a `CompositionItem`, not a 10th union kind.** `TimelineItem` is a 9-kind
   discriminated union with **~615 `.type === …` dispatch sites** and two `switch` statements
   that both have **silent `default:` branches** — TypeScript will not protect us when we add
   a 10th kind; a "shot" would silently render as a video clip. `CompositionItem` already
   exists, already nests a sub-timeline (cel layers map straight onto its tracks), and —
   critically — **already gets its own scoped undo stack**, so per-shot undo in the shot lab
   comes free.
2. **Fix async undo before writing a line of generation code.** `execute()` captures state
   before, runs the action, captures after — **synchronously**. Hand it an `async` function and
   it returns a pending promise before any mutation; before === after; **no history entry is
   ever pushed, silently.** Our generation jobs would be un-undoable. The escape hatch
   (`addUndoEntry`) tolerates `await` but has **no staleness guard and no context guard** — a
   job landing after unrelated user edits produces an undo entry that eats them. This is the
   one place our problem domain (async, long-running, concurrent generation) is genuinely
   hostile to their architecture. Budget real design time.
3. **Deal with LGPL SoundTouch on day one.** It's *vendored source*, not a dependency: 672
   lines, imported by exactly **2 files**, and the vendored file already renamed its exports to
   library-neutral names (`TimeStretchFilter`, `TimeStretchProcessor`) — a deliberate swap
   seam. Replace with signalsmith-stretch (MIT): ~1 week, of which the hard part is the
   AudioWorklet (WASM can't `fetch` in `AudioWorkletGlobalScope`). **Or just delete it: ~1 day.**
   It powers pitch-preserved retiming and reverse audio. For an anime short with VO, we
   probably don't retime with pitch preservation at all. Decide on product need.

### The gate: a 3–5 day spike before committing

Run `npm run test:preview-sync:stress` (20 runs — the harness already exists) and drive
`headless/render.mjs` end-to-end with media served from a stub of our ComfyUI endpoint (copy
`headless/media-server.mjs`; it already sends the CORP/CORS/Range headers we need).

This validates the one thing no LOC count can tell us: **whether an AI-written real-time A/V
engine is actually frame-accurate.** If the clock is solid, the lift is a clear win. If it
drifts, the engine was the only reason to be here, and we reconsider.

## 9. Local-first, without local-only assumptions

Posture: **local-first now, hosted later — and nothing may bake in a local-only assumption.**
This is a standing constraint on every file we write, not a phase-two concern.

The good news, from the seam audit:

- **Media is ~80% done already.** `infrastructure/browser/mediabunny-input-source.ts` is the
  single funnel for all media I/O, and its last branch already falls through to
  `mb.UrlSource` → HTTP range streaming. All 9 production call sites therefore already work
  with a remote URL. `blob-url-manager.registerUrl()` exists, is reference-counted, and its
  docstring says *"never used by the in-app flows"* — its one caller is the headless renderer.
  Our work is mostly **deleting the local-file path**, not building a remote one.
- **The storage port already exists in shape.** `storage/workspace-fs/fs-primitives.ts` is 9
  methods — `readJson`/`readBlob`/`writeJsonAtomic`/`writeBlob`/`removeEntry`/`listDirectory`/
  `exists`/… — **100% async, path-segment-based, null-on-missing.** It maps 1:1 onto HTTP
  verbs. It just forgot the `interface` keyword. `paths.ts` needs zero changes.

⚠️ **The correction that matters:** primary persistence is **not** OPFS — it's the File System
Access API over a user-picked directory. OPFS is a *second, parallel* cache system that
**bypasses the storage layer entirely** (11 files call `navigator.storage.getDirectory()`
directly, ~5k LOC). That's the real smear, and it's where a local-only assumption would hide.

Rules we adopt now, so hosted mode stays reachable:

1. **Persistence goes through one injected port.** No `FileSystemDirectoryHandle` in the
   domain model. (FreeCut embeds `FileSystemFileHandle` in `MediaMetadata` and persists it to
   IndexedDB, and structured-clones a directory handle into a Web Worker — both have no remote
   equivalent. We take the port, not those choices.)
2. **Media is addressed by URL, always.** A local file is a URL too. `MediaStorageType` gains
   `'remote'` + `sourceUrl`.
3. **Assume writes can fail transiently.** FreeCut has *no retry, no backoff, no offline
   queue*, and a tab-local mutex whose own comment says cross-tab races are last-write-wins —
   because a failed local-FS write is permanent, and an HTTP write is not. **This is the
   biggest behavioral gap and it is invisible in a LOC count.**
4. **`element.crossOrigin = 'anonymous'` on every video element.** `VideoSourcePool.ts:447`
   omits it; cross-origin video → tainted canvas → SecurityError on WebGPU readback. It will
   bite *silently*.
5. **Our media server must send CORP + CORS + Range.** COEP is `require-corp` for
   SharedArrayBuffer/WebCodecs; without those headers every media load fails.

## 9a. Spike results — the gate is cleared (2026-07-14, run first-hand)

Ran the §8 gate against the actual clone (`walterlow/freecut` @ `a3ecfce`) on a
self-contained Node 22.23.1 (CI pins 22; system Node 26 breaks jsdom `localStorage`). `npm ci`
clean, 434 packages; `npm run build` clean in 5.45s.

**Signal 1 — scheduling/handoff is frame-accurate and deterministic.** `test:preview-sync:stress`
= **20/20 runs green**, ~4.6s each, zero flake. The 53 tests are the exact hand-off boundaries
that cause drift: scrub→play, play→pause, transition entry, reversed playback, keyframe seek —
several assert "frame-accurate" by name, and one explicitly handles the stale-frame race
("captures the advanced store frame when reversed playback reports a stale player frame"). This
is jsdom with a fake Player, so it proves the *decision logic*, not real decode.

**Signal 2 — the real decode/composite/encode pipeline is frame-exact, from URL-served media.**
Wrote a spike harness (`headless/cutroom-spike.mjs`) driving the real engine in real Chrome via
Playwright (system Google Chrome, `channel:'chrome'`), with **our own film footage served over
HTTP by URL** — no local files, no OPFS, the exact remote-media seam our server-backed mode
needs. One timeline exercised everything at once:

- `comp-b22s2-fist.mp4` (H.264 1080p, 96 frames) — full
- `B10-S2.webm` (VP9, our LTX lane output, 768×448) — **trimmed source range 20→68 = 48 frames**
- a text overlay
- expected total: 96 + 48 = **144 frames @ 24fps = 6.000s**

Result: output was **exactly 144 frames / 6.000s / 1920×1080 h264**, `warnings:[]`. Sampled luma
confirmed no black slates in either segment; extracted frames confirmed the *right footage in
the right segment* — and segment B showed a **mid-clip frame** (source frame ~20+, not 0),
proving the source in/out trim was honored. So in one render: remote-URL media, VP9 **and** H.264
WebCodecs decode, source in/out (the shot-model / freeze-tail primitive), multi-clip concat, text
compositing, and a frame-exact encode. `media-server.mjs` was verified first-hand to send
`Access-Control-Allow-Origin: *` + `Cross-Origin-Resource-Policy: cross-origin` + `Accept-Ranges`
+ 206 Range; the dev server sends `COEP: require-corp` / `COOP: same-origin` — the header
contract our ComfyUI/LTX endpoint must satisfy is now known and demonstrated.

**Verdict: GO on the surgical lift (Path B).** The one thing no code-read could settle — whether
an AI-written real-time A/V engine is actually frame-accurate — is answered: it is, on both the
scheduling logic and the real WebCodecs pipeline, including our own VP9 footage over HTTP with
trims. The engine is the prize, it works, and it ingests our media by URL today. Remaining risk
is where the audit already put it (async undo, storage-layer OPFS smear, LGPL SoundTouch), not in
the clock.

_Repro: clone in scratchpad; `PATH=…/node22/bin`; `npm ci && npm run build`; `npm run dev`;
`node headless/cutroom-spike.mjs`; `ffprobe -count_frames` the output. Node 22 required for the
vitest stress run; the headless render is Chrome-driven and Node-version-insensitive._

## 10. Target architecture

```
   Cutroom server (keep — this IS the product)
   generation · Take lineage · jobs/pools · adapters · director grammar · anime bible
                                    │
                          timeline model  ← single source of truth, our schema, our store
                          rational time · clip source in/out · media handles
                            ╱                                    ╲
        editing surface                                      render
   FreeCut's lifted engine (MIT):                    near term: our ffmpeg path
   runtime/player · composition-runtime              later: MLT (LGPL build) as a
   export · keyframes · gpu-*                        subprocess — compile our JSON → .mlt
   + OUR stores, OUR track view, OUR two-room UX               │
                                                       OTIO / EDL export
                                                   → Resolve · Shotcut · Nuke
```

Keep our JSON as the source of truth. Treat `.mlt` and `.otio` as **compilation targets**,
never as the database. That keeps the render engine swappable and makes interchange nearly
free.

**MLT is phase two, not day one.** The lifted engine renders in-browser via WebCodecs, which
is fine for a 9-minute film (the known OOM is in the *audio* export path at ~30 min, and it's
chunkable). Adopt MLT when we need an authoritative server-side master render — at which point
the JSON→`.mlt` compiler is ~3–5 weeks and buys keyframes, transitions and compositing
server-side, plus the Shotcut round-trip.

## 11. What we throw away, and what we keep

**Keep** — this is the product, and no NLE has it: the adapter layer and model routing;
`Take` lineage; the cel/comp model; the panel engine; the director grammar and ops schema;
the job queue with GPU pools; `bible/` as executable doctrine; the importer.

**Throw away**: `engine/assemble.py`'s butt-concat (superseded by a real timeline compiler);
the Film Editor strip (superseded by a real timeline UI); `Shot.seconds` as a float; and the
premise that "shot" and "clip" are the same object. **They are not.** A shot is a unit of
*production*; a clip is a unit of *time*. Conflating them is the original sin, and it is why
`freeze-tail` has to render an mp4 to do what a trim handle does for free.

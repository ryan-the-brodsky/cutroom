# UX field notes — first hands-on pass (2026-07-12, in-browser, test mode)

Method: drove the app end-to-end via browser automation with the mock backend
(lane defaults → `mock`, generations return the film's own footage), logging
friction as a user. Fixed-in-place items are marked ✅.

## The structural finding (the director's call, confirmed in use)

Two rooms, two mindsets:

- **Film Editor** (`/p/<id>`) — the arrangement room. Strip + board of what
  exists; select a shot for a *quick* panel (seconds, VO offset/mute, "what
  plays" take picker); cut the film; double-click into focused work. ✅ built
- **Shot Editor** (`/p/<id>/shot/<sid>`) — the granular room. Monitor +
  direct box + filterable takes rail on the left; a workspace on the right
  with tabs **compose · generate · motion edits · audio · script**. The
  compose tab embeds the full cel workbench (stage with region drawing over
  the true-size plate, layer rerolls, bg restyle, render, promote). ✅ built

## Bugs found by using it

1. ✅ Region canvas assumed 1920×1080 plates; real plates are 960×544/768×432
   → regions came out ~2× too big. Added `/api/…/dims/` + `usePlateDims`.
2. ✅ A fresh fx render auto-hijacked the shot's timeline source (newest-wins).
   Now: override > promoted motion > OLDEST fx candidate; mock takes never
   auto-play (`meta.mock`).
3. ✅ Model picker displayed the first enabled backend while the server would
   use the project's lane default (showed ComfyUI, ran mock). Picker now
   reads lane defaults and labels them "(project default)".
4. ✅ Grammar could compile `freeze_tail` against a still. Clip-extension
   guard added.
5. ✅ Cold-start thumbnails: 97 black cards racing ffmpeg on first visit.
   Imports now chain a `thumbs.warm` job. (Remaining: skeleton shimmer for
   the just-created-take case.)

## Friction → fixed this pass

- ✅ No feedback after submitting a generation (stare at an 8s poll):
  `useJobWatch` SSE hook — submit → "working…" chip → auto-refresh → the new
  take auto-selects in the monitor.
- ✅ Cuts gallery eagerly mounted N `<video>` elements: poster thumb,
  click-to-play.
- ✅ Take interactions were select-only: per-take actions (★ keeper,
  ⬆ timeline source, ❄ freeze…, 🎬 compose on this).

## Opportunities (next passes)

- **Reroll-from-lineage**: every take knows its prompt/params/parents — an
  "↻ again with tweaks" that prefills the generate tab (the original pipeline
  had this; the data is already in Take rows).
- **Compose stage improvements**: drag-to-move/resize existing layer regions;
  show the /32-snapped rect (currently snap happens at generation); scrub
  layer clips in place.
- **Direct-box escalation UI**: when grammar can't parse and no LLM backend
  is enabled, offer "open in chat" instead of a 422 message.
- **Film Editor**: drag-reorder (needs an order-override column — film order
  is script order today, by design); beat markers on the strip; A/B compare
  pane in the quick panel.
- **Audio lanes**: music/SFX cue editing on the timeline (assembler accepts
  cues; no UI yet). Imported `music_cues`/`sfx_cues` sit in project settings.
- **Progressive disclosure defaults**: open the workspace tab by shot state
  (no keeper → generate; keeper + no motion → compose; VO-less → audio).
- **Skeletons** for takes/thumbs that were created seconds ago.

## Test mode

`Settings → Backends → mock` (enabled) + per-lane defaults on the project.
Mock still = seeded pick of existing stills; i2i = hue-shift of the source
(layout preserved — semantically faithful); motion = existing clip scaled to
the requested region dims and frame count (real anime motion through the real
composite path); vo = existing generated line. Swap lanes back to
`local-comfyui`/hosted backends for real generation — nothing else changes.

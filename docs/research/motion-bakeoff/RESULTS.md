# Anime-motion bake-off on fal — 2026-09-02

Three plates from the *two claudes* demo film × four hosted image-to-video
models, one clip each, 5 s, run straight against fal from a laptop.
**Total spend: $1.449** of a $4 cap.

Every clip starts from a finished anime plate the film already has, plus one
directing sentence naming what moves, how much, and what stays still. No
text-to-video; the question is whether a model can take direction on a plate
you already approved. The three prompts cover the three registers a director
actually asks for: a subtle beat (a cursor blinks), a designed burst (two
beams sweep), and a character gesture (a fingertip presses a key).

The question was the owner's: motion is thin at about one second per shot, and
the one-second number came from the local LTX model's drift. Can a better
anime-motion model be plugged in, and what does it cost?

**Short answer.** The one-second window is gone: all four models hold a full
5 s clip. But holding a clip is not the same as holding *your plate*, and that
is where they separate. The cheapest model is also the most faithful.
Keep `fal-ai/wan/v2.2-a14b/image-to-video/turbo` as the default.

## The plates

| name | shot | what it tests |
|---|---|---|
| lighthouses | `B03-S2` | **designed burst.** Wide tableau, near-black, one hard rule: *the beams must never cross.* "Both amber beams sweep slowly past each other across the black water, the sea heaves once, then everything holds. Locked camera." |
| terminals | `B02-S2` | **subtle beat**, over fine legible detail — green code on two monitors. "A line of glyphs scrolls up both windows in sync, then both cursors blink once and hold. Locked camera." |
| hands | `B04-S2` | **character gesture**, dark close-up. "A fingertip presses a key, the screen glare lifts half a stop, then everything holds. Locked camera." |

Contact sheets in this folder: 6 frames per clip (0.05 s, 1 s, 2 s, 3 s, 4 s,
4.9 s), one row per plate, in the order above. Clips themselves live in
`/tmp/cutroom-N/clips/` and are not committed.

## The table

Prices are what each model's fal page publishes; the request shape is from each
endpoint's OpenAPI schema. All four accept a base64 `image_url` data URI.

| model (endpoint id) | price, this run | seconds | delivered | latency | judgement |
|---|---|---|---|---|---|
| `fal-ai/wan/v2.2-a14b/image-to-video/turbo` | **$0.05** @480p (fixed per video; $0.075 @580p, $0.10 @720p) | 5 (no duration field) | 512×512, 32 fps, 5.03 s | 17–27 s | **Best plate fidelity, by a distance.** Locked camera, no invented moves, no boil. The beams sweep and never cross. Weakness: the smallest motion amplitude of the four, and it dropped the terminals' code text to blank screens after ~2 s. |
| `fal-ai/bytedance/seedance/v1/pro/fast/image-to-video` | **$0.108** @720p (token priced) | 5 (`duration`, 2–12) | 960×960, 24 fps, 5.04 s | 53–94 s | **Best on legible detail.** `camera_fixed: true` really locks it; the code on both monitors stayed readable for the whole 5 s, the only model that managed it. But the grade runs away on the wide (cold slate sea turns molten gold by 3 s) and it abandoned the dark close-up outright, replacing it at 2 s with a different, brighter room. |
| `fal-ai/pixverse/v6/image-to-video` | **$0.175** @540p ($0.035/s, so 3 s really costs $0.105) | 5 (`duration`, int 1–15) | 1024×1024, 24 fps, 5.04 s | 69–79 s | **Most movement, least discipline.** Invents scale and camera moves nobody asked for (the monitors ramp up to fill frame), and it broke the shot's one hard rule — both beams swung up and nearly crossed at 3 s. Close-up dissolves into blobs by 4 s. Per-second billing is the one real advantage: stop it at 3 s and you stop the drift and the bill together. |
| `fal-ai/pixverse/v4.5/image-to-video` | **$0.15** @540p flat | 5 (`duration`, "5"/"8") | 1024×1024, 30 fps, 5.37 s | 53–58 s | **Unusable for plate work.** `style: "anime"` overrode the plate instead of describing it: the lighthouse seascape became a close-up of an anime girl's face with a laser through it, the terminals grew lightning bolts and orange text, the keyboard shot got a mushroom cloud. `camera_movement: "fix_bg"` did not save it. Do not wire this in. |

Two schema facts worth keeping: the Wan turbo endpoint has **no duration field
and no `negative_prompt`** (the adapter logs and drops one rather than sending
a field the endpoint rejects), and PixVerse spells `duration` as a string on
v4.5 and an integer on v6. That is why the payload shape is a table
(`FAL_PAYLOAD_MAPS` in `server/cutroom/adapters/queue_apis.py`) instead of code.

## Recommendation per register

- **Dialogue close-up** — `wan/v2.2-a14b/.../turbo`. It is the only model that
  kept the dark keyboard close-up as the shot it was. Seedance replaced the
  room; both PixVerse builds hallucinated.
- **Wide tableau** — `wan/v2.2-a14b/.../turbo` when the composition carries a
  rule (the beams). `seedance/v1/pro/fast` when you want visibly more movement
  and can accept a warmer grade — at 2× the price.
- **Effects burst** — `pixverse/v6`, at 3 seconds, not 5. It is the only one
  that produces large designed movement, and per-second billing means you buy
  exactly the burst ($0.105) and stop before the drift.
- **Legible detail that must survive** (screens, text, signage) —
  `seedance/v1/pro/fast` with `camera_fixed: true`. It is the only model that
  held the code readable end to end.

**The demo default should stay `CUTROOM_FAL_MOTION_MODEL=fal-ai/wan/v2.2-a14b/image-to-video/turbo`.**
Nothing here beat it on anime motion at a comparable price: it is 2–3.5× cheaper,
3–5× faster, and the only one that never invented a camera move. The architect
decides; this is the evidence.

Per-project override, no code change:
`CUTROOM_LANE_MOTION=fal:fal-ai/bytedance/seedance/v1/pro/fast/image-to-video`.

## Method

`/tmp/cutroom-N/bakeoff.py` — plates fetched from the hosted API, downscaled to
JPEG and sent as data URIs, one shared motion prompt per plate, seed 4242 where
the endpoint has a seed field, a running tally in `tally.json` and a hard stop
at $4. Contact sheets are `ffmpeg` tiles. Nothing ran through the demo box.

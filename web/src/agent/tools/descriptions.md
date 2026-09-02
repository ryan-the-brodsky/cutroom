# Cutroom agent copy deck

> Every string an agent or the ⌘K palette sees, in catalogue order, with its
> character count against the Chrome budget (docs/research/webmcp-api-brief.md §5:
> name ≤30 · description ≤500 · parameter description ≤150 · output ≤1500).
> Generated from `web/src/agent/tools/*.ts`; `descriptions.test.ts` fails the build
> if any string here goes over budget or drifts from the code.

| # | tool | desc | params | annotations |
|---|---|---|---|---|
| 1 | `find_shots` | 500 | 1 | readOnly |
| 2 | `describe_shot` | 432 | 1 | readOnly |
| 3 | `get_context` | 446 | 0 | readOnly |
| 4 | `list_features` | 415 | 1 | readOnly |
| 5 | `show_me` | 435 | 2 | — |
| 6 | `open_shot` | 434 | 4 | — |
| 7 | `generate_takes` | 482 | 14 | consequential |
| 8 | `freeze_tail` | 395 | 3 | consequential |
| 9 | `trim_clip` | 403 | 3 | consequential |
| 10 | `select_take` | 462 | 2 | — |
| 11 | `set_keeper` | 418 | 3 | consequential |
| 12 | `set_timeline_source` | 422 | 3 | consequential |
| 13 | `set_shot_timing` | 416 | 4 | consequential |
| 14 | `synthesize_vo` | 460 | 6 | consequential |
| 15 | `direct_shot` | 473 | 2 | readOnly |
| 16 | `apply_plan` | 382 | 2 | consequential |
| 17 | `cut_film` | 460 | 2 | consequential |
| 18 | `get_jobs` | 442 | 1 | readOnly |
| 19 | `wait_for_jobs` | 465 | 2 | readOnly |

## 1. `find_shots` — Find shots

**where** `/p/:pid` · anchor `film.shot` · **“Film Editor → the strip”**

**description** (500/500)

> Find shots in the current film by anything a director would say: a sid (B10-S2), a number in the cut ("shot 37"), a beat ("B11"), a character ("David Ross"), a shot type ("close-up") or a free description ("the cemetery"). Returns up to eight matches with their ordinal, beat, type, one-line summary and whether they already have a keeper still, motion or a source playing in the timeline. When a phrase matches two different shots the confidence comes back "ambiguous" — ask which one before acting.

| param | req | type | chars | description |
|---|---|---|---|---|
| `query` | • | string | 97/150 | What the director said: a sid, a number, a beat, a character name, a shot type, or a description. |

**howTo** (149) — Open the Film Editor and scan the strip or the act board for the shot — every cell shows its sid, seconds and ticks for keeper, motion, comps and VO.

**keywords** — `search` `shots` `which shot` `lookup` `sid` `beat` `character` `find`

## 2. `describe_shot` — Describe a shot

**where** `/p/:pid/shot/:sid` `?tab=script` · anchor `shot.tab.script` · **“Shot Editor → Script”**

**description** (432/500)

> Read one shot's script and state without changing anything: its beat, act, type, duration, image and motion prompts, dialogue or radio line, the curated keeper, what currently plays in the timeline, how many takes exist of each kind with the newest few paths, comps, and which backend each generation lane would use with its cost class. Use it before generating so the prompt you send builds on the shot the director actually wrote.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 99/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description like "the Ross close-up". |

**howTo** (151) — Open the shot in the Shot Editor and press the Script tab — it shows the image prompt, motion prompt, dialogue, radio line and render notes as written.

**keywords** — `describe` `shot` `script` `prompt` `state` `inspect` `detail`

## 3. `get_context` — Where am I?

**where** `/p/:pid` · anchor `app.nav.film` · **“Anywhere in Cutroom”**

**description** (446/500)

> Report what is on screen right now: the current route and project, whether the Film Editor or a Shot Editor is open, which shot, which tab and generate sub-tab, the selected take, the keeper, what plays in the timeline, any jobs still running, the WebMCP mode the page is in and the agent's playback speed. Call it first when you are unsure what the director is looking at, or after a navigation, before acting on "this shot" or "the newest one".

*(no parameters)*

**howTo** (136) — Look at the sidebar and the topbar — the project name, the breadcrumb and the job chip tell you where you are and what is still running.

**keywords** — `context` `where` `current` `state` `screen` `now` `status`

## 4. `list_features` — List Cutroom features

**where** `/p/:pid` · anchor `—` · **“⌘K command palette”**

**description** (415/500)

> List what Cutroom can do and where each feature lives in the UI, optionally filtered by a word like "freeze", "keeper", "cut" or "voice". Each entry gives the tool name, a title, the screen path ("Shot Editor → Motion edits") and how a human does it by hand. Use it to answer "what can this do?" or to teach the director a feature they have not found — then call show_me to navigate there and highlight the control.

| param | req | type | chars | description |
|---|---|---|---|---|
| `query` |  | string | 84/150 | Optional filter word, e.g. "freeze", "keeper", "generate", "timing", "cut the film". |

**howTo** (96) — Press ⌘K (Ctrl+K on Windows) anywhere in Cutroom to open the command palette and type to filter.

**keywords** — `features` `help` `what can you do` `capabilities` `palette` `commands`

## 5. `show_me` — Show me how

**where** `/p/:pid` · anchor `—` · **“⌘K command palette”**

**description** (435/500)

> Teach a Cutroom feature by driving to it: navigates to the screen where the feature lives, highlights the actual control with a pulse, and explains how a human does it by hand. Answers "where is that?", "how do I do that myself?" and "show me the freeze tool". Nothing is generated and nothing is changed — this only moves the view. Pass a feature name or plain words like "freeze tail", "cut the film", "set the keeper", "voice over".

| param | req | type | chars | description |
|---|---|---|---|---|
| `feature` | • | string | 94/150 | The feature to show: a tool name or plain words, e.g. "freeze tail", "keeper", "cut the film". |
| `shot` |  | string | 79/150 | Optional shot to demonstrate on, when the feature lives inside the Shot Editor. |

**howTo** (101) — Press ⌘K, type the feature name and press Enter — the palette navigates there and pulses the control.

**keywords** — `show me` `how do i` `where is` `teach` `highlight` `demo` `help`

## 6. `open_shot` — Open a shot

**where** `/p/:pid/shot/:sid` `?tab=compose` · anchor `shot.tab.compose` · **“Shot Editor”**

**description** (434/500)

> Open a shot in the Shot Editor so the director can see it, optionally landing on a specific tab (compose, generate, motion, audio, script), a generate sub-tab (still, restyle, animate, chain) and a selected take. The page navigates on screen and the tab is highlighted. Use it to put the right room in front of the human before you change anything, or when they say "show me shot 37". Returns the resolved sid and what is now visible.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 74/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description. |
| `tab` |  | `compose`/`generate`/`motion`/`audio`/`script` | 64/150 | Which workspace tab to land on. Default: leave the tab as it is. |
| `sub` |  | `still`/`restyle`/`animate`/`chain` | 54/150 | Which Generate sub-tab to open (implies tab=generate). |
| `take` |  | string | 90/150 | A take to select: a path, or "latest", "newest still", "newest motion", "keeper", "plays". |

**howTo** (148) — Double-click the shot's cell in the Film Editor strip (or press "open Shot Editor →" in its panel), then pick a tab across the top of the workspace.

**keywords** — `open` `shot` `editor` `navigate` `go to` `show shot`

## 7. `generate_takes` — Generate takes

**where** `/p/:pid/shot/:sid` `?tab=generate&sub=still` · anchor `shot.gen.still.submit` · **“Shot Editor → Generate → still”**

**description** (482/500)

> Generate new takes for a shot in Cutroom — stills, restyles of an existing take, or animated cel clips. Opens the shot's Generate console on screen, fills it, and submits one job per take with a fresh seed. Returns job ids and, when the backend is fast, the finished takes. Count is 1–4 (default 3). Prompt defaults to the shot's own written prompt; prompt_mode "append" adds yours to it. Animate keeps the first second live and freezes the rest. Paid backends require confirm_cost.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 99/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description like "the Ross close-up". |
| `lane` |  | `still`/`restyle`/`animate` | 104/150 | still = new image · restyle = image-to-image on an existing take · animate = motion clip. Default still. |
| `count` |  | integer | 89/150 | How many takes to submit, 1–4. Words like "a few" (3) or "a couple" (2) are accepted too. |
| `prompt` |  | string | 100/150 | Prompt text. Omit to use the shot's written image or motion prompt exactly as the director wrote it. |
| `prompt_mode` |  | `replace`/`append` | 87/150 | replace = use only your prompt (default) · append = add yours to the shot's own prompt. |
| `source_take` |  | string | 111/150 | For restyle: the take to restyle. A path, or "latest", "newest still", "keeper". Defaults to the selected take. |
| `denoise` |  | number | 80/150 | Restyle strength, 0.35–0.95. 0.55 keeps the layout, 0.85 restyles. Default 0.85. |
| `region` |  | array | 90/150 | For animate: the cel region as [left, top, right, bottom]. Omit to animate the full frame. |
| `seconds` |  | number | 121/150 | For animate: clip length in seconds. Defaults to the backend's own clip length and is clamped to what it supports. |
| `frames` |  | integer | 104/150 | For animate: exact frame count, when you need one. Normally leave it and pass seconds instead. |
| `live_seconds` |  | number | 141/150 | For animate: freeze after this many seconds. Only for a model that drifts after N seconds — clips play in full otherwise. |
| `seeds` |  | array | 79/150 | Exact seeds to use, one per take. Omit for fresh random seeds (the usual case). |
| `backend` |  | string | 98/150 | Force a specific backend id instead of the project's lane default (e.g. "mock", "comfyui", "fal"). |
| `model` |  | string | 39/150 | Force a specific model on that backend. |
| `confirm_cost` |  | boolean | 102/150 | Set true to approve a paid backend. Required whenever the lane resolves to a backend that bills money. |

**howTo** (190) — Open the shot, press the Generate tab and its still / restyle / animate sub-tab, type a prompt (or keep the shot's own), then press ▶ once per take — each press queues a job with a new seed.

**keywords** — `generate` `render` `takes` `cuts` `variations` `still` `restyle` `i2i` `animate` `motion` `more` `another`

## 8. `freeze_tail` — Freeze the tail

**where** `/p/:pid/shot/:sid` `?tab=motion` · anchor `shot.motion.freeze` · **“Shot Editor → Motion edits → ❄ freeze tail”**

**description** (395/500)

> Keep the first moment of a motion clip live and hold the rest as a true freeze — the held-cel edit anime uses so a gesture reads and then the pose sits. Opens the shot's Motion edits tab, selects the clip, sets how many seconds stay live (default 1.0) and presses ❄ freeze tail. This is a real frozen frame, never a slow zoom or a drift. Returns the job and, when it finishes fast, the new take.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 74/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description. |
| `take` |  | string | 89/150 | Which clip: a path, or "newest motion", "latest", "plays". Defaults to the selected clip. |
| `live_seconds` |  | number | 129/150 | Seconds of good motion to keep before the freeze holds. Set it where the clip starts to degrade. Default 1.0. |

**howTo** (156) — Select a clip in the takes rail, open the Motion edits tab, set "keep first (s)" and press ❄ freeze tail — the rest of the clip becomes a true frozen frame.

**keywords** — `freeze` `hold` `held cel` `first second` `tail` `pose` `stop` `still the rest`

## 9. `trim_clip` — Trim a clip

**where** `/p/:pid/shot/:sid` `?tab=motion` · anchor `shot.motion.trim` · **“Shot Editor → Motion edits → ✂ trim”**

**description** (403/500)

> Cut a motion clip short, keeping only what happens before a given second. Opens the shot's Motion edits tab, selects the clip and presses ✂ so the take ends where the action ends — use it when a generated clip drifts or repeats after the beat lands. Requires end_seconds. Unlike freeze_tail this shortens the take rather than holding a pose. Returns the job and, when it finishes fast, the trimmed take.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 74/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description. |
| `take` |  | string | 89/150 | Which clip: a path, or "newest motion", "latest", "plays". Defaults to the selected clip. |
| `end_seconds` | • | number | 63/150 | Keep everything before this second and drop the rest. Required. |

**howTo** (112) — Select a clip in the takes rail, open the Motion edits tab, set "keep first (s)" and press ✂ keep only first Ns.

**keywords** — `trim` `cut short` `shorten` `keep only` `clip length` `end`

## 10. `select_take` — Select a take

**where** `/p/:pid/shot/:sid` · anchor `shot.take` · **“Shot Editor → takes rail”**

**description** (462/500)

> Put one take on the Shot Editor's monitor so the director can see it and so the next edit acts on it. Accepts a take path or the words a director uses: "latest", "newest still", "newest motion", "keeper" or "plays" (the one in the timeline). The takes rail scrolls to it and the thumbnail pulses. Call this before freeze_tail, trim_clip, set_keeper or a restyle when the director says "that one" or "the newest". Returns the selected path, its kind and duration.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 74/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description. |
| `take` | • | string | 80/150 | A path, or a word: "latest", "newest still", "newest motion", "keeper", "plays". |

**howTo** (92) — Click the take's thumbnail in the takes rail under the monitor — the monitor switches to it.

**keywords** — `select` `take` `this one` `that one` `newest` `latest` `pick` `monitor`

## 11. `set_keeper` — Set the keeper

**where** `/p/:pid/shot/:sid` · anchor `shot.take.keeper` · **“Shot Editor → take → ★ keeper”**

**description** (418/500)

> Mark a still as the shot's keeper — the curated plate everything else is built on: comps stage on it, animate uses it, and the Film Editor shows it as the chosen frame. Presses ★ keeper on the take. Stills only; motion clips are refused (use set_timeline_source to choose what plays instead). Defaults to the selected take. The previous keeper is kept in history, never overwritten. Optionally records a curation note.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 74/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description. |
| `take` |  | string | 132/150 | Which still to keep. A path, or a word: "latest", "newest still", "newest motion", "keeper", "plays". Defaults to the selected take. |
| `note` |  | string | 79/150 | Optional curation note recorded with the pick, e.g. "best eyeline, hands read". |

**howTo** (93) — Click a still in the takes rail, then press ★ keeper in the row of buttons under the monitor.

**keywords** — `keeper` `star` `plate` `curate` `pick` `approve` `chosen` `hero frame`

## 12. `set_timeline_source` — Set what plays

**where** `/p/:pid/shot/:sid` · anchor `shot.take.source` · **“Shot Editor → take → ⬆ timeline source”**

**description** (422/500)

> Choose which take actually plays for this shot in the cut — the ⬆ timeline source override. Any take works: a still, a restyle, a motion clip or a frozen one. Presses ⬆ on the take, and the Film Editor immediately shows the new pick. Pass clear:true to drop the override and fall back to the shot's default (keeper, or the newest motion). Defaults to the selected take. Run cut_film afterwards to see it in a rendered cut.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 74/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description. |
| `take` |  | string | 135/150 | Which take should play. A path, or a word: "latest", "newest still", "newest motion", "keeper", "plays". Defaults to the selected take. |
| `clear` |  | boolean | 71/150 | True removes the override so the shot falls back to its default source. |

**howTo** (137) — Select a take and press ⬆ timeline source under the monitor — or click a thumbnail in the Film Editor's "what plays" strip for that shot.

**keywords** — `timeline` `source` `plays` `use this` `override` `in the cut` `playing`

## 13. `set_shot_timing` — Set shot timing

**where** `/p/:pid` · anchor `film.quick.seconds` · **“Film Editor → selected shot → seconds / VO offset / mute”**

**description** (416/500)

> Retime a shot in the cut: how many seconds it holds, how far its voice-over slides against the picture, and whether the VO is muted. Opens the Film Editor, selects the shot and edits its quick panel, so the strip re-widths in front of the director. Positive vo_offset delays the line, negative pulls it earlier. Anything you leave out is left alone. Takes effect on the next cut_film. Returns the resulting override.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 74/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description. |
| `seconds` |  | number | 80/150 | How long the shot holds in the cut, in seconds. Overrides the scripted duration. |
| `vo_offset` |  | number | 85/150 | Seconds to slide the voice-over: positive delays the line, negative pulls it earlier. |
| `mute_vo` |  | boolean | 67/150 | True silences this shot's voice-over in the cut; false restores it. |

**howTo** (159) — Click the shot in the Film Editor strip and edit "seconds", "VO offset" or "mute VO" in the panel that opens below it — the fields commit when they lose focus.

**keywords** — `timing` `seconds` `duration` `hold` `vo offset` `sync` `mute` `retime` `longer` `shorter`

## 14. `synthesize_vo` — Synthesize a voice-over

**where** `/p/:pid/shot/:sid` `?tab=audio` · anchor `shot.audio.submit` · **“Shot Editor → Audio → ▶ synthesize”**

**description** (460/500)

> Record a voice-over line for a shot. Opens the shot's Audio tab, fills the line, voice and radio-futz switch, and presses ▶ synthesize. Defaults to the line the script already gives the shot — its radio line or first piece of dialogue — so you usually only pass the shot. Set futz true for an in-scene radio sound (bandpass, grit, static bed). ElevenLabs v3 tags in the text pass through. Paid voice backends require confirm_cost. Returns the job and the take.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 74/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description. |
| `text` |  | string | 91/150 | The line to speak. Omit to use the shot's own radio line or first dialogue line as written. |
| `voice` |  | string | 65/150 | Voice id on the VO backend. Omit for the project's default voice. |
| `futz` |  | boolean | 75/150 | True applies the in-scene radio treatment: bandpass, grit and a static bed. |
| `backend` |  | string | 69/150 | Force a specific VO backend id instead of the project's lane default. |
| `confirm_cost` |  | boolean | 84/150 | Set true to approve a paid voice backend. Required whenever the VO lane bills money. |

**howTo** (141) — Open the shot's Audio tab, check the line in the text box, pick a voice, tick radio futz if it is an in-scene radio, then press ▶ synthesize.

**keywords** — `vo` `voice` `voice over` `line` `dialogue` `radio` `speak` `tts` `audio` `futz`

## 15. `direct_shot` — Direct this shot

**where** `/p/:pid/shot/:sid` · anchor `shot.direct.input` · **“Shot Editor → ✨ Direct this shot”**

**description** (473/500)

> Compile a plain-English direction into Cutroom's own edit plan and show it on screen as a preview — "keep the first second and hold his pose for the rest of the line", "restyle this warmer", "make it two seconds longer". Types the instruction into the shot's Direct box and compiles it; the film's deterministic grammar goes first and reads the real voice-over duration. NOTHING RUNS: this only returns the plan. Show it to the director, then call apply_plan to execute it.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 74/150 | The shot: a sid (B10-S2), its number in the cut, a beat, or a description. |
| `instruction` | • | string | 64/150 | The direction in plain English, exactly as the director said it. |

**howTo** (175) — Type the direction into the "✨ Direct this shot" box under the monitor and press compile — the plan appears as a preview with an apply button; nothing runs until you press it.

**keywords** — `direct` `instruction` `plan` `say it` `natural language` `grammar` `compile` `preview`

## 16. `apply_plan` — Apply the plan

**where** `/p/:pid/shot/:sid` · anchor `shot.plan.apply` · **“Shot Editor → plan preview → ▶ apply”**

**description** (382/500)

> Run an edit plan that direct_shot compiled, after the director has approved it. Presses ▶ apply on the plan preview, so the same ops a human would run execute in order: freezes, trims, generations and state changes. Pass the plan object direct_shot returned, unchanged. Returns the jobs it submitted and how each op landed. Only call this once the human has said yes to the preview.

| param | req | type | chars | description |
|---|---|---|---|---|
| `shot` | • | string | 77/150 | The shot the plan belongs to: a sid, its number in the cut, or a description. |
| `plan` | • | object | 70/150 | The plan object direct_shot returned, unchanged: { ops: [...], note }. |

**howTo** (78) — In the plan preview under the Direct box, read the ops and press ▶ apply plan.

**keywords** — `apply` `run` `execute` `plan` `confirm` `do it` `go ahead`

## 17. `cut_film` — Cut the film

**where** `/p/:pid` · anchor `film.cut` · **“Film Editor → 🎞 cut the film”**

**description** (460/500)

> Assemble the film as it currently stands into a watchable cut: every shot's chosen source, its duration, its voice-over and offsets, in film order. Sets the scope (the whole film or a single act) and the resolution on the Film Editor, then presses 🎞 cut the film. Use it after a run of picks or retimes so the director can watch the change in context. 720 is the preview, 1080 the final. Returns the job and, when it renders fast, the cut's path and duration.

| param | req | type | chars | description |
|---|---|---|---|---|
| `scope` |  | `full`/`act1`/`act2`/`act3`/`act4` | 59/150 | What to assemble: the whole film, or one act. Default full. |
| `res` |  | `720`/`1080` | 66/150 | Resolution: "720" for a preview (default) or "1080" for the final. |

**howTo** (171) — In the Film Editor, choose the scope and resolution in the two dropdowns at the top right, then press 🎞 cut the film — the result lands in the Cuts gallery at the bottom.

**keywords** — `cut` `assemble` `animatic` `render` `watch` `the film` `act` `preview` `export`

## 18. `get_jobs` — Check jobs

**where** `/jobs` · anchor `app.nav.jobs` · **“Jobs”**

**description** (442/500)

> Check on generation jobs without waiting: their status, what they produced and, for anything that failed, the tail of the log with the reason. Pass the job ids a generation tool returned, or call it with no arguments for the project's most recent jobs. Use it when the director asks "is it done yet?" or after a tool came back with jobs still running. Returns immediately — call wait_for_jobs instead when you want to block until they finish.

| param | req | type | chars | description |
|---|---|---|---|---|
| `jobs` |  | array | 69/150 | Job ids to check (up to 8). Omit for this project's most recent jobs. |

**howTo** (86) — Open Jobs in the sidebar — every job shows its status, and clicking one opens its log.

**keywords** — `jobs` `status` `done` `running` `queue` `failed` `progress` `log`

## 19. `wait_for_jobs` — Wait for jobs

**where** `/jobs` · anchor `app.nav.jobs` · **“Jobs”**

**description** (465/500)

> Wait for generation jobs to finish, up to 60 seconds, then report what landed. Progress stays visible in the topbar and the Jobs page while you wait. Use it after a generation tool returns jobs that are still running, so the next thing you say to the director is the actual result rather than a promise. Anything still running when the timeout expires comes back as "running" — call again or check with get_jobs. Returns each job's status and the takes it produced.

| param | req | type | chars | description |
|---|---|---|---|---|
| `jobs` | • | array | 68/150 | The job ids to wait for (up to 8), as returned by a generation tool. |
| `timeout_s` |  | integer | 43/150 | How long to wait, in seconds. Capped at 60. |

**howTo** (91) — Watch the job chip in the topbar, or open Jobs in the sidebar and watch the row turn green.

**keywords** — `wait` `block` `finish` `settle` `until done` `poll` `jobs`

---

All strings are inside budget.

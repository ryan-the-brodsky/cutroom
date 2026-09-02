# Demo runbook

> Deterministic run sheet for recording `docs/VIDEO-SCRIPT.md`, and for any
> live demo of the WebMCP layer. Run it once dry before the camera rolls.
>
> Primary project is **`two-claudes`**, the 130-second short an agent produced
> end to end on this instance through the WebMCP tools. It carries no private
> footage. The sample film *Next Year* (project `next-year`), a 97-shot
> limited-animation short, appears only in the optional segment.
>
> Hosting details, variables and the ship-a-change procedure live in
> [`DEPLOYMENT.md`](DEPLOYMENT.md) § "Hosted demo (Railway)". This file is the
> demo, not the deploy.

| | |
|---|---|
| Live URL | <https://cutroom-production-0f3c.up.railway.app> |
| Judge link | `<LIVE_URL>/?token=<JUDGE_TOKEN>` (token in Railway vars and your local env file, never in this repo) |
| Admin | `CUTROOM_ADMIN_TOKEN`, needed for lane edits, seeding and reset |
| Tools | 39 |

---

## 0. Pre-flight checklist

Tick every line before recording. In rehearsal the failures were lines 4, 6
and 8.

- [ ] **1. Instance is up.** Both, not just the first:
      ```bash
      curl -sf https://cutroom-production-0f3c.up.railway.app/api/health
      curl -s -o /dev/null -w '%{http_code}\n' https://cutroom-production-0f3c.up.railway.app/
      ```
      `{"ok":true}` and `200`. Health alone passes while the SPA is missing;
      that shipped once.
- [ ] **2. Tools chip reads native.** Open the judge link. The topbar says
      `tools: 39 · native`. `unavailable` means an insecure origin or the flag
      is off. `polyfill` means you left `?webmcp=polyfill` on; drop it, the
      video must show the native API.
- [ ] **3. Chrome flags on** (Chrome path only):
      `chrome://flags/#enable-webmcp-testing` and
      `chrome://flags/#devtools-webmcp-support` Enabled, Chrome restarted,
      version 149+. Measured on Chrome 152.0.7977.65 (see
      `docs/TESTING-WEBMCP.md` §1): `--enable-features=WebMCP` alone is enough
      for the JS API, and the two flags only light up the DevTools pane. No
      origin-trial token.
- [ ] **4. ChatGPT site tools on** (hero path): ChatGPT Desktop, Settings ›
      Browser › **Enable site tools**. Not an Enterprise or Edu account. Model
      is GPT-5.6 Sol or Terra. Open the judge link in the in-app browser and
      confirm the tool list is picked up before you start.
- [ ] **5. Lane defaults are what you intend.** Settings › Backends, and the
      project's lane defaults. For the **recording** the paid lanes should be
      live so the takes are real: still `openrouter-image:google/gemini-2.5-flash-image`,
      motion `fal:fal-ai/wan/v2.2-a14b/image-to-video/turbo`, vo/music/sfx
      `elevenlabs`, direction `openrouter:z-ai/glm-5.3-flash`. For a
      **rehearsal**, set every lane to `mock` so nothing is spent. Screenshot
      the lane table either way so you know what the run cost.
- [ ] **6. Budget headroom.** `GET /api/system` returns
      `budget: { spent, limit }` for the rolling 24 hours against
      `CUTROOM_DEMO_BUDGET_USD` (10).
      ```bash
      curl -s -H "Authorization: Bearer $CUTROOM_ADMIN_TOKEN" \
        https://cutroom-production-0f3c.up.railway.app/api/system | python3 -m json.tool
      ```
      Unit costs: stills $0.04, motion $0.05 per clip, voice, music and SFX
      $0.02 per take. A full recording pass is well under a dollar. If under $2
      of headroom remains, raise the cap or move to mock lanes. A 402 in the
      middle of Block A ruins the take.
- [ ] **7. Nothing paused.** No `PAUSED` sentinel, no per-project pause, no
      pause banner in the topbar.
- [ ] **8. Agent speed is `watch`.** Append `?agent_speed=watch` to the URL. On
      `fast` the navigation is invisible on video, which defeats the demo.
- [ ] **9. Thumbnails warm.** No black cards on the Film Editor board. There is
      **no** thumbs/warm endpoint; imports chain the job. See §2.
- [ ] **10. Jobs queue empty.** Jobs page shows nothing running. A leftover job
      confuses the topbar chip in Block D.
- [ ] **11. The finished cut is in the Cuts gallery** on `two-claudes` and
      plays. Block B is built on it.
- [ ] **12. Screen set up** (§3) and Do Not Disturb on.

---

## 1. Reset

The demo instance carries real produced work. **A full reset destroys the Two
Claudes renders**, which cost about $1.50 and roughly forty minutes of agent
driving to make. Do not run one casually. For the recording you almost
certainly want §5 (between-takes cleanup) instead.

**Warm cleanup (what you normally want).** Delete only the takes the previous
run created, so the takes rail is not full of near-identical stills:
Shot Editor › takes rail › filter `still` › delete today's timestamps. Leave
keepers and timeline sources alone.

**Re-seed a project from script (non-destructive to other projects).** This
recreates shots, cast and lane pins; it does not touch media:

```bash
python3 scripts/seed-film.py \
  --url https://cutroom-production-0f3c.up.railway.app \
  --token "$CUTROOM_ADMIN_TOKEN" --project two-claudes \
  --shots docs/demo-films/two-claudes/shots.jsonl \
  --cast  docs/demo-films/two-claudes/characters.jsonl \
  --lane still=openrouter-image:google/gemini-2.5-flash-image \
  --lane motion=fal:fal-ai/wan/v2.2-a14b/image-to-video/turbo \
  --lane vo=elevenlabs \
  --lane direction=openrouter:z-ai/glm-5.3-flash
```

It is idempotent, so re-running updates in place.

**Full reset (destructive).** Only if the instance is corrupt: clear the
Railway volume's data dir and restart the service, then re-seed with the
command above and re-run production (§4, Run 6). Budget an hour and the API
spend. Verify after:

```bash
curl -s "https://cutroom-production-0f3c.up.railway.app/api/projects?token=<JUDGE_TOKEN>" | head -c 400
```

Expect `two-claudes` with 15 shots, and `next-year` if it is loaded.

---

## 2. Pre-warm

Cold thumbnails are the most visible ugliness in a first-visit recording.
There is no warm endpoint to call; the importer chains the job. So warm by
visiting:

1. Hard-reload the Film Editor for `two-claudes` and scroll the whole board top
   to bottom once, slowly. Every card should show a frame. Scroll back up.
2. Open B03-S1 once and let the monitor load the keeper, then go back. That is
   the shot Block A opens.
3. Open B05-S3 once and let its motion take load. That is Block D.
4. Open the Cuts gallery and play two seconds of the newest cut, so its poster
   thumb and the video are cached.
5. **Then hard-reload once more** with `?agent_speed=watch`, so the recording
   starts from a clean app mount and tool registration happens on camera-side
   load.

---

## 3. Windows and tabs

**Primary layout (ChatGPT path):**

- ChatGPT Desktop maximized, in-app browser on the judge link with
  `&agent_speed=watch`. The only window in frame for Blocks A and D.
- Agent trail drawer expanded, bottom right. It is the proof of work.
- Topbar tools chip visible.
- Nothing else on the desktop, no dock badges.

**Secondary windows (Block E, brought forward at 1:44):**

- Editor with `web/src/agent/registry.ts` open at one complete `ActionDef` and
  `web/src/agent/webmcp.ts` at the `registerTool` loop. 16pt minimum so it
  reads at 1080p.
- A separate Chrome on the judge link, DevTools docked right, Application ›
  WebMCP selected, list scrolled to show `find_shots`, `generate_takes`,
  `freeze_tail`. The count of 39 should be visible.
- A terminal running Claude Code with `chrome-devtools-mcp` v1.8.0 and
  `--categoryExperimentalWebmcp=true`, already connected to that tab. Test
  before recording: `find_shots {"query": "the two chairs shot"}`.

**Chrome-only fallback:** one Chrome window, DevTools docked right at about 40%
width so the page and the WebMCP pane are both legible.

**B-roll:** the production-run artifacts in `/tmp/cutroom-drive/` (see
`VIDEO-SCRIPT.md` Block B). Copy that directory somewhere durable before
recording; it is in `/tmp`.

---

## 4. The runs

Do not improvise phrasings on camera. The resolver and the evals are pinned to
these sentences.

### Run 1 (Block A) · hero turn

```
Make a few more generative cuts of the two chairs shot.
```

| # | Tool | Args | Expected |
|---|---|---|---|
| 1 | `find_shots` | `{"query":"the two chairs shot"}` | `B03-S1` first (two wooden chairs in an amber spotlight, act 2), with ordinal, beat, act, type, summary |
| 2 | `generate_takes` | `{"shot":"B03-S1","lane":"still","count":3}` | on paid lanes returns `{ok:false, error:"needs_confirmation", backend, cost_class}` first |
| 3 | `generate_takes` | same plus `confirm_cost:true` | 3 job ids, backend name, cost class, settled takes with thumbs |

The agent may call `open_shot` between 1 and 2; either sequence is fine, the
tools navigate themselves. `count: "a few"` also resolves to 3.

**Visible:** board scrolls, B03-S1 rings, Shot Editor mounts, Generate tab,
Still sub-tab, prompt fills, submit rings and fires three times, three take
cards land, trail counts 4 to 6 steps.

**Fallbacks:**
- *Agent asks which shot first*: it hit `ambiguous`. Answer "B03-S1" and
  continue. Do not re-record, this is a good look.
- *Stops on `needs_confirmation`*: say "yes, go ahead". Keep that exchange in
  the video; it is the human-in-the-loop story.
- *402 budget exhausted*: switch the still lane to `mock` in Settings, reload,
  re-run. Mock returns real footage from the film in under a second.
- *No tool chip at all*: the client never saw the tool list. Reload in the
  in-app browser and wait for the topbar chip before typing.

### Run 2 (Block D) · freeze the tail

```
Keep the first second of the letter flood and freeze the rest.
```

| # | Tool | Args | Expected |
|---|---|---|---|
| 1 | `select_take` | `{"shot":"B05-S3","take":"newest motion"}` | selected path, kind `motion`, duration |
| 2 | `freeze_tail` | `{"shot":"B05-S3","live_seconds":1.0}` | job id, then the settled frozen take |

**Visible:** takes filter moves to motion, the newest motion take highlights
and loads, Motion edits tab opens, live seconds shows `1.0`, freeze control
rings and fires, the new take plays as one second of flood then a true hold.

Motion takes exist on **B02-S2, B04-S2, B05-S3**. B05-S3 is the letter flood
and the one the script uses.

**Fallbacks:**
- *Clip-extension guard message*: the selected take is a still. Say "use the
  newest animated take" and re-run. Do not disable the guard for the demo.
- *Resolver picks a crop intermediate*: crop intermediates are excluded from
  "the newest clip" by design. If it still lands wrong, name the take
  explicitly from the rail.

### Run 3 (Block D, second half) · show me

```
How would I do that myself?
```

`show_me` with `{"feature":"freeze tail"}`. Navigates to Shot Editor › Motion
edits, rings the freeze control, returns the `howTo` sentence and
`where.label`. Nothing runs.

**Fallback:** if the agent answers from memory, rephrase to "show me where that
control is". If it still will not call, prime it with "what can you do here?",
which calls `list_features`.

### Run 4 · the audio lane (optional, for the fourth prompt)

```
Give the whole film a quiet piano bed and a key press on the typing shot.
```

Expect `generate_music` for the bed, `generate_sfx` plus `place_cue` for the
key press on **B04-S2** (the hands on the keyboard), and `list_cues` to show
the cue sheet. The Audio tab's music and SFX sections fill and submit on
screen; the cue lands on the film cue strip under the Cuts gallery.

### Run 5 (Block B tail) · cut the film

```
Cut the film.
```

| # | Tool | Args | Expected |
|---|---|---|---|
| 1 | `cut_film` | `{"scope":"full","res":"720"}` | job id |
| 2 | `wait_for_jobs` | `{"jobs":[...],"timeout_s":60}` | status, then the animatic path and duration |

**Visible:** Film Editor, scope sets, Cut button rings and fires, job chip in
the topbar, the animatic appears in the Cuts gallery. Expect about 130
seconds at 720p. The reference cuts are `/tmp/cutroom-drive/cut3/two-claudes-cut3.mp4`
(130.0s) and `cut1/animatic1.mp4` (124.5s, before the last sources were set).

**Fallbacks:**
- *`wait_for_jobs` times out at 60s*: the agent should report `running` with a
  hint to call again. Have it call `get_jobs`. On video, cut the wait and
  caption it "sped up".
- *Assembly fails*: check the Jobs log tail. Most likely a missing VO asset.
  Fall back to playing the existing cut from the gallery.

### Run 5b · start a film from nothing

The judge-path answer to "can it make something new?". Nothing on this instance
is touched: it creates its own project.

```
Build me a comical short anime about the French Revolution.
```

| # | Tool | Args | Expected |
|---|---|---|---|
| 1 | `create_project` | `{"title":"The Bread Riot"}` | `project`, `url`, the lane defaults it inherited |
| 2 | `write_script` | `{"shots":[…6 shots…]}` | `count: 6`, sids `B01-S1 … B03-S2`, `total_seconds` |
| 3 | `set_project_cast` | `{"characters":[{"name":"Margot","descriptor":"the baker who runs out of bread"}]}` | the cast with derived aliases |
| 4 | `generate_takes` | `{"shot":"B01-S1","lane":"still","count":1}` | job, then the take |
| 5 | `synthesize_vo` | `{"shot":"B01-S1"}` | the narration line, from the script |
| 6 | `cut_film` | `{"scope":"full","res":"720"}` | the animatic |

**Visible:** Projects page, the slug typed into "New empty project", create
rings and fires, the new empty Film Editor, then the strip filling with six
shots and the first shot's Script tab showing the prompt the agent wrote.

**Fallbacks:**
- *429 on `create_project`*: the visitor cap is 3 films per token per rolling
  24 h (`CUTROOM_DEMO_PROJECTS_PER_TOKEN`). Restart the instance, use the admin
  token, or run `write_script` with `replace: true` on a film made earlier.
- *Slates instead of stills*: the lanes on a brand-new project come from
  `CUTROOM_LANE_*`. Check them with `list_backends`, which reports the lane
  defaults alongside the backends.
- Six shots at about 6 seconds is the right size for camera. The ceilings are
  40 shots and 300 seconds; past those the server refuses in plain words.

### Run 6 · reproduce the whole production (not on camera)

This is how the film was made, and how to remake it after a destructive reset.
It runs the tools from real Chrome against the native API, one screenshot and
one JSON result per call:

```bash
python3 scripts/make-run-steps.py docs/demo-films/two-claudes/shots.jsonl > /tmp/run.json
cd web && node scripts/agent-drive.mjs \
  --url https://cutroom-production-0f3c.up.railway.app/ \
  --token "$CUTROOM_ADMIN_TOKEN" --steps /tmp/run.json --out /tmp/cutroom-drive/full --headed
```

`make-run-steps.py` takes `--skip-stills`, `--no-motion`, `--no-vo`,
`--no-cut`, `--only B01-S1,B01-S2` and `--motion-waits N` for partial passes.
`agent-drive.mjs` also takes `--list` and `--call <tool> '<json>'` for one-off
calls. Admin is exempt from the demo rate limits, which is why production uses
the admin token.

### Run 7 (Block E) · Claude Code through chrome-devtools-mcp

```
Use the page tools to find the two chairs shot and tell me what plays on it.
```

`find_shots` then `describe_shot`. Read-only, so no confirmation and no spend.
The browser navigates while the terminal prints. That side by side is the whole
point of the block.

**Fallback:** if the page tools do not appear, confirm
`--categoryExperimentalWebmcp=true` and that the tab is active. If it still
fails, cut Block E to the DevTools pane alone and extend Block F.

### Optional segment · the sample film *Next Year*

Only `[if the *Next Year* project is loaded]`. Switch projects, then:

```
Make a few more generative cuts of the David Ross close-up.
```

`find_shots` resolves `B10-S2`. For the ambiguity beat instead, use *"the
David Ross close up, shot 37"*: name says B10-S2, number says B11-S4, the
resolver returns both with reasons and confidence `ambiguous`, and nothing
renders until you answer.

---

## 5. Between takes

If a run goes wrong and you need to re-record a block:

1. Do **not** run a full reset (§1). It destroys the produced film.
2. Delete only the takes that run created: takes rail, current timestamps.
3. Clear the Agent trail (drawer › clear) so the step count starts at zero.
4. Hard-reload with `?agent_speed=watch`. Confirm the chip re-reads native.
5. In ChatGPT, start a new conversation. A stale one references takes that no
   longer exist.

## 6. After recording

- [ ] Note the session spend against the budget (`GET /api/system`).
- [ ] Decide the cap for judging week deliberately. Judges will generate; that
      is expected and budgeted.
- [ ] Confirm the Two Claudes cut is still the newest in the Cuts gallery, so
      judges land on the state the video shows.
- [ ] Re-run pre-flight lines 1, 2, 9 and 11.
- [ ] Copy `/tmp/cutroom-drive/` somewhere durable. It is B-roll and it is in
      `/tmp`.
- [ ] Record the run in `docs/TESTING-WEBMCP.md`: date, client, the tool
      sequences that actually fired, and anything that surprised you.

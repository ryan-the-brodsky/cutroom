# Demo video script: Cutroom × WebMCP

> Target 2:45, hard ceiling 2:50. Devpost's limit is 3:00 and judges are not
> required to watch past it. Public YouTube, audio required.
> Narration is spoken by Ryan, first person, plain. Read it flat. No music bed
> over the first 15 seconds so the click and the UI motion carry.
>
> **The rule that beats every other note: the tool call is working on screen by
> 0:08.** No title card, no logo, no "hi, I'm". The organizers said it twice.

Pacing assumption: 150 words per minute, so about 2.5 spoken words per second.
Each block below lists its word budget. If a take runs long, cut narration, not
screen time. Screen recording at 1920x1080, 30fps, cursor visible.

Client on screen is called out per block. Default is **ChatGPT Desktop's in-app
browser** against the hosted URL. If site tools are unavailable on the day, use
the alternate cold open at the end of this file and swap the Chrome DevTools
WebMCP pane in for blocks A and C.

---

## Block A · 0:00-0:16 · The hero turn

**Client:** ChatGPT Desktop, in-app browser, Cutroom already open on the Film
Editor with the 97-shot board visible. Nothing selected.

**On screen:**
- 0:00 The board. Cursor is already in the chat box. Typing starts immediately.
- 0:02 The sentence lands: *"Make a few more generative cuts of the David Ross
  close-up."*
- 0:04 Tool call chip appears: `find_shots`. Then `open_shot`.
- 0:05 The board scrolls itself, shot B10-S2 rings, the app navigates into the
  Shot Editor. The Generate tab opens. The Still console opens.
- 0:09 The prompt field fills. The submit button rings and fires. Three times.
- 0:12 Three new takes slide into the takes rail. The Agent trail drawer in the
  bottom right counts up: 5 steps.
- 0:15 Freeze one beat on the trail.

**Narration (36 words):**
> That is one sentence. The agent found the shot by description, opened it,
> filled the generate console, and submitted three takes with fresh seeds. I
> did not click anything. Everything it touched, I watched it touch.

---

## Block B · 0:16-0:42 · The problem

**Client:** none. Human hands only.

**On screen:**
- 0:16 Cut to the same app. Press ⌘K. The palette opens.
- 0:18 Scroll the palette fast. Roughly a hundred entries go by, each with the
  path where it lives: "Shot Editor › Motion edits › Freeze tail", "Film Editor
  › Quick panel › VO offset", "Compose › Reroll layer".
- 0:28 Stop scrolling. Escape. Cut to the app's real UI and walk it by hand,
  fast: Film Editor, into a shot, five tabs, four generate sub-tabs, the cel
  workbench, the timeline.
- 0:38 Land back on the Shot Editor.

**Narration (62 words):**
> This is a cutting room for an anime short. Ninety-seven shots, five hundred
> takes, a cel compositor, a job queue. About a hundred distinct things you can
> do, and no way to find any of them except clicking. Every deep creative tool
> has this problem. The features exist. Nobody can reach them. That is the gap
> WebMCP fills, and it is not a chatbot in a sidebar.

---

## Block C · 0:42-1:22 · Freeze the tail, then learn to do it yourself

**Client:** ChatGPT Desktop, same session, continuing the conversation.

**On screen:**
- 0:42 Type: *"Keep the first second of the newest one and freeze the rest."*
- 0:46 `select_take` runs. The newest motion take highlights in the rail and
  loads into the monitor.
- 0:49 `freeze_tail` runs. The Motion edits tab opens. The live-seconds field
  fills with 1.0. The freeze control rings and fires.
- 0:56 The new take appears and plays: one second of animation, then a true
  hold. No drift, no boil.
- 1:02 Type: *"How would I do that myself?"*
- 1:05 `show_me` runs. The app navigates to the Motion edits tab and rings the
  freeze control. The tool's answer prints one sentence of how-to.
- 1:12 Take the mouse. Do it by hand on a different take. Same result.
- 1:20 Land.

**Narration (76 words):**
> The first second of a video model is clean. After that it drifts. So the
> whole grammar of this film is built on holding the good part and freezing the
> rest, and the tool knows that rule. One second live, true freeze after.
>
> Then the part I did not expect to care about. Ask how to do it by hand and
> the page teaches you. It walks to the control and rings it. The agent is a
> tour guide for my own software.

---

## Block D · 1:22-1:52 · Cut the film

**Client:** ChatGPT Desktop.

**On screen:**
- 1:22 Type: *"Cut act 1."*
- 1:25 `cut_film` runs. The app navigates to the Film Editor. The scope control
  sets to act 1. The Cut button rings and fires.
- 1:30 A job chip appears in the topbar. `wait_for_jobs` is running.
- 1:34 Speed ramp the wait. The assembler finishes. The animatic appears in the
  Cuts gallery.
- 1:38 Click it. Play about 8 seconds of the real cut with sound: VO over shots,
  true holds, the freeze from Block C in place.
- 1:50 Pause on a frame.

**Narration (58 words):**
> Now the thing I actually spend my day on. Cut act 1. It sets the scope, runs
> the assembler, waits on the job, and hands back a film. That is a hundred and
> ninety-four seconds of animatic built out of keepers, overrides and takes,
> with the voice tracks placed. One sentence, and the movie is on screen.

---

## Block E · 1:52-2:28 · How it is built

**Client:** cut between the editor showing code and a second window running
Claude Code with `chrome-devtools-mcp` driving the same page.

**On screen:**
- 1:52 Split or cut to `web/src/agent/registry.ts`. Scroll one `ActionDef`
  slowly enough to read the fields: `name`, `description`, `inputSchema`,
  `where`, `howTo`, `execute`. Highlight `where` and `howTo`.
- 2:02 Cut to `web/src/agent/webmcp.ts`. Show the ten lines that matter:
  `document.modelContext.registerTool(tool, { signal })` in a loop over the
  registry.
- 2:08 Cut to a simple diagram card, three arrows off one box: registry →
  WebMCP tools, registry → ⌘K palette, registry → show me.
- 2:14 Cut to Chrome DevTools › Application › WebMCP, tool list visible, count
  in frame.
- 2:18 Cut to Claude Code in a terminal calling `find_shots` and
  `generate_takes` through `chrome-devtools-mcp` against the same open tab. The
  browser window moves in response.
- 2:26 Land on the browser.

**Narration (74 words):**
> Under it there is one registry. Every feature is one entry: schema, where it
> lives in the UI, how a human does it by hand, and how to run it. WebMCP tools
> come off that list. So does the command palette. So does show me. One list,
> three surfaces, so nothing drifts apart.
>
> And it is the page publishing the tools, not a server. Any client that speaks
> WebMCP gets them. Here is Claude Code driving the same tab.

---

## Block F · 2:28-2:45 · Why it matters

**Client:** none. The Film Editor, static, act 1 animatic paused on a good
frame.

**On screen:**
- 2:28 Slow pull back to the full board of 97 shots.
- 2:38 Cut to a black card: `<JUDGE_URL>` and the repo URL, held 5 seconds.
  No animation, no logo sting.

**Narration (43 words):**
> Every serious creative tool is a hundred features nobody can find. This is
> what it looks like when the page hands them to an agent instead of hiding
> them in menus, and the agent works in front of you instead of behind you.

**Total: 2:45. Narration: 349 words.**

---

## Alternate cold open (30 seconds) if ChatGPT site tools are unavailable

Use this in place of Block A, and swap the DevTools pane in for blocks C and D
as well. Everything else in the script stands. It costs 14 seconds, so trim
Block B to 0:16-0:36 to stay under 2:50.

**Client:** Chrome 149+ with `chrome://flags/#enable-webmcp-testing` and
`#devtools-webmcp-support` enabled. Alternatively the Model Context Tool
Inspector extension, which shows the same tool list in a side panel.

**On screen:**
- 0:00 Chrome, Cutroom on the Film Editor, DevTools already docked right and
  already on **Application › WebMCP**. The tool list is in frame from frame one,
  scrolled so `find_shots`, `generate_takes` and `freeze_tail` are visible.
- 0:03 Click `find_shots`. Type the argument
  `{"query": "David Ross close-up"}`. Run.
- 0:06 The result panel returns B10-S2 with confidence `exact` and its
  ordinal, beat and summary.
- 0:09 Click `generate_takes`. Argument
  `{"shot": "B10-S2", "lane": "still", "count": 3}`. Run.
- 0:12 The page on the left navigates itself: Film Editor, shot rings, Shot
  Editor, Generate tab, Still console, prompt fills, submit rings and fires
  three times.
- 0:22 Three takes land in the rail. The Agent trail shows the steps.
- 0:28 Land.

**Narration (68 words):**
> This is the page's own tool list, read straight out of Chrome DevTools. No
> extension, no server, no wrapper. The page registered these on
> `document.modelContext` when it loaded.
>
> Find the shot by description. Generate three takes on it. And watch the left
> half of the screen, because the tool does not call an API behind my back. It
> drives the interface I am looking at.

---

## Recording notes

- Record with the agent speed set to `watch` (about 350ms per visible step) so
  the navigation reads on video. `fast` is for tests.
- Do not narrate over the animatic playback in Block D. Let the film play.
- Do not speed-ramp anything except the job wait in Block D, and label it with
  a small "sped up" caption so nobody thinks the assembler is instant.
- Keep the topbar tools chip in frame in Blocks A, C and D. It reads
  "tools: <TOOL_COUNT> · native" and it is the proof the API is live.
- No third-party music. If a bed is wanted, use the film's own score stem,
  which is mine.
- Upload **public**, not unlisted. Title:
  `Cutroom: directing an anime short with WebMCP`. Put the three prompts and
  the live URL in the YouTube description.

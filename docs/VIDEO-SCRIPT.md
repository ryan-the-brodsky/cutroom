# Demo video script: Cutroom × WebMCP

> Target 2:45, hard ceiling 2:50. Devpost's limit is 3:00 and judges are not
> required to watch past it. Public YouTube, audio required.
> Narration is spoken by the author, first person, plain. Read it flat.
>
> **The rule that beats every other note: the tool call is working on screen by
> 0:08.** No title card, no logo, no "hi, I'm". The organizers said it twice.

Primary demo is the **Two Claudes** project, a 130-second short that an agent
produced end to end on the hosted demo through these tools. It needs no
private footage, it is on the judges' own live URL, and the fact that it
exists is the strongest thing we have to show.

The sample film *Next Year* (project `next-year`) appears only in the optional
segment marked `[if the next-year project is loaded]`. Cut it if time is tight; nothing
depends on it.

Pacing: 150 words per minute, about 2.5 spoken words per second. Word budgets
per block below. If a take runs long, cut narration, not screen time. Record
1920x1080 at 30fps, cursor visible, `?agent_speed=watch`.

**B-roll available** from the real production runs in `/tmp/cutroom-drive/`:
- `full/page@*.webm`: Playwright screen recording of the 120-step full run.
- `full/`, `motion/`, `finish/`, `sources/`, `b01s1/`: numbered PNG + JSON
  pairs, one per tool call, named for the tool. Good for the montage in Block B
  and the proof cards in Block E.
- `cut1/animatic1.mp4` (124s, first cut), `cut2/animatic2.mp4`, and
  `cut3/two-claudes-cut3.mp4` (130s, the final cut). `cut1/contact.jpg` and
  `cut2/contact2.jpg` are contact sheets.

---

## Block A · 0:00-0:18 · The hero turn

**Client:** ChatGPT Desktop, in-app browser, Cutroom open on the Two Claudes
Film Editor with the 15-shot board visible. Nothing selected.

**On screen:**
- 0:00 The board. Cursor already in the chat box. Typing starts immediately.
- 0:02 The sentence lands: *"Make a few more generative cuts of the two chairs
  shot."*
- 0:04 Tool call chip: `find_shots`. Then `generate_takes`.
- 0:05 The board scrolls itself, shot B03-S1 rings, the app navigates into the
  Shot Editor. Generate tab opens. Still console opens.
- 0:09 The prompt field fills. The submit control rings and fires. Three times.
- 0:13 Three new takes land in the takes rail. The Agent trail counts up.
- 0:17 Hold one beat on the trail.

**Narration (40 words):**
> That is one sentence. The agent found the shot by description, opened it,
> filled the generate console, and submitted three takes with fresh seeds. I
> did not click anything. Everything it touched, I watched it touch, on the
> real interface.

---

## Block B · 0:18-0:48 · The film the agent made

**Client:** none. Playback and B-roll.

**On screen:**
- 0:18 Cut to the Cuts gallery. Click the newest cut. Play
  `two-claudes-cut3.mp4` from the top with sound: the dorm silhouette, the two
  terminal windows facing each other down the server aisle, VO over it.
- 0:30 Under the continuing film audio, cut to a fast montage of the run
  screenshots from `/tmp/cutroom-drive/full/`, in numbered order, four or five
  per second. The tool name is in each filename; overlay it small in the
  corner: `generate_takes`, `wait_for_jobs`, `select_take`, `set_keeper`,
  `synthesize_vo`, `freeze_tail`, `cut_film`.
- 0:44 Land back on the film playing.

**Narration (68 words):**
> This is Two Claudes. Two minutes, fifteen shots, about a chatbot wired to a
> copy of itself. Stills, three animated bursts, fifteen voice lines, a piano
> bed, sound effects, and four assembler passes.
>
> An agent made all of it. Not with a pipeline script. It called the page's own
> tools, on the same hosted URL in the submission, pressing the same buttons I
> press. It cost about a dollar fifty.

---

## Block C · 0:48-1:06 · The problem

**Client:** none. Human hands only.

**On screen:**
- 0:48 Cut to the app. Press ⌘K. The palette opens.
- 0:50 Scroll it fast. Every entry shows where it lives: "Shot Editor › Motion
  edits › Freeze tail", "Film Editor › Quick panel › VO offset", "Compose ›
  Reroll layer".
- 0:57 Escape. Walk the real UI by hand, fast: Film Editor, into a shot, five
  tabs, four generate sub-tabs, the cel workbench, the timeline, the cue strip.
- 1:04 Land back on the Shot Editor.

**Narration (44 words):**
> Here is why that matters. This is about a hundred distinct actions across two
> rooms and five tabs. Every deep creative tool has this problem. The features
> exist and nobody can reach them. That is the gap, and it is not a chatbot in
> a sidebar.

---

## Block D · 1:06-1:44 · Freeze the tail, then learn to do it yourself

**Client:** ChatGPT Desktop, same session.

**On screen:**
- 1:06 Type: *"Keep the first second of the letter flood and freeze the rest."*
- 1:10 `select_take` runs. The newest motion take on B05-S3 highlights in the
  rail and loads into the monitor.
- 1:13 `freeze_tail` runs. Motion edits tab opens. Live seconds fills with 1.0.
  The freeze control rings and fires.
- 1:20 The new take plays: the block of glyphs floods upward, then a true hold.
  No drift, no boil.
- 1:26 Type: *"How would I do that myself?"*
- 1:29 `show_me` runs. The app navigates to Motion edits and rings the freeze
  control. The tool prints one sentence of how-to.
- 1:35 Take the mouse. Do it by hand on a different take. Same result.
- 1:42 Land.

**Narration (74 words):**
> The first second of a video model is clean. After that it drifts. So the
> whole grammar of this thing is hold the good part, freeze the rest, and the
> tool knows that rule. One second live, true freeze after.
>
> Then the part I did not expect to care about. Ask how to do it by hand and
> the page teaches you. It walks to the control and rings it. The agent is a
> tour guide for my own software.

---

## Block E · 1:44-2:26 · How it is built

**Client:** cut between the editor, DevTools, and Claude Code driving the same
page through `chrome-devtools-mcp`.

**On screen:**
- 1:44 Cut to `web/src/agent/registry.ts`. Scroll one `ActionDef` slowly enough
  to read the fields: `name`, `description`, `inputSchema`, `where`, `howTo`,
  `execute`. Highlight `where` and `howTo`.
- 1:53 Cut to `web/src/agent/webmcp.ts`, the `registerTool` loop in frame.
- 1:58 Cut to a plain diagram card: one box labelled "action registry", three
  arrows out to "WebMCP tools", "⌘K palette", "show me".
- 2:04 Cut to Chrome DevTools › Application › WebMCP, the tool list visible,
  the count of 35 in frame.
- 2:09 Cut to Claude Code in a terminal calling `find_shots` and
  `describe_shot` through `chrome-devtools-mcp` against the same open tab. The
  browser window moves in response.
- 2:18 Cut to a still card: the run screenshots tiled, with the count overlay
  "257 tool calls, 15 tools, one film".
- 2:24 Land on the browser.

**Narration (80 words):**
> Underneath there is one registry. Every feature is one entry: schema, where
> it lives in the UI, how a human does it by hand, and how to run it. The
> twenty-three WebMCP tools come off that list. So does the command palette. So
> does show me. One list, three surfaces, so nothing drifts apart.
>
> And it is the page publishing the tools, not a server. Any client that speaks
> WebMCP gets them. Here is Claude Code driving the same tab from a terminal.

---

## Block F · 2:26-2:45 · Why it matters

**Client:** none.

**On screen:**
- 2:26 The Two Claudes board, all 15 cards filled, then the final frame of the
  film: the empty desk chair at first light.
- 2:38 Cut to a black card with the live URL and the repo URL. Hold 5 seconds.
  No animation, no logo sting.

**Narration (46 words):**
> Every serious creative tool is a hundred features nobody can find. This is
> what it looks like when the page hands them to an agent instead of hiding
> them in menus. The agent worked in front of me, on my screen, and we made a
> film.

**Total: 2:45. Narration: 352 words.**

---

## Optional segment `[if the *Next Year* project is loaded]`

Drop in after Block D at about 1:44, costs 14 seconds, and push everything
after it back. Only worth it if *Next Year* is loaded on the demo instance
and its thumbnails are warm. Cut it first if any other block runs long.

**On screen:**
- Switch projects to `next-year`, 97 shots on the board.
- Type: *"Make a few more generative cuts of the David Ross close-up."*
- `find_shots` resolves B10-S2 and the same navigation plays out on a
  completely different film.

**Narration (30 words):**
> Same tools, a different film. This one is mine, ninety-seven shots. The
> resolver takes the way a director actually talks. Ask for the David Ross
> close-up and it finds the shot.

If you want the ambiguity beat instead, type *"the David Ross close up, shot
37"*. Two shots match, the agent asks which, and nothing renders. That is 8
seconds and it makes the resolver point better than the happy path does.

---

## Alternate cold open (30 seconds) if ChatGPT site tools are unavailable

Use in place of Block A, and swap the DevTools pane in for Block D as well.
Everything else stands. It costs 12 seconds, so trim Block C to 0:48-1:02.

**Client:** Chrome 149+ with `chrome://flags/#enable-webmcp-testing` and
`#devtools-webmcp-support` enabled, or the Model Context Tool Inspector
extension, which shows the same tool list in a side panel.

**On screen:**
- 0:00 Chrome, Cutroom on the Two Claudes Film Editor, DevTools already docked
  right and already on **Application › WebMCP**. The tool list is in frame from
  frame one, scrolled so `find_shots`, `generate_takes` and `freeze_tail` show.
- 0:03 Click `find_shots`. Argument `{"query": "the two chairs shot"}`. Run.
- 0:06 The result returns B03-S1 with its ordinal, beat, act and summary.
- 0:09 Click `generate_takes`. Argument
  `{"shot": "B03-S1", "lane": "still", "count": 3}`. Run.
- 0:12 The page on the left navigates itself: Film Editor, shot rings, Shot
  Editor, Generate tab, Still console, prompt fills, submit rings and fires
  three times.
- 0:22 Three takes land in the rail. The Agent trail shows the steps.
- 0:28 Land.

**Narration (66 words):**
> This is the page's own tool list, read straight out of Chrome DevTools. No
> extension, no server, no wrapper. The page registered these on
> `document.modelContext` when it loaded.
>
> Find the shot by description. Generate three takes on it. And watch the left
> half of the screen, because the tool is not calling an API behind my back. It
> is driving the interface I am looking at.

---

## Recording notes

- Set `?agent_speed=watch` so the navigation reads on video. `fast` is for
  tests and makes the whole point invisible.
- Do not narrate over the film in Block B once the montage ends. Let it play.
- Speed-ramp only the job waits, and caption them "sped up" so nobody thinks
  the assembler is instant.
- Keep the topbar tools chip in frame in Blocks A and D. It reads
  `tools: 35 · native` and it is the proof the API is live.
- The music bed in Two Claudes is generated by the tools, so it is ours. No
  third-party music anywhere else.
- Upload **public**, not unlisted. Title:
  `Cutroom: an agent made a film through the page's own WebMCP tools`. Put the
  three prompts and the live URL in the YouTube description.

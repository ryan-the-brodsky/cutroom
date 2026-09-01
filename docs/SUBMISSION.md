# Devpost submission copy: Cutroom

> Final text for every field of the WebMCP Challenge submission form.
> Draft: 2026-09-01 (workstream F). Finalize against the shipped build at G3.
> Placeholders in `<ANGLE BRACKETS>` are filled at finalization.
> Deadline: **Thu 2026-09-03, 13:00 PDT.** Submit by 11:00 PDT.

---

## Project name

```
Cutroom
```

## Tagline (60 char limit)

```
Direct an animation studio by sentence, not by clicking.
```

(56 characters. Alternates if a shorter one is wanted:
`An animation studio your agent can drive.` (40) ·
`One sentence in. Six screens of clicking out.` (45))

## Built with

```
webmcp · document.modelContext · react · typescript · vite · react-router ·
python · fastapi · sqlalchemy · sse · ffmpeg · pyav · comfyui · fal ·
openrouter · elevenlabs · docker · railway · vitest · pytest · playwright
```

---

## Description: the four required answers

Devpost asks four questions. Each answer below is under 180 words. Paste them
in order under one "About the project" field, keeping the bold question lines.

### 1. Why your use case is a strong fit for WebMCP

Cutroom is the room where I cut an anime short. It holds 97 shots, 567 takes,
a cel compositor, a timeline, a job queue, and roughly a hundred distinct
actions spread across two rooms, five tabs and four generation consoles.
Everything works. Almost nothing is findable. That is the Photoshop problem,
and it is exactly the shape WebMCP fits: the capability already exists, the
discovery layer is the thing that is missing.

The page is also the only thing that knows the state that matters. Which shot
is open. Which take is selected. Which backend a lane will actually bill.

So the use case is a sentence: *"Make a few more generative cuts of the David
Ross close-up."* By hand that is open the film, scroll 97 cards, recognize
B10-S2, double-click in, Generate tab, Still console, retype the prompt,
change the seed, submit, three times. Six screens, and you have to already
know the shot ID. With WebMCP it is one turn, and the app shows its work while
the agent does it.

### 2. How it creates a better user experience

Every tool executes through the UI you are looking at. Only reads are silent.
When the agent generates takes it navigates to the Film Editor, opens shot
B10-S2, switches to the Generate tab, selects the Still console, fills the
prompt field, rings the submit button, and presses it. You watch your own app
get driven.

That buys two things. Trust, because you can see what changed and reverse it
by hand. And learning, because the same machinery teaches: ask "how do I do
that myself" and the `show_me` tool navigates to the control, pulses it, and
returns one sentence of how-to. A ⌘K palette is the third projection of the
same registry, so anything the agent can call is something you can find.

An Agent trail drawer logs every step with the control it touched. Click a
step and that control rings again. New directors on the tool get a guided
tour that happens to also do the work.

### 3. What people and agents can do together that was hard before

Direction is ambiguous on purpose. "The David Ross close-up, shot 37" names
two different shots in my film: B10-S2 by description, B11-S4 by number. The
resolver returns both with reasons and a confidence of `ambiguous`, and
nothing renders until I answer. An agent that guessed would have spent GPU
minutes on a cemetery wide.

Next, the film's own edit grammar. `direct_shot` compiles "hold his pose for
the rest of the line" into an EditPlan and puts it on screen. It does not run
it. I read the ops, then apply. The agent proposes, the grammar validates, I
approve.

Cost lives in the tool, not the prompt. Paid lanes refuse without
`confirm_cost: true` and say what they will spend first.

Generation takes minutes, so tools hand back job IDs and a bounded wait tool
closes the loop. The agent is doing studio work, not form filling.

### 4. Briefly explain how you implemented WebMCP

One registry, three surfaces. `web/src/agent/registry.ts` holds an
`ActionDef` per feature: name, description, JSON Schema, annotations, where it
lives in the UI (route, query params, and a `data-action` anchor), how a human
performs it by hand, and an `execute` that drives imperative page handles the
React pages publish on mount. The WebMCP tools, the ⌘K palette and `show_me`
are projections of that one list.

`web/src/agent/webmcp.ts` is the bridge. At app mount it reads
`document.modelContext` (falling back to the deprecated
`navigator.modelContext`) and calls `registerTool(tool, { signal })` once per
action under a single `AbortController`. Tools are app-level with explicit
`shot` arguments and navigate themselves, following Chrome's guidance that
tools be "atomic, composable, and distinct." `execute` never rejects, since a
rejection surfaces as an opaque `UnknownError`; it resolves
`{ ok: false, error, hint }`. Chrome delivers input as a JSON string, so we
normalize. Vitest enforces Chrome's budgets on every entry.

---

## What's new since Aug 25

Cutroom itself was built 2026-07-12 to 07-15 and sat unchanged until this
week. Every line of the agent layer was written after the submission period
opened, in a 45-hour sprint starting 2026-09-01 16:00 PDT:
`web/src/agent/**` (contract, registry, WebMCP bridge, page handles, anchors
and pulse, agent trail, ⌘K palette, shot resolver, cost guard, job settling,
and <TOOL_COUNT> tool implementations), URL state for the Shot Editor and
Film Editor so deep links exist at all, a cast index in the importer plus a
`GET /api/projects/{pid}/cast` route, demo mode with judge and admin token
roles, boot-time provider seeding with a spend cap, and the test suites that
hold the whole thing to Chrome's tool budgets. `docs/PRIOR-WORK.md` lists it
by file with commit ranges. Prior work is the snapshot commit `cebcf93`;
everything after it is this week.

---

## Testing instructions for judges

```
Live URL: <JUDGE_URL>

The link already carries the judge token (?token=...). No account, no signup.
Open it in one of these two environments:

ChatGPT Desktop (the fastest path)
  1. Settings > Browser > turn on "Enable site tools".
  2. Open <JUDGE_URL> in the in-app browser.
  3. Wait for the topbar chip to read "tools: <TOOL_COUNT> · native".
  4. Ask for one of the prompts below.

Google Chrome 149 or later
  1. chrome://flags/#enable-webmcp-testing  -> Enabled
  2. chrome://flags/#devtools-webmcp-support -> Enabled
  3. Restart Chrome, then open <JUDGE_URL>.
  4. DevTools > Application > WebMCP lists all <TOOL_COUNT> tools and runs
     them by hand if you would rather not use an agent client. Try
     find_shots {"query": "David Ross close-up"} then generate_takes.

Notes
  - The demo runs on a real film (97 shots, 567 takes) and does real
    generation on metered lanes, so there is a daily spend cap. If a paid
    lane reports "budget exhausted", the mock lane still returns real footage
    instantly and every tool still works end to end.
  - Generation tools ask for confirm_cost before they spend anything. That is
    by design; say yes.
  - Watch the page, not the chat. Every tool drives the visible UI.
```

## Three prompts to try

```
1. "Make a few more generative cuts of the David Ross close-up."
2. "Keep the first second of the newest one and freeze the rest."
3. "Cut act 1."
```

Expected behaviour, in order: (1) `find_shots` resolves B10-S2, the app
navigates to the Shot Editor and opens the Still console, three takes are
submitted with fresh seeds and land in the takes rail. (2) `select_take` picks
the newest motion take, the Motion edits tab opens, live seconds is set to
1.0, and a frozen take comes back under the FIRST-SECOND LAW. (3) `cut_film`
rings the Cut button, the assembler builds the act 1 animatic, and it plays in
the Cuts gallery.

A fourth, if a judge wants to see the ambiguity handling: *"the David Ross
close-up, shot 37."* Two shots match, the agent asks which, nothing renders.

---

## Links

| Field | Value |
|---|---|
| Live URL | `<JUDGE_URL>` |
| Public repo | `<REPO_URL>` (MIT, license visible in the About panel) |
| Demo video | `<YOUTUBE_URL>` (public, under 3:00, audio) |
| Implementation plan | `<REPO_URL>/blob/main/docs/WEBMCP-PLAN.md` |
| Prior vs new work | `<REPO_URL>/blob/main/docs/PRIOR-WORK.md` |
| Test evidence | `<REPO_URL>/blob/main/docs/TESTING-WEBMCP.md` |

## Code excerpt for the Devpost body

Judges read code in the description. Paste this block under answer 4.

```ts
<EXCERPT from web/src/agent/webmcp.ts>
```

Fill at finalization with about 20 lines: the `document.modelContext` pickup,
the `registerTool(tool, { signal })` loop over the registry, the JSON-string
input normalization, and the never-reject `execute` wrapper.

---

## Categories and tags on the Devpost form

- Team: solo (Ryan Brodsky).
- Language: English.
- Video: public YouTube, not unlisted. Check this twice; unlisted videos are
  on the organizers' published list of disqualifying mistakes.
- License: MIT, `LICENSE` at repo root so GitHub's About panel shows it.
- Repo: public **before** submitting. Verify in a logged-out browser.

## Pre-submit checklist

- [ ] `<JUDGE_URL>` opens logged out, in a fresh profile, and the tools chip
      reads native.
- [ ] All three prompts run clean against the hosted URL, recorded in
      `docs/TESTING-WEBMCP.md`.
- [ ] YouTube video is public, under 3:00, has audio, and shows the tool
      call working inside the first 10 seconds.
- [ ] Repo public, MIT license detected by GitHub, README agent section live.
- [ ] `docs/PRIOR-WORK.md` has real commit hashes, not placeholders.
- [ ] `<TOOL_COUNT>` replaced everywhere in this file.
- [ ] Devpost form submitted by 11:00 PDT Thursday. Screenshot the
      confirmation.

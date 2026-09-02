# Devpost submission copy: Cutroom

> Final text for every field of the WebMCP Challenge submission form.
> Finalized 2026-09-01 against the shipped build (23 tools, hosted demo live).
> Deadline **Thu 2026-09-03, 13:00 PDT**. Submit by 11:00 PDT.
>
> `<JUDGE_TOKEN>` stays a placeholder in this repo on purpose. The author pastes the
> real token into the Devpost testing-instructions field, which is not public.

---

## Project name

```
Cutroom
```

## Tagline (60 char limit)

**Recommended:**

```
An agent made a 2-minute film inside this browser tab.
```

(54 characters. It is also literally true, which is the point.)

Alternates: `Direct an animation studio by sentence, not by clicking.` (56) ·
`One sentence in. Six screens of clicking out.` (45)

## Built with

```
webmcp · document.modelContext · react · typescript · vite · react-router ·
python · fastapi · sqlalchemy · sse · ffmpeg · pyav · comfyui · fal ·
openrouter · elevenlabs · docker · railway · vitest · playwright · pytest
```

---

## Description: the four required answers

Each answer is under 180 words. Paste them in order under "About the project",
keeping the bold question lines.

### 1. Why your use case is a strong fit for WebMCP

Cutroom is a cutting room for AI-generated animation. Shot lab, cel
compositor, motion-edit grammar, voice lane, music and SFX cue sheet,
assembler, job queue. Roughly a hundred distinct actions across two rooms,
five tabs and four generation consoles. Everything works. Almost nothing is
findable. That is the Photoshop problem, and it is the exact shape WebMCP
fits: the capability already exists, the discovery layer is what is missing.

The page is also the only thing that knows the state that matters. Which shot
is open. Which take is selected. Which backend a lane will actually bill.

So the use case is a sentence: *"Make a few more generative cuts of the two
chairs shot."* By hand that is open the film, find the shot, double-click in,
Generate tab, Still console, retype the prompt, change the seed, submit, three
times. Six screens, and you have to already know the shot ID. Through WebMCP
it is one turn, and the app shows its work while the agent does it.

### 2. How it creates a better user experience

Every tool executes through the UI you are looking at. Only reads are silent.
When the agent generates takes it navigates to the Film Editor, opens the
shot, switches to the Generate tab, selects the Still console, fills the
prompt field, rings the submit button, and presses it. You watch your own app
get driven.

That buys two things. Trust, because you can see what changed and reverse it
by hand. And learning, because the same machinery teaches: ask "how do I do
that myself" and `show_me` navigates to the control, pulses it, and returns
one sentence of how-to. A ⌘K palette is the third projection of the same
registry, so anything the agent can call is something you can find.

An Agent trail drawer logs every step with the control it touched. Click a
step and that control rings again. Paid lanes refuse to spend without an
explicit `confirm_cost` and say the number first. The film's look is the app's
job rather than the agent's: every project carries a style register that the
server puts on every still, so a visitor's agent writes what is in the shot and
gets back a film that matches the rest of the film.

### 3. What people and agents can do together that was hard before

We made a film with it. **"Two Claudes"** is a 130-second limited-animation
short about two chatbots wired to each other, and an agent produced it end to
end on the live demo through these WebMCP tools: 15 shots generated, three
motion bursts, 15 voice lines, a piano bed, SFX cues placed, four assembler
passes. About $1.50 of API spend. Every step went through the same buttons a
human clicks, on the hosted URL judges can open right now.

I did not write a pipeline script for that. I wrote a page that publishes its
own tools, and an agent used them the way a person would.

Money is part of the craft, so the tools carry it. `plan_motion` takes a dollar
figure, ranks every shot by how much movement would buy it, and **the agent
picks the model per shot from a registry of cost and use cases** — the better
model while the budget holds, the cheap one when it runs thin, and the one
measured best for dark close-ups whenever the shot is one. `apply_motion_plan`
spends it and stops at the number. When a clip comes back unfaithful to its
plate, every result names the model to rerun on: that is a model property, not
a prompt someone worded badly.

Then a judge in ChatGPT's browser asked the site to build a new comical short
about the French Revolution, and hit the wall: every tool assumed a film
already existed, and making one was reserved for the owner. So an agent can now
start a film from a sentence. `create_project` types the slug on the Projects
page and opens the new Film Editor. `write_script` writes the whole shot list
in one call, in order, with the house prompt style carried in the tool's own
descriptions: a sentence of setting, then "Subject: …", then the framing, then
"cinematic anime film still", narration under 25 words and dialogue lines under
12. Its schema is the thing that teaches, so a model that has never seen
Cutroom writes prompts the still lane can actually use. `set_project_cast`
names who is in it, which is what makes "the Margot close-up" resolve later.
From there the existing tools take over: generate, freeze, voice, score, cut.
A visitor gets three films a day and the same providers the demo runs on, and
the server says so in words when the cap is reached rather than failing
obscurely.

The smaller wins are the ones I feel daily. Ambiguous shot names come back as
candidates with reasons instead of a guess that burns GPU minutes. Edit
instructions compile to a plan that renders on screen and waits for me. The
agent proposes, the film's own grammar validates, I approve.

### 4. Briefly explain how you implemented WebMCP

One registry, three surfaces. `web/src/agent/registry.ts` holds an `ActionDef`
per feature: name, description, JSON Schema, annotations, `where` it lives in
the UI (route, query params, a `data-action` anchor), `howTo` a human performs
it, and an `execute` that drives imperative handles the React pages publish on
mount. The 45 WebMCP tools, the ⌘K palette and `show_me` are projections of
that one list.

`web/src/agent/webmcp.ts` is the bridge. At app mount it reads
`document.modelContext` and calls `registerTool(tool, { signal })` once per
action under a single `AbortController`. Tools are app-level with explicit
`shot` arguments and navigate themselves, following Chrome's guidance that
tools be "atomic, composable, and distinct." `execute` never rejects, since a
rejection surfaces as an opaque `UnknownError`; it resolves
`{ ok: false, error, hint }`. Chrome delivers input as a JSON string, so we
normalize. Vitest holds every entry to Chrome's budgets. 10,596 lines,
41 files, all new.

---

## What's new since Aug 25

Cutroom itself was built 2026-07-12 to 07-15 and sat unchanged until this
week. Every line of the agent layer was written after the submission period
opened, starting 2026-09-01 16:00 PDT: 46 commits, 112 files changed, 18,384
insertions, of which `web/src/agent/**` is 10,596 lines across 41 files, all
new. That covers the action registry and contract, the WebMCP bridge, page
handles and anchors, the pulse and Agent trail, the ⌘K palette, a
natural-language shot resolver with a cast index, a cost and doctrine guard,
the async job pattern, and 39 tool implementations. Plus URL state for the
Shot and Film Editors so deep links exist at all, demo mode with judge and
admin token roles, boot-time provider seeding with a rolling spend cap, the
vitest and Playwright suites (the repo had no front-end tests), and the
"Two Claudes" demo film, which the tools then produced.
`docs/PRIOR-WORK.md` lists it file by file with commit hashes.

---

## Testing instructions for judges

Paste this into the Devpost testing-instructions field with the real token
substituted. That field is not public, so the token is safe there.

```
Live URL (token included, one click, no signup) — this opens the studio directly:
  https://cutroom-production-0f3c.up.railway.app/app?token=<JUDGE_TOKEN>

  The bare URL (no /app) is the public landing page, which explains the project
  and links into the studio. Both register the WebMCP tools, so you can ask the
  page what it can do from either one.

Open it in one of these two environments:

ChatGPT Desktop (the fastest path)
  1. Settings > Browser > turn on "Enable site tools".
  2. Open the URL above in the in-app browser.
  3. Wait for the topbar chip to read the tool count and "native".
  4. Ask for one of the prompts below.

Google Chrome 149 or later
  1. chrome://flags/#enable-webmcp-testing   -> Enabled
  2. chrome://flags/#devtools-webmcp-support -> Enabled
  3. Restart Chrome, then open the URL above.
  4. DevTools > Application > WebMCP lists every tool and runs them by
     hand if you would rather not use an agent client. Try
     find_shots {"query": "the two chairs shot"} and then generate_takes.
  5. If your build does not list those flags, launching Chrome with
     --enable-features=WebMCP is enough on its own. We measured this on
     Chrome 152.0.7977.65; the flags only add the DevTools pane.

What you are looking at
  The demo has two projects. Start with "two-claudes": a 130-second
  limited-animation short that an agent produced end to end on this very
  instance, through these tools. Its finished cut is in the Cuts gallery.
  Watch the page, not the chat. Every tool drives the visible UI: it
  navigates, opens the tab, fills the field, rings the control, presses it.

Notes
  - Generation is real and metered, so there is a daily spend cap. Stills
    cost about $0.04, motion clips $0.05, voice and SFX $0.02. If a paid
    lane reports "budget exhausted", the mock lane still returns real
    footage instantly and every tool still works end to end.
  - Generation tools ask for confirm_cost before spending. Say yes.
  - Add ?agent_speed=watch to slow the agent's visible steps down to
    human-readable pace, or ?agent_speed=fast to skip the pacing.
```

## Three prompts to try

```
1. "Make a few more generative cuts of the two chairs shot."
2. "Keep the first second of the letter flood and freeze the rest."
3. "Cut the film."
```

Expected behaviour: (1) `find_shots` resolves B03-S1, the app navigates into
the Shot Editor and opens the Still console, three takes are submitted with
fresh seeds and land in the takes rail. (2) `select_take` picks the newest
motion take on B05-S3, the Motion edits tab opens, live seconds is set to 1.0,
and a frozen take comes back. (3) `cut_film` rings the Cut button, the
assembler runs, and a 130-second animatic plays in the Cuts gallery.

A fourth if a judge wants the audio lane: *"Give the whole film a quiet piano
bed and a key press on the typing shot."* That runs `generate_music`,
`generate_sfx` and `place_cue`, and the cue lands on B04-S2.

---

## Links

| Field | Value |
|---|---|
| Live URL (studio) | `https://cutroom-production-0f3c.up.railway.app/app?token=<JUDGE_TOKEN>` |
| Landing page | <https://cutroom-production-0f3c.up.railway.app/> |
| Public repo | <https://github.com/ryan-the-brodsky/cutroom> (MIT, detected in About) |
| Demo video | `<YOUTUBE_URL>` (public, under 3:00, audio) |
| Implementation plan | <https://github.com/ryan-the-brodsky/cutroom/blob/main/docs/WEBMCP-PLAN.md> |
| Prior vs new work | <https://github.com/ryan-the-brodsky/cutroom/blob/main/docs/PRIOR-WORK.md> |
| Test evidence | <https://github.com/ryan-the-brodsky/cutroom/blob/main/docs/TESTING-WEBMCP.md> |
| The demo film | <https://github.com/ryan-the-brodsky/cutroom/blob/main/docs/demo-films/two-claudes/README.md> |

## Code excerpt for the Devpost body

Paste under answer 4.

```ts
// web/src/agent/webmcp.ts
function toTool(def: ActionDef<any>, ctx: ActionContext): ModelContextTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: {
      readOnlyHint: def.annotations?.readOnlyHint ?? false,
      untrustedContentHint: def.annotations?.untrustedContentHint ?? false,
      // Chromium-only extra; harmless on spec-shaped implementations.
      consequentialHint: def.annotations?.consequentialHint ?? false,
    },
    // NEVER reject: a rejection surfaces to the agent as an opaque UnknownError.
    execute: async (input, options) => {
      const signal = options?.signal ?? ctx.signal;
      return perform(def.name, normalizeInput(input), { ...ctx, signal });
    },
  };
}

const mc = document.modelContext;
for (const def of agentDefs()) {
  await mc.registerTool(toTool(def, ctx), { signal: controller.signal });
}
```

---

## Devpost form details

- Team: solo (Ryan Brodsky).
- Language: English.
- Video: public YouTube, not unlisted. Check this twice; unlisted videos are
  on the organizers' published list of disqualifying mistakes.
- License: MIT, `LICENSE` at repo root, already detected in the About panel.
- Repo is public.

## Pre-submit checklist

- [ ] `<LIVE_URL>/app?token=…` opens logged out in a fresh profile and the tools
      chip reads the catalogue count plus `native`.
- [ ] `<LIVE_URL>/` renders the landing page and its "Open the studio" button
      lands on `/app`.
- [ ] Old deep links still work: `<LIVE_URL>/p/two-claudes` redirects to
      `<LIVE_URL>/app/p/two-claudes`.
- [ ] All three prompts run clean against the hosted URL, recorded in
      `docs/TESTING-WEBMCP.md`.
- [ ] The Two Claudes cut is in the Cuts gallery on the hosted instance and
      plays.
- [ ] Real judge token pasted into the Devpost testing-instructions field.
      Confirm it is still `<JUDGE_TOKEN>` in the repo.
- [ ] YouTube video public, under 3:00, audio, tool call working by 0:10.
- [ ] `docs/PRIOR-WORK.md` hashes match `git log`.
- [ ] Devpost form submitted by 11:00 PDT Thursday. Screenshot the
      confirmation.

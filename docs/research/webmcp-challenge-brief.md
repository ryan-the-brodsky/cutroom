# The WebMCP Challenge — brief (researched 2026-09-01)

## Deadline and fit

- **Deadline: Thursday, September 3, 2026, 1:00 PM PDT (20:00 UTC).** No edits after.
  Netlify's blog says 5 PM PT and one forum post says Sept 4; the Devpost official rules and
  all three Devpost updates say 1:00 PM PT — treat that as binding.
- **An existing app with WebMCP added qualifies, explicitly.** Rules: "Projects must be either
  newly created during the Hackathon Submission Period or, if the Project existed prior to the
  Submission Period, must have been meaningfully extended using WebMCP after the Submission
  Period start date. Pre-existing Projects will be evaluated only on work added during the
  Submission Period." You must document prior vs new work (timestamped commits). A Devpost
  manager confirmed a pre-existing hosted backend "that your WebMCP layer calls through its
  public interface can stay closed" — but judges must be able to read and evaluate the WebMCP
  implementation, and the repo must contain what's needed for the project to be functional.
- Only one WebMCP challenge exists (no 2026 Chrome Built-in AI Challenge, no Edge hackathon).

## Identity

- **"The WebMCP Challenge"** (rules title: "OpenAI WebMCP Challenge"). Organizer: OpenAI,
  administered by Devpost. Supporters: Google Chrome, Cloudflare, Shopify, Vercel, Render, Netlify.
- <https://webmcp.devpost.com> · rules <https://webmcp.devpost.com/rules> ·
  <https://openai.com/webmcp-challenge/>. ~5,600 registered participants.

## Timeline (Pacific)

- Submission period: Aug 25, 2026 11:00 AM → **Sep 3, 2026 1:00 PM**.
- Judging: Sep 4 10:00 AM → Sep 21 5:00 PM. Winners: Sep 23, 2:00 PM.

## Eligibility

- Age of majority; residents of countries with OpenAI API access; individuals, teams, orgs.
- Excluded regions: Belarus, Brazil, China, Crimea, Cuba, Donetsk, Hong Kong, Iran, North Korea,
  Luhansk, Quebec, Russia, Syria, Venezuela. Excluded: OpenAI/Devpost employees, judges.
- Project must not have had financial/preferential support from OpenAI/Devpost.
- Multiple submissions allowed (confirmed by Devpost staff), each unique; one prize per project.

## Submission requirements (as verbatim as possible)

**Theme:** "Build a WebMCP-powered web app that imagines and explores the future of the open
web—where humans and agents can interact, collaborate, and create together."

1. **Live URL**: "Provide a working live URL that judges can access using ChatGPT's in-app
   browser or Google Chrome with WebMCP enabled." Any host. Credentials (if any) go in the
   testing-instructions field. Free and unrestricted access until judging ends.
2. **Text description** answering: "Why your use case is a strong fit for WebMCP"; "How it
   creates a better user experience"; "what people and agents can do together that was
   difficult or impossible before"; "Briefly explain how you implemented WebMCP."
3. **Demo video**: "A <3-minute public YouTube video showing a clear demo with audio that
   covers what you built and how you used WebMCP." Judges are not required to watch past 3
   minutes. No third-party trademarks/music without permission.
4. **Public repo** (GitHub/GitLab/Bitbucket) with "All necessary source code, assets, and
   instructions required for the project to be functional" and an **open source license file
   detectable at the top of the repository page (About section)**.
5. **Pre-existing projects** "must provide clear documentation distinguishing prior work from
   new work, including evidence that it was meaningfully extended with WebMCP within the
   Submission Period (e.g., timestamped, dated commit history, or equivalent)."
6. Original work, English.
7. Staff clarifications: no specific tool name or snippet required; `react-webmcp`'s
   `useMcpTool` satisfies "uses WebMCP"; a test dataset is fine in place of production data;
   "Judges are not required to test the Project" — they may score from description, images
   and video alone. **The video carries real weight.**

## Judging

**Stage One (pass/fail):** fits the theme and reasonably applies the required APIs.

**Stage Two (equal weight; ties broken in this order):**
1. **WebMCP Leverage** — "How thoroughly and skillfully does the project use WebMCP? Does the
   code reflect genuine effort and a working, non-trivial implementation?"
2. **Execution** — "a working or runnable project with a complete, coherent product
   experience, not just a technical proof of concept?"
3. **Potential Impact** — "a credible, specific case for solving a real problem for a real
   audience? Does the solution actually address that problem?"
4. **Creativity & Ambition** — "How creative and novel is the concept, and how does the
   project differ from existing concepts?"

**Prizes**: 10 winners, each: OpenAI $3,000 + spotlight + Codex Micro + ChatGPT Pro 1 yr;
Netlify $500; Cloudflare $10,000 credits; Vercel credits; Render $300; Shopify gear; Google
Chrome 3 months AI Ultra per member.

**Judges**: Sarah Drasner (Chrome), Ilya Grigorik (Shopify), Andrew Galloni (Cloudflare),
Jude Gao (Vercel), Sean Roberts (Netlify), **Alex Nahas (creator of MCP-B)**, Justin Rushing
(OpenAI browser platform lead).

## What wins (organizer guidance)

- Devpost update "what judges actually look for": **"Show the project working in the first
  10 to 15 seconds. Skip intros and title screens." "Show the agent actually using your
  tools. That is the whole point of this hackathon."** Be specific: "An agent can complete a
  multi-step booking in one turn, instead of clicking through six screens." Pitfalls: dead
  URLs, private repos, unlisted videos, pre-existing projects without documentation,
  "feature-focused descriptions instead of use-case explanations."
- Sarah Drasner (via daily.dev, primary post UNVERIFIED): wants implementations that "feel
  genuinely game-changing rather than demo-ware"; likes hiding functionality/UI behind a tool
  call "so features only surface when an AI agent actually needs them."
- OpenAI's example ideas include "Build and refine 3D models with your agent, watching the
  scene take shape as you guide each change" and "Wrap an existing internal tool. You do not
  have to start from scratch." OpenAI's own demo: Codex Modeling Studio.
- Chrome's tool-design docs (the judges' own guidance): single-purpose tools; register per
  page state; precise verb names; positive descriptions; raw user input as strings; enums
  over IDs; strict validation in code; recoverable errors; role-play multi-step journeys; evals.

## Implementation constraints

- **Judging environments**: ChatGPT desktop app in-app browser (native WebMCP) or "Google
  Chrome 149 or later, enable chrome://flags/#enable-webmcp-testing, and restart." No
  specific agent client is mandated; the Model Context Tool Inspector extension, the DevTools
  Application › WebMCP panel, or ChatGPT's browser are all acceptable for the demo.
- **API entry point**: `document.modelContext` (with `navigator.modelContext` as a deprecated
  alias). `provideContext`/`clearContext`/`unregisterTool` are gone; unregister by aborting
  the `AbortSignal` passed to `registerTool(tool, { signal })`. Tool fields: `name`,
  `description`, `inputSchema`, `execute`, optional `annotations` (`readOnlyHint`,
  `untrustedContentHint`).
- **ChatGPT browser limits** (<https://learn.chatgpt.com/docs/webmcp>): declarative form tools
  unavailable; no tools inside iframes; every invocation gets a safety review and consequential
  actions require confirmation; needs GPT-5.6 Sol or Terra; not on Enterprise/Edu; enable via
  Settings › Browser › "Enable site tools". **Test against a deployed URL, not localhost.**
- **Polyfills / MCP-B**: not forbidden, but judges test in ChatGPT's browser or flagged Chrome,
  so a polyfill-only path that needs an extension is risky. Safe path: native API with feature
  detection; polyfill optional and off by default.

## Sources

<https://webmcp.devpost.com/> · <https://webmcp.devpost.com/rules> ·
<https://webmcp.devpost.com/updates/46161-2-days-left-and-what-judges-actually-look-for> ·
<https://webmcp.devpost.com/forum_topics/44963-can-a-pre-existing-proprietary-hosted-backend-remain-private> ·
<https://webmcp.devpost.com/forum_topics/45004-must-a-public-repo-include-the-full-production-dataset-for-an-existing-webmcp-app> ·
<https://webmcp.devpost.com/forum_topics/45006-enforced-code-snippet-requested> ·
<https://learn.chatgpt.com/docs/webmcp> · <https://www.netlify.com/blog/compete-openai-webmcp-challenge/> ·
<https://daily.dev/posts/openai-and-partners-launch-a-10-day-webmcp-hackathon-54bqootzg> ·
<https://developer.chrome.com/docs/ai/webmcp/best-practices> · <https://developer.chrome.com/docs/ai/webmcp/build-tools> ·
<https://developer.chrome.com/docs/ai/webmcp/evals> · <https://developer.chrome.com/docs/devtools/application/webmcp>

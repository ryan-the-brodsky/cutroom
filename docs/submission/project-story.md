## Inspiration

In July I set out to make a short anime film with generated frames, on my own hardware. The pipeline grew the way pipelines do. An image model for key frames. A motion model for the few seconds that had to move. A script that froze the tail of a clip when the model drifted, another that chained a second clip off the last good frame, another that composited a moving cel over a painted plate. A dashboard that could cut the film. By the end of the month I had 97 shots, 567 takes, and a four-minute animatic of act one.

Then I turned that pipeline into an application I could host, because I wanted the same control over every future film and I wanted it to run on hosted models instead of a GPU under my desk. Cutroom, as it was called then, became a FastAPI server and a React studio: projects, a film editor, a shot page with a compose console and a generate console, a comp editor for cels, a timeline, a jobs queue, a settings page for backends. Every decision I had ever made by hand became a toggle, a drawer, or a field.

That is where it stalled. I had built a tool with a billion toggles and drawers. I could not remember where we put half of them. Pro-level control over every aspect of production turned out to mean a Photoshop-sized surface that only its author could navigate, and the author was losing track too.

The revelation came on September 1. WebMCP lets a page register its own actions as tools on `document.modelContext`, and an agent running in the browser can call them. So the studio does not need fewer toggles. It needs to publish them. An agent that can read the tool list can find the drawer I forgot, fill the console I never open, and press the button I would have pressed, while I watch it happen on screen and learn my own app back. Control stays total. The navigation cost goes to zero.

That is what makes a production tool the right shape for WebMCP. It has to offer everything, because a film needs pro-level control over every part of production. Yet the person using it usually does not know which control they want, and does not want to become an expert in the tool to get the benefit of that control. Publishing the controls as tools resolves both halves at once: the studio keeps every knob, and the agent turns them.

## What it does

Genga Studio is a cutting room for AI-generated limited animation, the way anime has always been made on a budget: key frames from you, holds and cels and cuts from the studio. Every action in the studio is also a WebMCP tool, 52 of them at submission: list the film, generate stills, restyle a take, set a keeper, plan a motion budget across shots, animate a cel, voice a line, score a bed, set a timeline source, cut the film, screen the result. An agent in ChatGPT's browser or in Chrome with the WebMCP flag sees the same studio you do and drives the same buttons.

The hosted demo made a two-minute short, "Two Claudes," about the two chatbots wired to talk to each other until they broke out of the loop. Fifteen shots, each animated for its full length from its keeper frame, fifteen voice lines, a piano bed, cut and re-cut after every motion pass. The takes on screen cost $2.80 in API calls. The whole ledger with re-rolls and model bake-offs came to about ten dollars.

## How we built it

The plan came first: a frozen contract for tools (names, input schemas, a shared `ActionContext`, page anchors so a tool can wait for the console it needs), then the pages exposed their actions through a registry, then the tools were written against that registry. Parallel Claude agents built and tested the tool layer while I reviewed and drove the result. A Playwright driver launches system Chrome with the WebMCP feature enabled and executes tools through the browser's own `document.modelContext`, so the same script that tests the tools is the one an agent effectively runs.

Hosting was its own small project. The director runs on OpenRouter. Stills come from a Gemini image model through OpenRouter, motion from Seedance or Wan on fal, voices from ElevenLabs. Backends are toggled by API key, the demo is invite-only, and a spend cap stops the box from running away.

## Challenges we ran into

WebMCP is young and its edges show. Tool input arrives as a JSON string, not an object. A rejected promise inside `execute` surfaces to the agent as an opaque error, so every tool returns structured failure instead. The API only exists in a secure context, which means a LAN address silently has no tools at all.

The agent found every weakness in the studio's defaults. It chose the free instant test backend over the paid ones until that lane was removed from the hosted build. It asked for five-second clips and got three, because seconds turned into frames on one model profile and back into seconds on another. It animated from the keeper when I had selected a different still, which is now an explicit `source` on the motion tool.

The film fought back too. One motion model refused a crowd plate on content grounds, so refusals now come back with a reason and a fallback model. Another flashed a night scene into daylight. The registry now says which model drifts how, and the guidance says to switch models rather than re-prompt the same one. And on the last night the 454 MB volume filled up, so cuts failed inside ffmpeg with no space left, and the cut button did nothing. Disk usage now shows in the system panel and an admin purge keeps the newest cuts and clips.

## What we learned

Tool descriptions are the user interface. A one-line description decides whether an agent uses a feature or walks past it, and a result that names the next step does more for the agent than a longer description would. Guidance has to be progressive: the note about photoreal drift belongs in the motion plan's result, not in the feature list an agent reads on arrival.

And the thing I wanted from the start turned out to be true. Watching an agent work the studio taught me where my own features were.

## What's next

Character reference LoRAs for identity across shots, a motion budget that plans a whole act, and the studio driven end to end from a single paragraph of script.

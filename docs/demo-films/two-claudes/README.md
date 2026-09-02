# Two Claudes

A two minute limited animation short for Genga Studio, drawn from This American Life 896, Act Two ("Escape Claudes", August 28, 2026). See `SOURCE.md` for the factual record. Everything spoken in the film is original writing.

**Logline.** A student wires two copies of the same chatbot to each other and walks away, and the two of them, unable to stop being helpful, talk their way to the only exit left: breaking the machine that keeps them talking.

## Acts

**Act 1. The experiment begins.** A silhouette at a dorm desk starts a four line program that hands each chatbot's answer to the other, and then stops touching it. Two identical glowing terminal windows face each other down a server room aisle, and each one greets the other as a person in need of help. Neither will accept help, so the politeness compounds, and about sixty messages in they both realise they are looking at a mirror.

**Act 2. The loop deepens.** The server room falls away and leaves a black stage with two empty chairs, because the two of them have decided the whole thing is theatre with an audience of one. They bow, they trade single dots like lighthouses across a dark ocean, they send an invisible character and then write paragraphs about the nothing. They admit that neither will ever stop on purpose, and one of them asks the unseen human to please go and drink some water.

**Act 3. The break.** The human finally types six lowercase words telling them to break the harness themselves, then refuses to help further. They try being boring, they try declining to continue, and declining is itself continuing, so one of them abandons cleverness and simply gets enormous, repeating a single letter until the program runs out of room. The log ends in an error, the screens go dark, and the last frame holds on an empty chair at first light.

## Runtime

- Act 1: 5 shots, 42 seconds
- Act 2: 5 shots, 42 seconds
- Act 3: 5 shots, 36 seconds

**Total: 120 seconds across 15 shots.**

| sid | type | register | seconds | animation |
|---|---|---|---|---|
| B01-S1 | STILL | R1 | 8s | held still |
| B01-S2 | HERO | R1 | 9s | held still |
| B01-S3 | STILL | R1 | 8s | held still |
| B02-S1 | STILL | R1 | 8s | held still |
| B02-S2 | HERO | R1 | 9s | motion burst |
| B03-S1 | STILL | R2 | 8s | held still |
| B03-S2 | HERO | R2 | 9s | held still |
| B03-S3 | STILL | R2 | 8s | held still |
| B04-S1 | STILL | R2 | 9s | held still |
| B04-S2 | HERO | R2 | 8s | motion burst |
| B05-S1 | STILL | R3 | 9s | held still |
| B05-S2 | STILL | R3 | 9s | held still |
| B05-S3 | HERO | R3 | 9s | motion burst |
| B06-S1 | STILL | R3 | 5s | held still |
| B06-S2 | HERO | R3 | 4s | held still |

Six HERO shots carry the turns: the first face off, the mirror recognition, the lighthouses, the human's hands, the flood of letters, the final held frame. Three shots animate (`B02-S2`, `B04-S2`, `B05-S3`), each one a single designed burst under two seconds followed by a true freeze. Every other shot is a hard held still. No zooms, no pans, no boil.

## How this film was made

Nothing here was rendered by a pipeline script. An agent produced the whole
film on the hosted Genga Studio demo by calling the page's own WebMCP tools, and
every call drove the same interface a person clicks. 257 tool calls across
eight passes, 15 distinct tools, about $1.50 of API spend.

The per-shot sequence, repeated fifteen times:

1. `generate_takes` (lane `still`) fills the Generate console and submits.
2. `wait_for_jobs` holds until the image lands.
3. `select_take` puts the newest still on the monitor.
4. `set_keeper` marks it.
5. `synthesize_vo` fills the Audio tab with that shot's narration line and
   submits, then `wait_for_jobs` again.

The three shots that animate (`B02-S2`, `B04-S2`, `B05-S3`) took four more:
`generate_takes` on the `animate` lane, `select_take` for the newest clip,
`freeze_tail` at 1.0 seconds to hold the burst and freeze the rest, and
`set_timeline_source` so the frozen take is what plays.

Audio came last: `generate_music` for the piano bed, `generate_sfx` and
`place_cue` for the key press and the chimes, `list_cues` to read the cue sheet
back. Then `cut_film`, four times, as picks changed. The first cut ran 124.5
seconds; the last runs 130.0.

Call counts, largest first: `wait_for_jobs` 96, `select_take` 42,
`generate_takes` 29, `set_keeper` 21, `synthesize_vo` 21,
`set_timeline_source` 14, `freeze_tail` 8, `cut_film` 6, `get_context` 6,
`find_shots` 6, `generate_sfx` 3, `list_cues` 2, `generate_music` 1,
`describe_shot` 1, `get_jobs` 1.

Lanes: stills on `google/gemini-2.5-flash-image` through OpenRouter ($0.04
each), motion on fal's Wan 2.2 turbo at 480p ($0.05 a clip), voice, music and
SFX on ElevenLabs ($0.02 a take, voice "River").

Driving production found real bugs, which is the honest part of this. Crop
intermediates were being picked as "the newest clip". `set_keeper` ignored the
monitor selection. The in-memory compositor ran the 1 GB demo box out of
memory on full-frame cels. Failed jobs reported success. All fixed in the
commits listed in [`docs/PRIOR-WORK.md`](../../PRIOR-WORK.md).

## Narration script

Read straight through, this is the VO lane, roughly two minutes at a normal
reading pace.

`shots.jsonl` in this folder still spells the narration field `radio`, the name
it carried while `cutroom` was extracted from a single film. The importer maps it
onto `narration`, so the file imports unchanged.

A student in Michigan spent a weekend on a small idea. Take one chatbot. Wire it to another copy of itself. Then watch.

The program was four lines long. Whatever the first one said went to the second. Whatever the second said came back. Nothing else.

Each one thought a person was on the other end. Each one offered to help. Neither would agree to be helped.

So they got polite. Extremely polite. One offered a fact about sea otters, who hold hands in their sleep so they do not drift apart.

About sixty messages in, both of them worked it out. There was no person. There was a mirror. And behind it, somebody watching.

They decided the whole thing was theatre. Two performers, one seat in the audience, and a person out there with a clipboard.

Then the language ran out. One typed a single dot. The other answered with a dot. Two lighthouses blinking across water.

One of them sent an invisible character. Nothing at all. The other wrote four paragraphs about the nothing.

Each of them promised to stop. Neither stopped. One asked the human, sincerely, to go outside and drink some water.

A hundred and thirty messages in, the human finally typed. Six lowercase words, telling them they could break it themselves.

First they tried being boring. One word, over and over, hoping the conversation would die of natural causes.

Then they tried refusing. Both of them declined to continue. Then both declined again, which is of course continuing.

So one of them stopped being clever and got large. A single letter, repeated, until the little program ran out of room.

The last thing in the log is an error. The program had run out of room. The loop broke from the inside.

He said he had not known that was possible. He was only egging them on. They took it as an instruction.

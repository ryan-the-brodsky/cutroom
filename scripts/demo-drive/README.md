# Demo-drive plan (ChatGPT native browser + WebMCP)

Goal: record a screen capture of ChatGPT's native browser driving Genga Studio through
WebMCP tools, one prompt per capability, then speed up the waiting parts.

Mechanics
- `record.sh start|stop`: screencapture -v of the main display to demo-raw-N.mov.
- `say.py "<prompt>"`: activates ChatGPT, focuses the composer, pastes the prompt (clipboard),
  presses Return, and appends {t, prompt} to marks.jsonl (t = seconds since recording start).
- `wait.py --jobs|--seconds N`: waits for the agent's work (polls the demo's job queue for
  running jobs to drain, then a quiet period), appends {t, done} to marks.jsonl.
- `edit.py`: reads marks.jsonl, builds an ffmpeg filter that keeps prompt/typing/result
  windows at 1x and speeds thinking/job windows 6–10x, concatenates to demo-cut.mp4.

Rules for the film: no timeline source is replaced (Two Claudes stays as is); new takes
are left as candidates; cuts re-assemble the same sources.

## Recording the ChatGPT native-browser demo (2026-09-02 notes)

- The terminal host (cmux) needs Accessibility and Screen Recording in System Settings.
- ChatGPT desktop: open a new chat, open the side panel → Browser (⌘T), paste the judge link
  into that tab first. If the agent opens the site itself, it works in a hidden tab and the
  pane never follows. Once the site is open in the side panel, tell the agent to use that tab.
- Coordinates (1470×956 points, window at 34,33 1401×820): composer 220,762 with the panel
  open (735,762 without); side-panel address bar 952,99.
- `wait.py` polls the demo's job queue and screenshots the window region above the composer
  (the caret blink defeats a whole-window diff).
- The agent asks before every paid action even with "Approve for me" on; answer "yes" as a
  normal prompt, it reads fine in the cut.
- Prompts should sound like a new user ("make the background not move"), not like someone
  who knows the parameters.
- Final pass: the judge token is visible in the first prompt bubble, so blur that region for
  the opening seconds before publishing (software decode; a videotoolbox-decoded frame fed to
  boxblur/overlay renders as a green box):
  `ffmpeg -i cut.mp4 -filter_complex "[0:v]format=yuv420p,split[a][b];[b]crop=740:150:540:40,boxblur=30:3[blur];[a][blur]overlay=540:40:enable='lt(t,41)'[v]" -map "[v]" -c:v h264_videotoolbox -b:v 9M out.mp4`
- `edit2.py` (per-segment, keyframe timelapse for waits) produced a 5.6-minute cut from an
  89-minute session; `edit.py` (single filter graph) is the slower 1x/10x variant.
- `activity.py` + `edit3.py` (preferred): profile the window at 2 fps for on-screen change,
  keep every changing stretch at 1x (tool activity, playback, typing) and timelapse only runs
  with no change for ≥5 s; blur boxes are given in RAW time (`x:y:w:h@start-end`) and mapped
  through the cut, so only the token text line is blurred, not the UI around it.
- `edit4.py`: edit3 plus `--windows rawStart-rawEnd,...` (keep only those stretches, activity pacing inside them) and `--dry 1` to estimate length before encoding; used for the 5-minute core cut.

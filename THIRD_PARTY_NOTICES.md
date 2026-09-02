# Third-party notices

Genga Studio is distributed under the MIT License (see [`LICENSE`](LICENSE)). It
incorporates, or builds on, the third-party work listed below. Each item keeps
its own copyright and license; nothing here is claimed as original to Genga Studio.

---

## 1. FreeCut — player runtime (vendored source)

**What**: the frame-accurate playback runtime under
[`web/src/runtime/player/`](web/src/runtime/player) (27 files: `Player.tsx`,
`use-player.ts`, the `clock/`, `composition/`, `video/` and `contracts/`
subtrees). This is a surgical lift of FreeCut's player — its clock, its
sequence/composition primitives, its video-source pool and its player event
emitter — adapted to Genga Studio's own timeline model, stores and persistence
layer. The design rationale for the lift is recorded in
[`docs/FOUNDATION.md`](docs/FOUNDATION.md) §§8–11.

**Upstream**: <https://github.com/walterlow/freecut> (author: `walterlow`),
audited and lifted at commit `a3ecfce` (2026-07-14).

**License**: MIT.

```
MIT License

Copyright (c) 2025 FreeCut

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

FreeCut's own header comment notes that its `Player` component is *"inspired
by Composition Player"* — a design lineage, not vendored code; no Remotion (or
other Composition Player) source is present in this repository.

### What was deliberately NOT lifted

FreeCut vendors **SoundTouch JS** (`src/infrastructure/audio/time-stretch.ts`)
which is **LGPL-2.1**, not MIT. That file and its two importers were excluded
from the lift; Genga Studio contains no SoundTouch code and no LGPL-licensed source.
Audio time-stretching, if it is ever added, will use an MIT implementation.
See `docs/FOUNDATION.md` §8 for the audit that found this.

---

## 2. FreeCut — render engine (external co-process, not vendored)

[`server/cutroom/engine_render.py`](server/cutroom/engine_render.py) can drive a
**separately installed** FreeCut clone (Node + Playwright + its built bundle) as
a co-process for WebCodecs rendering, located via the `CUTROOM_ENGINE_DIR`
environment variable. No FreeCut engine code ships in this repository; the
integration is a subprocess boundary plus a JSON input format. Same upstream and
license as §1. The feature is optional and off unless `CUTROOM_ENGINE_DIR` is set.

---

## 3. Runtime dependencies

Genga Studio's Python and JavaScript dependencies are declared in
[`server/pyproject.toml`](server/pyproject.toml) and
[`web/package.json`](web/package.json) and are installed from PyPI and npm
rather than vendored. They carry their own licenses (predominantly MIT, BSD and
Apache-2.0): FastAPI, Uvicorn, SQLAlchemy, Pydantic, httpx, Pillow, NumPy, SciPy,
`python-multipart`; React, React DOM, React Router, Vite and TypeScript.

**ffmpeg** is invoked as an external binary (never linked, never redistributed
here); the Docker image installs it from Debian. Depending on how it was built,
ffmpeg may be LGPL-2.1+ or GPL-2.0+ — that is a property of the operator's
image, not of Genga Studio, and Genga Studio's use is `subprocess` only.

---

## 4. Original work

Everything else — the server, adapters, job queue, cel/comp model, director
grammar, panel engine, importer, timeline model, the SPA, and the WebMCP agent
layer under `web/src/agent/` — is original to this project and MIT-licensed
under `LICENSE`. The panel engine was ported from the author's own
`anime-panel-shot` tooling; the director grammar from the author's own
`director-cut` command table.

Film assets (footage, audio, script, storyboards) are **not** part of this
repository and are not covered by the MIT license. They remain
Copyright (c) 2026 Ryan Brodsky, all rights reserved, and are served only by the
hosted demo instance for evaluation.

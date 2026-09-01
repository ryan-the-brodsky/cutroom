"""The Cutroom timeline model — rational (frame) time, clips with source
in/out and media handles. The foundation the FOUNDATION.md decision hangs on:
a shot is a unit of production; a clip is a unit of time.

`model` — the data model (Timeline/Track/Clip) + validation + JSON.
`compile` — film (shots/takes/overrides) → Timeline, and → FreeCut engine input.
"""
from .model import Clip, Marker, Timeline, Track, frames_to_seconds, seconds_to_frames  # noqa: F401

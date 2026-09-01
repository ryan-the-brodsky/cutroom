"""cutroom.engine — the composition library.

Pure Python (PIL + numpy + scipy) with ffmpeg subprocesses. No server imports,
no absolute paths, no globals bound to a machine: every function takes explicit
paths and parameters, so the same code runs in-process, in a remote worker, or
from a script.

Doctrine baked in as defaults (director rulings):
- Holds are TRUE freezes. No zoompan, no Ken Burns, no ambient wobble.
- Cel composites never touch plate pixels outside the animated region.
- Interior seams feather; plate-edge-coincident seams stay hard (entrances).
"""
from . import audio, cels, ffmpeg, images, motion, panels  # noqa: F401

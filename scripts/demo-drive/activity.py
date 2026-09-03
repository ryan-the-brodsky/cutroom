#!/usr/bin/env python3
"""activity.py <raw.mov> <out.json>
Samples the ChatGPT window at 2 fps (tiny grayscale frames) and writes a per-sample
activity score: mean absolute difference from the previous sample. Used by edit3.py to
keep every stretch where the screen is doing something at 1x and timelapse only the
stretches where nothing moves (the model thinking, a job rendering)."""
import json, subprocess, sys, numpy as np
raw, out = sys.argv[1], sys.argv[2]
W, H, FPS = 192, 112, 2
cmd = ["ffmpeg", "-v", "error", "-hwaccel", "videotoolbox", "-i", raw,
       "-vf", f"crop=2802:1640:68:66,fps={FPS},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=W * H * 64)
prev = None; scores = []
while True:
    buf = p.stdout.read(W * H)
    if len(buf) < W * H: break
    f = np.frombuffer(buf, dtype=np.uint8).astype(np.int16)
    scores.append(0.0 if prev is None else float(np.abs(f - prev).mean()))
    prev = f
p.wait()
json.dump({"fps": FPS, "scores": scores}, open(out, "w"))
a = np.array(scores)
print(f"{len(scores)} samples ({len(scores)/FPS:.0f}s); active(>0.6): {(a>0.6).mean()*100:.1f}%  >1.5: {(a>1.5).mean()*100:.1f}%  median {np.median(a):.3f}")

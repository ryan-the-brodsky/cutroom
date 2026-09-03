#!/usr/bin/env python3
"""edit.py <raw.mov> <out.mp4> [--fast 8] [--lead 6] [--tail 5]
Speeds up the waiting stretches. For each prompt mark, the `lead` seconds after the prompt
play at 1x (you see the prompt land and the tools start), the stretch until the matching
done mark plays at `fast`x, and the `tail` seconds after done play at 1x (the result)."""
import json, subprocess, sys, pathlib
D = pathlib.Path(__file__).parent
raw, out = sys.argv[1], sys.argv[2]; a = sys.argv[3:]
def opt(n, d):
    if n in a:
        i = a.index(n); v = float(a[i + 1]); del a[i:i + 2]; return v
    return d
fast, lead, tail = opt("--fast", 8), opt("--lead", 6), opt("--tail", 5)
marks = [json.loads(l) for l in (D / "marks.jsonl").read_text().splitlines() if l.strip()]
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", raw], capture_output=True, text=True).stdout.strip())
# build (start, end, speed) segments
segs = []; cur = 0.0
prompts = [m for m in marks if m["kind"] == "prompt"]; dones = [m for m in marks if m["kind"] == "done"]
for p in prompts:
    d = next((x for x in dones if x["t"] > p["t"]), None)
    end_fast = (d["t"] if d else p["t"] + 60)
    a1, b1 = p["t"], min(p["t"] + lead, end_fast)
    if a1 > cur: segs.append((cur, a1, 1.0))
    segs.append((a1, b1, 1.0))
    if end_fast > b1: segs.append((b1, end_fast, fast))
    cur = end_fast
    if d:
        segs.append((cur, min(cur + tail, dur), 1.0)); cur = min(cur + tail, dur)
if cur < dur: segs.append((cur, dur, 1.0))
segs = [(s, e, sp) for s, e, sp in segs if e - s > 0.2]
parts = []; fc = []
# crop to the ChatGPT window (points 34,33 1401x820 on a 2x display) and scale to 1080p-ish
crop = opt("--nocrop", 0) == 0
pre = "crop=2802:1640:68:66,scale=1920:-2," if crop else ""
for i, (s, e, sp) in enumerate(segs):
    fc.append(f"[0:v]trim=start={s:.2f}:end={e:.2f},setpts=(PTS-STARTPTS)/{sp},{pre}format=yuv420p[v{i}]")
    parts.append(f"[v{i}]")
fc.append("".join(parts) + f"concat=n={len(segs)}:v=1:a=0[v]")
cmd = ["ffmpeg", "-v", "error", "-y", "-hwaccel", "videotoolbox", "-i", raw, "-filter_complex", ";".join(fc), "-map", "[v]", "-r", "30",
       "-c:v", "h264_videotoolbox", "-b:v", "9M", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]
subprocess.run(cmd, check=True)
total = sum((e - s) / sp for s, e, sp in segs)
print(f"{len(segs)} segments; raw {dur:.0f}s -> cut ~{total:.0f}s -> {out}")

#!/usr/bin/env python3
"""edit2.py <raw.mov> <out.mp4> [--lead 8] [--tail 8] [--gap 1.5] [--marks marks.jsonl]
Per-segment extraction (input seeking), so only the frames used are decoded:
  prompt landing: `lead` s at 1x · waiting: keyframes only, laid at 30 fps (a timelapse
  whose length scales with the wait) or 4x full-decode when the wait is short ·
  result: `tail` s at 1x · dead air between turns is dropped except `gap` s before the
  next prompt. Segments are encoded in parallel then concatenated without re-encoding."""
import json, subprocess, sys, pathlib, concurrent.futures, tempfile, os
raw, out = sys.argv[1], sys.argv[2]; a = sys.argv[3:]
def opt(n, d, cast=float):
    if n in a:
        i = a.index(n); v = cast(a[i + 1]); del a[i:i + 2]; return v
    return d
lead, tail, gap = opt("--lead", 8), opt("--tail", 8), opt("--gap", 1.5)
marks_path = opt("--marks", str(pathlib.Path(__file__).parent / "marks.jsonl"), str)
marks = [json.loads(l) for l in open(marks_path) if l.strip()]
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", raw], capture_output=True, text=True).stdout.strip())
prompts = [m for m in marks if m["kind"] == "prompt"]; dones = [m for m in marks if m["kind"] == "done"]
segs = []  # (start, end, mode)
prev_end = 0.0
for p in prompts:
    d = next((x for x in dones if x["t"] > p["t"]), None)
    done_t = d["t"] if d else min(p["t"] + 90, dur)
    g0 = max(prev_end, p["t"] - gap)
    if p["t"] > g0: segs.append((g0, p["t"], "normal"))
    l1 = min(p["t"] + lead, done_t); segs.append((p["t"], l1, "normal"))
    if done_t > l1:
        segs.append((l1, done_t, "fast-full" if done_t - l1 < 40 else "fast-key"))
    t1 = min(done_t + tail, dur); segs.append((done_t, t1, "normal")); prev_end = t1
segs = [s for s in segs if s[1] - s[0] > 0.15]
tmp = pathlib.Path(tempfile.mkdtemp(prefix="genga-edit-"))
VF = "crop=2802:1640:68:66,scale=1920:-2"
def enc(i, s, e, mode):
    f = tmp / f"seg{i:03d}.mp4"
    base = ["ffmpeg", "-v", "error", "-y"]
    if mode == "fast-key":
        cmd = base + ["-skip_frame", "nokey", "-ss", f"{s:.3f}", "-t", f"{e - s:.3f}", "-i", raw,
                      "-vf", f"{VF},setpts=N/(30*TB)", "-r", "30", "-an"]
    elif mode == "fast-full":
        cmd = base + ["-hwaccel", "videotoolbox", "-ss", f"{s:.3f}", "-t", f"{e - s:.3f}", "-i", raw,
                      "-vf", f"{VF},setpts=PTS/4", "-r", "30", "-an"]
    else:
        cmd = base + ["-hwaccel", "videotoolbox", "-ss", f"{s:.3f}", "-t", f"{e - s:.3f}", "-i", raw,
                      "-vf", VF, "-r", "30", "-an"]
    cmd += ["-c:v", "h264_videotoolbox", "-b:v", "9M", "-pix_fmt", "yuv420p", "-video_track_timescale", "30000", str(f)]
    subprocess.run(cmd, check=True)
    d = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)], capture_output=True, text=True).stdout.strip() or 0)
    return i, f, d
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
    results = sorted(ex.map(lambda t: enc(*t), [(i, s, e, m) for i, (s, e, m) in enumerate(segs)]))
lst = tmp / "concat.txt"; lst.write_text("".join(f"file '{f}'\n" for _, f, _ in results))
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", "-movflags", "+faststart", out], check=True)
total = sum(d for _, _, d in results)
print(f"{len(segs)} segments ({sum(1 for s in segs if s[2]=='fast-key')} timelapse); raw {dur:.0f}s -> cut {total:.0f}s -> {out}")
for (s, e, m), (_, _, d) in zip(segs, results):
    print(f"  {s:7.1f}-{e:7.1f} {m:9s} -> {d:5.1f}s")

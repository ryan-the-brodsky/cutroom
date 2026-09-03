#!/usr/bin/env python3
"""edit3.py <raw.mov> <activity.json> <out.mp4> [--thresh 0.6] [--still 6] [--pad 1.5]
   [--blur-until-raw 200] [--blur x:y:w:h]
Activity-driven cut: every stretch where the screen changes (tool activity in the browser
pane, playback, typing) plays at 1x; stretches with no change for at least `still` seconds
become keyframe timelapses, with `pad` seconds of 1x on both sides. A thin blur strip is
laid over the token text for output time that maps to raw time < blur-until-raw."""
import json, subprocess, sys, pathlib, concurrent.futures, tempfile
raw, act_path, out = sys.argv[1], sys.argv[2], sys.argv[3]; a = sys.argv[4:]
def opt(n, d, cast=float):
    if n in a:
        i = a.index(n); v = cast(a[i + 1]); del a[i:i + 2]; return v
    return d
thresh, still_min, pad = opt("--thresh", 0.6), opt("--still", 6), opt("--pad", 1.5)
blurs = opt("--blurs", "", str)  # x:y:w:h@rawStart-rawEnd, comma-separated (empty = no blur)
windows = opt("--windows", "", str)  # rawStart-rawEnd,... keep only these stretches
dry = opt("--dry", 0)
act = json.load(open(act_path)); fps = act["fps"]; sc = act["scores"]
dur = len(sc) / fps
# active mask per sample, then runs of inactivity >= still_min seconds
active = [s > thresh for s in sc]
runs = []; i = 0
while i < len(active):
    if not active[i]:
        j = i
        while j < len(active) and not active[j]: j += 1
        if (j - i) / fps >= still_min: runs.append((i / fps, j / fps))
        i = j
    else: i += 1
segs = []; cur = 0.0
for s, e in runs:
    s2, e2 = s + pad, e - pad
    if e2 - s2 < 2: continue
    if s2 > cur: segs.append((cur, s2, "normal"))
    segs.append((s2, e2, "fast"))
    cur = e2
if cur < dur: segs.append((cur, dur, "normal"))
if windows:
    wins = [tuple(float(x) for x in w.split("-")) for w in windows.split(",")]
    clipped = []
    for ws, we in wins:
        for s, e, m in segs:
            a_, b_ = max(s, ws), min(e, we)
            if b_ - a_ > 0.15: clipped.append((a_, b_, m))
    segs = clipped
if dry:
    est = sum((e - s) if m == "normal" else max(1.0, (e - s) * 0.45 / 30) for s, e, m in segs)
    n1 = sum(e - s for s, e, m in segs if m == "normal")
    print(f"dry: {len(segs)} segments, 1x time {n1:.0f}s, estimated cut {est:.0f}s ({est/60:.1f} min)")
    for s, e, m in segs: print(f"  {s:7.1f}-{e:7.1f} {m}")
    sys.exit(0)
tmp = pathlib.Path(tempfile.mkdtemp(prefix="genga-edit3-"))
VF = "crop=2802:1640:68:66,scale=1920:-2"
def enc(i, s, e, mode):
    f = tmp / f"seg{i:03d}.mp4"
    if mode == "fast":
        cmd = ["ffmpeg", "-v", "error", "-y", "-skip_frame", "nokey", "-ss", f"{s:.3f}", "-t", f"{e - s:.3f}", "-i", raw,
               "-vf", f"{VF},setpts=N/(30*TB)", "-r", "30", "-an"]
    else:
        cmd = ["ffmpeg", "-v", "error", "-y", "-hwaccel", "videotoolbox", "-ss", f"{s:.3f}", "-t", f"{e - s:.3f}", "-i", raw,
               "-vf", VF, "-r", "30", "-an"]
    cmd += ["-c:v", "h264_videotoolbox", "-b:v", "9M", "-pix_fmt", "yuv420p", "-video_track_timescale", "30000", str(f)]
    subprocess.run(cmd, check=True)
    d = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)], capture_output=True, text=True).stdout.strip() or 0)
    return i, f, d
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
    results = sorted(ex.map(lambda t: enc(*t), [(i, s, e, m) for i, (s, e, m) in enumerate(segs)]))
# map raw time -> output time through the segment table (fast segments compress linearly)
table = []; t_out = 0.0
for (s, e, m), (_, _, d) in zip(segs, results):
    table.append((s, e, t_out, d)); t_out += d
def to_out(t):
    for s, e, o, d in table:
        if s <= t < e: return o + (t - s) / (e - s) * d
    return t_out if t >= dur else 0.0
boxes = []
for spec in [x for x in blurs.split(",") if x]:
    box, rng = spec.split("@"); r0, r1 = (float(x) for x in rng.split("-"))
    boxes.append((box.split(":"), to_out(r0), to_out(r1)))
lst = tmp / "concat.txt"; lst.write_text("".join(f"file '{f}'\n" for _, f, _ in results))
joined = tmp / "joined.mp4"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined)], check=True)
if not boxes:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(joined), "-c", "copy", "-movflags", "+faststart", out], check=True)
chain = "[0:v]format=yuv420p[v0]"; last = "v0"
for k, ((bx, by, bw, bh), o0, o1) in enumerate(boxes):
    chain += (f";[{last}]split[a{k}][b{k}];[b{k}]crop={bw}:{bh}:{bx}:{by},boxblur=luma_radius=10:luma_power=3:chroma_radius=5:chroma_power=2[bl{k}];"
              f"[a{k}][bl{k}]overlay={bx}:{by}:enable='between(t,{o0:.2f},{o1:.2f})'[v{k+1}]")
    last = f"v{k+1}"
fc = chain + f";[{last}]format=yuv420p[v]"
if boxes: subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(joined), "-filter_complex", fc, "-map", "[v]", "-r", "30",
                "-c:v", "h264_videotoolbox", "-b:v", "9M", "-movflags", "+faststart", out], check=True)
total = sum(d for _, _, d in results)
print(f"{len(segs)} segments ({sum(1 for s in segs if s[2]=='fast')} timelapse); raw {dur:.0f}s -> cut {total:.0f}s; blur windows {[(round(o0,1), round(o1,1)) for _, o0, o1 in boxes]} -> {out}")
json.dump({"segments": [(s, e, m, d) for (s, e, m), (_, _, d) in zip(segs, results)], "blurs": [(b, o0, o1) for b, o0, o1 in boxes]}, open(out + ".segments.json", "w"), indent=1)

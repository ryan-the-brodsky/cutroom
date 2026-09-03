#!/usr/bin/env python3
"""wait.py [--min S] [--max S] [--quiet S] [--label TEXT]
Waits for the agent's turn to finish: first `min` seconds, then until the demo's job queue
has no queued/running jobs and the screen has been visually still for `quiet` seconds
(screenshot diff on the ChatGPT window region), capped at `max`. Writes a mark."""
import json, os, subprocess, sys, time, pathlib, urllib.request
D = pathlib.Path(__file__).parent
a = sys.argv[1:]
def opt(name, default, cast=float):
    if name in a:
        i = a.index(name); v = a[i + 1]; del a[i:i + 2]; return cast(v)
    return default
mn, mx, quiet, label = opt("--min", 8), opt("--max", 240), opt("--quiet", 12), opt("--label", "", str)
t0 = json.loads((D / "t0.json").read_text())["t0"]
BASE = os.environ["CUTROOM_DEMO_URL"].rstrip("/"); TOK = os.environ["CUTROOM_DEMO_ADMIN_TOKEN"]
def busy_jobs():
    try:
        req = urllib.request.Request(BASE + "/api/jobs?limit=12", headers={"Authorization": "Bearer " + TOK})
        j = json.loads(urllib.request.urlopen(req, timeout=15).read())
        j = j if isinstance(j, list) else j.get("jobs", [])
        return sum(1 for x in j if x.get("status") in ("queued", "running"))
    except Exception:
        return 0
def snap():
    subprocess.run(["screencapture", "-x", "-R", "34,60,1401,640", "-t", "jpg", "/tmp/dd-snap.jpg"], check=True)
    return subprocess.run(["md5", "-q", "/tmp/dd-snap.jpg"], capture_output=True, text=True).stdout.strip()
start = time.time(); time.sleep(mn)
last = snap(); still_since = time.time()
while time.time() - start < mx:
    time.sleep(3)
    h = snap()
    if h != last: last = h; still_since = time.time()
    if busy_jobs() == 0 and time.time() - still_since >= quiet:
        break
mark = {"t": round(time.time() - t0, 2), "kind": "done", "label": label, "waited": round(time.time() - start, 1)}
with open(D / "marks.jsonl", "a") as f: f.write(json.dumps(mark) + "\n")
print("done @%.1fs after %.0fs%s" % (mark["t"], mark["waited"], " (cap)" if time.time() - start >= mx else ""))

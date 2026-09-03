#!/usr/bin/env python3
"""say.py "<prompt>" [--click X,Y] [--no-enter]
Types a prompt into the ChatGPT desktop app's composer and presses Return.
Uses the clipboard + Cmd-V so long prompts land verbatim; records a mark."""
import json, os, subprocess, sys, time, pathlib
D = pathlib.Path(__file__).parent
args = sys.argv[1:]
click = None; enter = True
if "--click" in args:
    i = args.index("--click"); click = args[i + 1]; del args[i:i + 2]
if "--no-enter" in args:
    args.remove("--no-enter"); enter = False
prompt = args[0]
t0 = json.loads((D / "t0.json").read_text())["t0"] if (D / "t0.json").exists() else time.time()

def osa(script):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True)

subprocess.run(["pbcopy"], input=prompt.encode(), check=True)
osa('tell application "ChatGPT" to activate')
time.sleep(0.6)
if click:
    subprocess.run(["cliclick", f"c:{click}"], check=True); time.sleep(0.3)
r = osa('tell application "System Events" to keystroke "v" using command down')
if r.returncode: print("keystroke failed:", r.stderr.strip()); sys.exit(1)
time.sleep(0.4 + min(2.0, len(prompt) / 400))
if enter:
    osa('tell application "System Events" to key code 36')
mark = {"t": round(time.time() - t0, 2), "kind": "prompt", "text": prompt[:120]}
with open(D / "marks.jsonl", "a") as f: f.write(json.dumps(mark) + "\n")
print("sent @%.1fs: %s" % (mark["t"], prompt[:80]))

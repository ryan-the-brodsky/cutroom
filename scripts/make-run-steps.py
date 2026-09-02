#!/usr/bin/env python3
"""Turn a shots.jsonl into an agent-drive steps.json for a full production run:
stills → keeper → (HERO w/ motion_prompt) animate → freeze tail → timeline source → VO → cut.
  python3 scripts/make-run-steps.py docs/demo-films/two-claudes/shots.jsonl > /tmp/run.json
Options: --stills N (per shot, default 1) --no-motion --no-vo --no-cut --only B01-S1,B01-S2
"""
import json, sys, argparse
ap = argparse.ArgumentParser(); ap.add_argument("shots"); ap.add_argument("--stills", type=int, default=1)
ap.add_argument("--no-motion", action="store_true"); ap.add_argument("--no-vo", action="store_true")
ap.add_argument("--no-cut", action="store_true"); ap.add_argument("--only", default="")
ap.add_argument("--skip-stills", action="store_true", help="shots already have keepers")
ap.add_argument("--motion-waits", type=int, default=3)
a = ap.parse_args()
rows = [json.loads(l) for l in open(a.shots) if l.strip()]
only = set(x for x in a.only.split(",") if x)
steps = [{"tool": "get_context", "args": {}, "note": "where are we"},
         {"tool": "find_shots", "args": {"query": "the first shot"}, "note": "resolver sanity", "allowFail": True}]
for r in rows:
    sid = r["id"]
    if only and sid not in only: continue
    if not a.skip_stills:
        steps += [
            {"tool": "generate_takes", "args": {"shot": sid, "lane": "still", "count": a.stills, "confirm_cost": True}, "note": f"{sid} still ×{a.stills}"},
            {"tool": "wait_for_jobs", "args": {"jobs": "$prev.jobs", "timeout_s": 60}, "note": f"{sid} wait still", "allowFail": True},
            {"tool": "select_take", "args": {"shot": sid, "take": "newest still"}, "note": f"{sid} select newest still"},
            {"tool": "set_keeper", "args": {"shot": sid}, "note": f"{sid} keeper = selected"},
        ]
    if not a.no_motion and r.get("motion_prompt"):
        steps += [
            {"tool": "generate_takes", "args": {"shot": sid, "lane": "animate", "count": 1, "prompt": r["motion_prompt"], "confirm_cost": True}, "note": f"{sid} animate (cel burst)"},
        ] + [
            {"tool": "wait_for_jobs", "args": {"jobs": "$prev.jobs", "timeout_s": 60}, "note": f"{sid} wait motion ({k+1})", "allowFail": True}
            for k in range(a.motion_waits)
        ] + [
            {"tool": "select_take", "args": {"shot": sid, "take": "newest motion"}, "note": f"{sid} select newest motion", "allowFail": True},
            {"tool": "freeze_tail", "args": {"shot": sid, "live_seconds": 1.5}, "note": f"{sid} FIRST-SECOND LAW freeze", "allowFail": True},
            {"tool": "wait_for_jobs", "args": {"jobs": "$prev.jobs", "timeout_s": 60}, "note": f"{sid} wait freeze", "allowFail": True},
            {"tool": "select_take", "args": {"shot": sid, "take": "newest motion"}, "note": f"{sid} select frozen clip", "allowFail": True},
            {"tool": "set_timeline_source", "args": {"shot": sid}, "note": f"{sid} plays the frozen clip", "allowFail": True},
        ]
    if not a.no_vo and r.get("radio"):
        steps += [
            {"tool": "synthesize_vo", "args": {"shot": sid, "text": r["radio"], "confirm_cost": True}, "note": f"{sid} VO"},
            {"tool": "wait_for_jobs", "args": {"jobs": "$prev.jobs", "timeout_s": 60}, "note": f"{sid} wait VO", "allowFail": True},
        ]
if not a.no_cut:
    steps += [{"tool": "cut_film", "args": {"scope": "full", "res": "720"}, "note": "CUT THE FILM"},
              {"tool": "wait_for_jobs", "args": {"jobs": "$prev.jobs", "timeout_s": 60}, "note": "wait cut", "allowFail": True},
              {"tool": "wait_for_jobs", "args": {"jobs": "$prev.jobs", "timeout_s": 60}, "note": "wait cut (2)", "allowFail": True},
              {"tool": "wait_for_jobs", "args": {"jobs": "$prev.jobs", "timeout_s": 60}, "note": "wait cut (3)", "allowFail": True}]
json.dump(steps, sys.stdout, indent=1); print(f"\n// {len(steps)} steps", file=sys.stderr)

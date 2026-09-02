#!/usr/bin/env python3
"""Seed a Cutroom project from a studio-folder script (no media) over the API.

  python3 scripts/seed-film.py --url https://host --token ADMIN --project two-claudes \
      --shots docs/demo-films/two-claudes/shots.jsonl \
      --cast docs/demo-films/two-claudes/characters.jsonl \
      --lane still=openrouter-image:google/gemini-2.5-flash-image \
      --lane motion=fal:fal-ai/wan/v2.2-a14b/image-to-video/turbo --lane vo=elevenlabs \
      --lane direction=openrouter:z-ai/glm-5.3-flash

Creates the project (admin), upserts every shot in file order (order_idx), sets the cast,
and pins lane defaults so a fresh project never falls back to "first enabled backend".
Idempotent: re-running updates in place.
"""
import argparse, json, sys, urllib.request, urllib.error

ap = argparse.ArgumentParser()
ap.add_argument("--url", required=True); ap.add_argument("--token", required=True)
ap.add_argument("--project", required=True); ap.add_argument("--shots", required=True)
ap.add_argument("--cast"); ap.add_argument("--lane", action="append", default=[])
a = ap.parse_args()
base = a.url.rstrip("/")

def call(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Authorization": f"Bearer {a.token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

st, sysinfo = call("/api/system"); print("system:", st, {k: sysinfo.get(k) for k in ("demo", "role", "budget", "projects")})
st, r = call("/api/projects", {"id": a.project}); print("create project:", st, r if st != 200 else r.get("id", "ok"))
if st not in (200, 409) and "exists" not in json.dumps(r).lower():
    sys.exit(f"project create failed: {st} {r}")

shots = [json.loads(l) for l in open(a.shots) if l.strip()]
n = 0
for i, s in enumerate(shots):
    body = {"sid": s["id"], "order_idx": i}
    for f in ("beat", "act", "type", "seconds", "register", "image_prompt", "negative",
              "motion_prompt", "pan", "narration", "dialogue", "sfx", "ambient", "cut",
              "render_notes"):
        if f in s: body[f] = s[f]
    # a shots.jsonl written before the rename says `radio`; the API takes either
    if "narration" not in body and "radio" in s: body["radio"] = s["radio"]
    st, r = call(f"/api/projects/{a.project}/shots", body)
    if st != 200: sys.exit(f"shot {s['id']} failed: {st} {r}")
    n += 1
print(f"shots upserted: {n} (total seconds {sum(float(s.get('seconds') or 0) for s in shots):.0f})")

if a.cast:
    rows = [json.loads(l) for l in open(a.cast) if l.strip()]
    st, r = call(f"/api/projects/{a.project}/cast", {"characters": rows})
    print("cast:", st, [e.get("name") for e in r.get("cast", [])] if st == 200 else r)

for spec in a.lane:
    lane, _, rest = spec.partition("=")
    backend, _, model = rest.partition(":")
    st, r = call(f"/api/projects/{a.project}/lanes", {"lane": lane, "backend": backend, "model": model or None})
    print(f"lane {lane} -> {backend}:{model or '-'}:", st, "" if st == 200 else r)

st, film = call(f"/api/projects/{a.project}/film")
print("film:", st, "shots", len(film) if isinstance(film, list) else len(film.get("shots", [])))

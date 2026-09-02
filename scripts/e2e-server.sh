#!/usr/bin/env bash
# Scratch Cutroom server for the Playwright e2e suite (workstream E).
#
#   CUTROOM_E2E_SOURCE=<path-to-a-studio-folder> scripts/e2e-server.sh
#                                    # build SPA, boot :8785, seed, stay in foreground
#   CUTROOM_E2E_FRESH=1 …            # wipe the scratch data dir first
#   CUTROOM_E2E_SKIP_BUILD=1 …       # reuse server/cutroom/static as-is
#
# CUTROOM_E2E_SOURCE must point at a studio folder (docs/ARCHITECTURE.md):
# a directory with prompts/shots.jsonl, renders/ and audio/. The suite needs
# real footage, so no default is guessed.
#
# Everything lands in a temp CUTROOM_DATA. This script REFUSES to run against
# ~/.cutroom — the production store is never touched (docs/PLAN.md records the
# time that regression bit us).
#
# Seeding is idempotent: on a warm data dir the import is skipped, so repeat
# runs boot in seconds. Playwright's `webServer` reuses a live server locally.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CUTROOM_E2E_PORT:-8785}"
HOST="127.0.0.1"
BASE="http://${HOST}:${PORT}"
PID="${CUTROOM_E2E_PROJECT:-next-year}"
FILM_SRC="${CUTROOM_E2E_SOURCE:-${CUTROOM_E2E_FILM_SRC:-}}"
DATA="${CUTROOM_E2E_DATA:-/tmp/cutroom-e2e/data}"
LANES=(still i2i motion vo sfx music)

say() { printf '\033[36m[e2e-server]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[e2e-server] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- safety rails
case "$DATA" in
  "$HOME/.cutroom"|"$HOME/.cutroom/"*) die "refusing to use the production store: $DATA" ;;
  ""|"/") die "bad CUTROOM_E2E_DATA: '$DATA'" ;;
esac
[ -n "$FILM_SRC" ] || die "set CUTROOM_E2E_SOURCE to a studio folder (a directory with prompts/shots.jsonl, renders/, audio/)"
[ -f "$FILM_SRC/prompts/shots.jsonl" ] || die "no studio folder at $FILM_SRC (need prompts/shots.jsonl)"

# The API is open only when this is unset; an inherited value would 401 everything.
unset CUTROOM_AUTH_TOKEN CUTROOM_ADMIN_TOKEN CUTROOM_DEMO || true

if [ "${CUTROOM_E2E_FRESH:-0}" = "1" ]; then
  say "wiping $DATA"
  rm -rf "$DATA"
fi
mkdir -p "$DATA"

# ---------------------------------------------------------------- SPA build
CUTROOM_BIN="$REPO/server/.venv/bin/cutroom"
[ -x "$CUTROOM_BIN" ] || die "no server venv — run ./dev.sh build once (creates server/.venv)"

if [ "${CUTROOM_E2E_SKIP_BUILD:-0}" != "1" ]; then
  # server/cutroom/static/ is gitignored, so this leaves no git noise.
  say "building the SPA into server/cutroom/static"
  ( cd "$REPO" && ./dev.sh build >/dev/null ) || die "SPA build failed"
else
  say "skipping SPA build (CUTROOM_E2E_SKIP_BUILD=1)"
fi
[ -f "$REPO/server/cutroom/static/index.html" ] || die "server/cutroom/static/index.html missing — run without CUTROOM_E2E_SKIP_BUILD"

# ---------------------------------------------------------------- boot
say "starting cutroom on $BASE with CUTROOM_DATA=$DATA"
CUTROOM_DATA="$DATA" CUTROOM_RUN_WORKERS=1 "$CUTROOM_BIN" --host "$HOST" --port "$PORT" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 120); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || die "server exited during boot"
  sleep 0.5
done
curl -fsS "$BASE/api/health" >/dev/null || die "server never became healthy on $BASE"

# Paranoia: confirm the running server is on the scratch dir, not ~/.cutroom.
LIVE_DATA="$(curl -fsS "$BASE/api/system" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("data_dir",""))')"
case "$LIVE_DATA" in
  "$HOME/.cutroom"*) die "server is running on the PRODUCTION store ($LIVE_DATA) — aborting" ;;
esac
say "data_dir = $LIVE_DATA"

post() { curl -fsS -X POST "$BASE$1" -H 'content-type: application/json' -d "$2"; }

# ---------------------------------------------------------------- backends
say "enabling the mock backend, disabling local-comfyui"
post /api/backends '{"id":"mock","type":"mock","enabled":true,"label":"Test mode (existing footage, instant)","options":{}}' >/dev/null
# local-comfyui is seeded enabled and would win pick_backend's "first enabled" fallback.
post /api/backends '{"id":"local-comfyui","type":"comfyui","enabled":false}' >/dev/null || true

# ---------------------------------------------------------------- film import
shot_count() {
  curl -fsS "$BASE/api/projects/$PID/film" 2>/dev/null \
    | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(0); raise SystemExit
s = d.get("shots", d) if isinstance(d, dict) else d
print(len(s) if isinstance(s, list) else 0)' 2>/dev/null || echo 0
}

if [ "$(shot_count)" -gt 0 ]; then
  say "project '$PID' already imported ($(shot_count) shots) — skipping import"
else
  # APFS clone the media in, then import with copy_media:false. A real copy is
  # ~617 MB; the clone is near-instant and the importer indexes the store either way.
  PROJ_DIR="$DATA/projects/$PID"
  mkdir -p "$PROJ_DIR"
  for tree in renders audio; do
    if [ -d "$FILM_SRC/$tree" ] && [ ! -e "$PROJ_DIR/$tree" ]; then
      say "cloning $tree/ into the scratch store"
      cp -c -R "$FILM_SRC/$tree" "$PROJ_DIR/$tree" 2>/dev/null \
        || cp -R "$FILM_SRC/$tree" "$PROJ_DIR/$tree"
    fi
  done

  say "importing the film from $FILM_SRC (this is the slow first run)"
  JOB="$(post "/api/projects/$PID/import" \
        "{\"src_root\":\"$FILM_SRC\",\"label\":\"Next Year\",\"copy_media\":false}" \
        | python3 -c 'import json,sys;print(json.load(sys.stdin).get("job",""))')"
  [ -n "$JOB" ] || die "import did not return a job id"

  for _ in $(seq 1 600); do            # up to 10 minutes
    STATUS="$(curl -fsS "$BASE/api/jobs/$JOB" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("status",""))')"
    case "$STATUS" in
      done) break ;;
      failed|cancelled) curl -fsS "$BASE/api/jobs/$JOB/log?tail=40" >&2 || true; die "import job $STATUS" ;;
    esac
    sleep 1
  done
  [ "$STATUS" = "done" ] || die "import job did not finish (last status: $STATUS)"
  say "import done — $(shot_count) shots"
fi

# ---------------------------------------------------------------- lane defaults
say "pinning every lane to mock"
for lane in "${LANES[@]}"; do
  post "/api/projects/$PID/lanes" "{\"lane\":\"$lane\",\"backend\":\"mock\",\"params\":{}}" >/dev/null
done

say "ready — $BASE/app/p/$PID (landing page at $BASE/, mock everywhere, $(shot_count) shots)"
wait "$SERVER_PID"

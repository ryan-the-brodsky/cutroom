#!/bin/zsh
# Genga Studio dev runner for this machine.
#   ./dev.sh            server (:8770) + vite dev server (:5173)
#   ./dev.sh server     API only
#   ./dev.sh build      build SPA into the python package (serve from :8770)
set -e
cd "$(dirname "$0")"

SERVER=server/.venv/bin/python
[ -x "$SERVER" ] || { echo "creating venv…";
  python3.12 -m venv server/.venv && server/.venv/bin/pip install -e "server[dev]"; }

case "${1:-all}" in
  server)
    exec server/.venv/bin/cutroom ;;
  build)
    (cd web && npm install --no-fund --no-audit && npm run build)
    rm -rf server/cutroom/static
    cp -r web/dist server/cutroom/static
    echo "SPA built into server — run ./dev.sh server and open :8770" ;;
  all)
    server/.venv/bin/cutroom &
    SERVER_PID=$!
    trap "kill $SERVER_PID 2>/dev/null" EXIT
    (cd web && npm run dev) ;;
  *)
    echo "usage: dev.sh [all|server|build]"; exit 1 ;;
esac

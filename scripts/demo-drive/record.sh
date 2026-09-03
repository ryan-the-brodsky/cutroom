#!/bin/zsh
# record.sh start <name> | stop
# Screen-records the main display with screencapture -v; writes t0 for marks.
D="$(cd "$(dirname "$0")" && pwd)"
case "$1" in
  start)
    name="${2:-demo-raw}"
    out="$D/$name.mov"
    python3 - "$D" <<'EOF'
import json, sys, time, pathlib
d = pathlib.Path(sys.argv[1]); (d/"t0.json").write_text(json.dumps({"t0": time.time()}))
EOF
    nohup screencapture -v -x "$out" >"$D/record.log" 2>&1 &
    echo $! > "$D/record.pid"
    echo "recording -> $out (pid $(cat "$D/record.pid"))"
    ;;
  stop)
    if [ -f "$D/record.pid" ]; then kill -INT "$(cat "$D/record.pid")" && sleep 3 && rm -f "$D/record.pid"; echo "stopped"; fi
    ls -la "$D"/*.mov 2>/dev/null | awk '{print $5, $9}'
    ;;
  *) echo "usage: record.sh start [name] | stop"; exit 1;;
esac

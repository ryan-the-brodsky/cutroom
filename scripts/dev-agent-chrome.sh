#!/usr/bin/env bash
# Launch system Chrome with the WebMCP flags, a throwaway profile and CDP open,
# then open a URL. This is the browser you point `chrome-devtools-mcp` at.
#
#   scripts/dev-agent-chrome.sh                                   # localhost:8785
#   scripts/dev-agent-chrome.sh http://localhost:8785/app/p/next-year/film
#   scripts/dev-agent-chrome.sh https://<hosted>/app/p/next-year/film
#
# Why a separate --user-data-dir: Chrome applies --enable-features only when it
# actually starts a new browser process. If your daily profile is already
# running, the flags are silently dropped and document.modelContext stays
# undefined. A throwaway profile is the only reliable way — and it keeps your
# real profile untouched.
#
# Measured on Chrome 152.0.7977.65 (docs/TESTING-WEBMCP.md §1):
#   --enable-features=WebMCP  is necessary AND sufficient for document.modelContext.
#   WebMCPTesting + DevToolsWebMCPSupport additionally light up
#   DevTools > Application > WebMCP. navigator.modelContextTesting does NOT
#   exist in 152 regardless of flags.
set -euo pipefail

URL="${1:-http://localhost:8785/}"
PORT="${AGENT_CHROME_CDP_PORT:-9222}"
PROFILE="${AGENT_CHROME_PROFILE:-/tmp/cutroom-agent-chrome}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

[ -x "$CHROME" ] || { echo "Chrome not found at: $CHROME (set CHROME_BIN)" >&2; exit 1; }

case "$URL" in
  https://*|http://localhost*|http://127.0.0.1*) ;;
  *) echo "WARNING: '$URL' is not a secure context — document.modelContext will be undefined." >&2
     echo "         Use https://, http://localhost or http://127.0.0.1 (a LAN IP will not work)." >&2 ;;
esac

mkdir -p "$PROFILE"
echo "[agent-chrome] Chrome $("$CHROME" --version | sed 's/Google Chrome //')"
echo "[agent-chrome] profile   $PROFILE"
echo "[agent-chrome] CDP       http://127.0.0.1:$PORT"
echo "[agent-chrome] opening   $URL"
echo
echo "  Claude Code, once:"
echo "    claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest \\"
echo "      --categoryExperimentalWebmcp=true --autoConnect"
echo

exec "$CHROME" \
  --enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins="http://127.0.0.1:$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  "$URL"

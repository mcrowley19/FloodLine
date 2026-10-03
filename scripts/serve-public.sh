#!/usr/bin/env bash
# Run the backend on this machine and expose it publicly.
# Keeps the Mac awake and restarts the server if it exits. Ctrl+C stops everything.
#
# Default: Tailscale Funnel, which gives this Mac a fixed https://<machine>.<tailnet>.ts.net URL,
# so the Render /api/* rewrite only has to be set once. Requires the Tailscale app signed in and
# Funnel enabled for the tailnet (the first run prints the link to enable it).
# TUNNEL=quick falls back to a Cloudflare quick tunnel, whose URL changes on every start.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8000}
TUNNEL=${TUNNEL:-funnel}
mkdir -p data
log=data/tunnel.log

tailscale_bin() {
  command -v tailscale 2>/dev/null && return
  local app=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  [[ -x $app ]] && echo "$app"
}

case $TUNNEL in
  funnel)
    ts=$(tailscale_bin) || { echo "install Tailscale (or run with TUNNEL=quick)" >&2; exit 1; }
    ;;
  quick)
    command -v cloudflared >/dev/null || { echo "install cloudflared: brew install cloudflared" >&2; exit 1; }
    ;;
  *) echo "TUNNEL must be funnel or quick" >&2; exit 1 ;;
esac

cleanup() {
  trap - EXIT INT TERM
  [[ $TUNNEL == funnel ]] && "$ts" funnel --https=443 off >/dev/null 2>&1 || true
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

caffeinate -dimsu -w $$ &

( until uv run floodline serve --port "$PORT"; do
    echo "[serve-public] server exited, restarting in 5 s" >&2; sleep 5
  done ) &

if [[ $TUNNEL == funnel ]]; then
  # --bg returns once the config is applied; if Funnel isn't enabled it prints the enable link
  # and waits, so cap it and surface the message.
  "$ts" funnel --bg "$PORT" >"$log" 2>&1 &
  fpid=$!
  for _ in $(seq 1 15); do kill -0 "$fpid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$fpid" 2>/dev/null; then
    kill "$fpid" 2>/dev/null || true
    cat "$log" >&2; exit 1
  fi
  wait "$fpid" || { cat "$log" >&2; exit 1; }
  host=$("$ts" status --json | python3 -c "import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))")
  url="https://$host"
else
  cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$log" 2>&1 &
  url=""
  for _ in $(seq 1 30); do
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)
    [[ -n $url ]] && break
    sleep 1
  done
  [[ -n $url ]] || { echo "no tunnel URL, see $log" >&2; exit 1; }
fi

cat <<MSG

  Backend public URL: $url

  Render → static site → Redirects/Rewrites → the /api/* rule should be:
    Source: /api/*   Destination: $url/*   Action: Rewrite

MSG
wait

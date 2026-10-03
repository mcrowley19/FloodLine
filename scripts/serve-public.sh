#!/usr/bin/env bash
# Run the backend on this machine and expose it through a free Cloudflare quick tunnel.
# Keeps the Mac awake and restarts the server if it exits. Ctrl+C stops everything.
# The tunnel URL changes every time this script starts: paste it into the Render rewrite.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8000}
mkdir -p data
log=data/tunnel.log

command -v cloudflared >/dev/null || { echo "install cloudflared: brew install cloudflared" >&2; exit 1; }

cleanup() { trap - EXIT INT TERM; kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

caffeinate -dimsu -w $$ &

( until uv run floodline serve --port "$PORT"; do
    echo "[serve-public] server exited, restarting in 5 s" >&2; sleep 5
  done ) &

cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$log" 2>&1 &

url=""
for _ in $(seq 1 30); do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)
  [[ -n $url ]] && break
  sleep 1
done
[[ -n $url ]] || { echo "no tunnel URL, see $log" >&2; exit 1; }

cat <<MSG

  Backend public URL: $url

  Render → floodline (static site) → Redirects/Rewrites → set the /api/* rule to:
    Source: /api/*   Destination: $url/*   Action: Rewrite

MSG
wait

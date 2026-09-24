#!/bin/bash
# One-command setup for a permanent phone address:
#
#   phone ──https──> <name>.<you>.workers.dev (Cloudflare Worker, free)
#                         │ forwards to the current
#                         ▼
#                    Cloudflare quick tunnel (free, rotates) ──> this Mac :8790
#
# Usage (from miniapp/):  npm run frontdoor            install or update
#                         npm run frontdoor -- off     remove from this Mac
# Safe to re-run. Needs a free Cloudflare account; no domain, no card.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MINIAPP="$(dirname "$HERE")"
D="${FRONTDOOR_DIR:-$HOME/.aside-mobile/front-door}"
LA="$HOME/Library/LaunchAgents"
LABEL=com.aside.frontdoor
U="$(id -u)"
NAME="${FRONTDOOR_NAME:-aside-frontdoor}"
WRANGLER=(npx --yes wrangler@4)

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "${1:-}" = off ]; then
  launchctl bootout "gui/$U/$LABEL" 2>/dev/null || true
  rm -f "$LA/$LABEL.plist"
  echo "Removed $LABEL. The Worker stays in your Cloudflare account;"
  echo "delete it there (or: cd $HERE && npx wrangler delete) if you want it gone."
  echo "Run 'npm run launchd' to restore the server's default tunnel settings."
  exit 0
fi

[ "$(uname)" = Darwin ] || die "macOS only."
command -v node >/dev/null || die "Node.js is required (brew install node)."

step "cloudflared"
if ! command -v cloudflared >/dev/null; then
  command -v brew >/dev/null || die "Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  brew install cloudflared
fi
CF="$(command -v cloudflared)"; echo "using $CF"

step "Cloudflare login"
cd "$HERE"
if ! "${WRANGLER[@]}" whoami 2>/dev/null | grep -q "You are logged in"; then
  echo "A browser window will open. Sign in or create a free Cloudflare account."
  "${WRANGLER[@]}" login
fi

step "Deploy the Worker ($NAME)"
out="$("${WRANGLER[@]}" deploy --name "$NAME" 2>&1)" || { echo "$out"; die "deploy failed. If it mentions a workers.dev subdomain, open the Cloudflare dashboard > Workers & Pages once to claim one, then rerun."; }
FRONT="$(printf '%s\n' "$out" | grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n 1)"
[ -n "$FRONT" ] || { echo "$out"; die "could not read the workers.dev URL from the deploy output."; }
echo "permanent address: $FRONT"

step "Shared secret"
mkdir -p "$D"; chmod 700 "$D"
if [ ! -s "$D/secret" ]; then
  (umask 077; openssl rand -hex 32 > "$D/secret")
  NEW_SECRET=1
fi
# Always (re)send it: a fresh or renamed Worker has no secret yet.
"${WRANGLER[@]}" secret put UPDATE_SECRET --name "$NAME" < "$D/secret" >/dev/null
echo "stored (local copy: $D/secret, mode 600)${NEW_SECRET:+, newly generated}"

step "Install supervisor"
cp "$HERE/supervisor.sh" "$HERE/config-guard.sh" "$D/"
chmod 700 "$D/supervisor.sh" "$D/config-guard.sh"
( umask 077; printf 'FRONT=%q\nCF=%q\nLOCAL=%q\n' "$FRONT" "$CF" "http://127.0.0.1:${MINIAPP_PORT:-8790}" > "$D/frontdoor.env" )

step "Point the app server at the front door"
cd "$MINIAPP"
MINIAPP_TUNNEL=external MINIAPP_TUNNEL_HOSTNAME="${FRONT#https://}" \
MINIAPP_RELAY_FUNNEL=0 MINIAPP_RELAY_NGROK=0 npm run --silent launchd

mkdir -p "$LA" "$HOME/Library/Logs"
cat > "$LA/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$D/supervisor.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/$LABEL.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$LABEL.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
PLIST
launchctl bootout "gui/$U/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$U" "$LA/$LABEL.plist"

step "Waiting for $FRONT (up to ~2 minutes)"
for _ in $(seq 1 60); do
  if curl -s -m 10 "$FRONT/api/health" | grep -q '"ok":true'; then
    printf '\n\033[32mReady.\033[0m Your phone address is %s/app\n' "$FRONT"
    echo "Pair a phone: open http://127.0.0.1:${MINIAPP_PAIR_PORT:-8791}/pair on this Mac and scan the QR code."
    exit 0
  fi
  sleep 2
done
die "not reachable yet. Check ~/Library/Logs/$LABEL.log and ~/Library/Logs/com.aside.mobile.log"

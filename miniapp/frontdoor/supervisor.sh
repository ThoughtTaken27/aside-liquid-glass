#!/bin/bash
# Keeps a Cloudflare quick tunnel to the Aside mobile app alive and tells the
# front-door Worker its current hostname. Installed by `npm run frontdoor`
# and run by launchd (com.aside.frontdoor): RunAtLoad + KeepAlive.
# Outbound-only HTTPS (http2 over 443), so it works behind VPNs and
# restrictive Wi-Fi without opening any port on the Mac.
#
# A quick tunnel rides ONE connection. When the Mac's network path changes
# (VPN on/off/server switch, Wi-Fi change, wake) that connection can die
# silently, so a path change triggers an immediate make-before-break rebuild:
# new tunnel up and verified, front door switched, then the old one killed.
set -u
unset OPENSSL_CONF
D="${FRONTDOOR_DIR:-$HOME/.aside-mobile/front-door}"
# frontdoor.env (written by the installer) sets FRONT, and optionally LOCAL and CF.
# shellcheck disable=SC1091
. "$D/frontdoor.env"
: "${FRONT:?FRONT missing from $D/frontdoor.env; rerun npm run frontdoor}"
LOCAL="${LOCAL:-http://127.0.0.1:8790}"
CF="${CF:-$(command -v cloudflared)}"
[ -x "$CF" ] || { echo "cloudflared not found; brew install cloudflared" >&2; sleep 60; exit 1; }
SECRET="$(cat "$D/secret")"
PID=""
URL=""

say() { echo "$(date '+%F %T') $*"; }

cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; exit 0; }
trap cleanup TERM INT

publish() {
  curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$FRONT/__frontdoor/origin" \
    -H "authorization: Bearer $SECRET" -H 'content-type: application/json' \
    -d "{\"url\":\"$URL\"}"
}

# Default route interface + VPN state: changes whenever the path out changes.
net_sig() {
  local ifc vpn
  ifc="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
  vpn="$(scutil --nc list 2>/dev/null | grep -vi tailscale | grep -oE '^\* \((Connected|Disconnected|Connecting|Disconnecting)\)' | tr -d '\n')"
  echo "$ifc|$vpn"
}

# Tunnel answers end to end? Some VPN resolvers negative-cache brand-new
# hostnames, so resolve via Cloudflare DNS-over-HTTPS and pin the IP.
tunnel_ok() {
  local url="$1" host ip
  host="${url#https://}"
  ip="$(curl -s -m 5 -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$host&type=A" | grep -oE '"data":"[0-9.]+"' | head -n 1 | cut -d'"' -f4)"
  if [ -n "$ip" ]; then
    curl -s -m 8 --resolve "$host:443:$ip" "$url/api/health" | grep -q '"ok":true'
  else
    curl -s -m 8 "$url/api/health" | grep -q '"ok":true'
  fi
}

# Start a new tunnel, wait until it really answers, point the front door at
# it, and only then retire the previous one.
rebuild() {
  local log new_pid new_url ok code
  log="$D/cloudflared.$$.$RANDOM.log"
  "$CF" tunnel --no-autoupdate --protocol http2 --url "$LOCAL" >"$log" 2>&1 &
  new_pid=$!
  new_url=""
  for _ in $(seq 1 60); do
    new_url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -n 1)"
    [ -n "$new_url" ] && break
    kill -0 "$new_pid" 2>/dev/null || break
    sleep 1
  done
  if [ -z "$new_url" ]; then
    say "new tunnel gave no URL"; kill "$new_pid" 2>/dev/null; rm -f "$log"; return 1
  fi
  ok=0
  for _ in $(seq 1 45); do
    if tunnel_ok "$new_url"; then ok=$((ok + 1)); else ok=0; fi
    [ "$ok" -ge 3 ] && break
    kill -0 "$new_pid" 2>/dev/null || break
    sleep 2
  done
  local old_pid="$PID"
  PID="$new_pid"; URL="$new_url"
  mv -f "$log" "$D/cloudflared.log"
  code=""
  for _ in 1 2 3 4 5 6; do
    code="$(publish)"; [ "$code" = 200 ] && break; sleep 5
  done
  say "tunnel up: $URL (pid $PID, ready=$ok, published=$code)"
  [ -n "$old_pid" ] && [ "$old_pid" != "$PID" ] && kill "$old_pid" 2>/dev/null
  return 0
}

# Self-healing config: re-pin the settings this setup depends on and restart
# the app server if anything rewrote them (see config-guard.sh). An optional
# executable $D/local-guard runs afterwards with the same exit-code contract,
# for per-machine pins that do not belong in the shared project.
guard() {
  local out rc lrc U
  out="$(/bin/bash "$D/config-guard.sh" 2>&1)"; rc=$?
  if [ -x "$D/local-guard" ]; then
    local lout; lout="$("$D/local-guard" 2>&1)"; lrc=$?
    [ -n "$lout" ] && out="${out:+$out; }$lout"
    [ "$lrc" -gt "$rc" ] && rc=$lrc
  fi
  [ -n "$out" ] && say "config guard: $out"
  U="$(id -u)"
  if [ "$rc" -eq 11 ]; then
    xattr -d com.apple.quarantine "$HOME/Library/LaunchAgents/com.aside.mobile.plist" 2>/dev/null
    launchctl bootout "gui/$U/com.aside.mobile" 2>/dev/null; sleep 2
    launchctl bootstrap "gui/$U" "$HOME/Library/LaunchAgents/com.aside.mobile.plist" && say "config guard: reloaded app server job"
  elif [ "$rc" -eq 10 ]; then
    launchctl kickstart -k "gui/$U/com.aside.mobile" && say "config guard: restarted app server"
  fi
}

sig="$(net_sig)"
guard
fails=0
tick=0
while :; do
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    PID=""
    rebuild || { sleep 10; continue; }
    fails=0; tick=0; sig="$(net_sig)"
  fi
  sleep 15
  tick=$((tick + 1))

  now="$(net_sig)"
  if [ "$now" != "$sig" ]; then
    say "network changed ($sig -> $now); rebuilding tunnel"
    sleep 4   # let the new route/DNS settle
    rebuild && { fails=0; tick=0; }
    sig="$(net_sig)"
    continue
  fi

  # Every ~5 min: re-publish (Worker self-heals if its state was lost) and
  # re-check the config pins.
  if [ $((tick % 20)) -eq 0 ]; then publish >/dev/null; guard; fi

  # Only judge the tunnel when the app and the internet are both fine.
  if curl -s -m 5 -o /dev/null "$LOCAL/api/health" && curl -s -m 8 -o /dev/null https://www.cloudflare.com/cdn-cgi/trace; then
    if tunnel_ok "$URL" && curl -s -m 12 "$FRONT/api/health" | grep -q '"ok":true'; then
      fails=0
    else
      fails=$((fails + 1))
      say "health check failed ($fails)"
      if [ "$fails" -ge 2 ]; then
        say "rebuilding stale tunnel"
        rebuild && fails=0
      fi
    fi
  fi
done

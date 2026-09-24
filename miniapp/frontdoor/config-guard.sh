#!/bin/bash
# Self-healing check, run by supervisor.sh at start and every ~5 minutes.
#
# The app server's launchd job must keep the environment that points it at
# the front door. If anything rewrites the job (for example a plain
# `npm run launchd` from a shell without these variables), put them back.
#
# Prints one line per repair and nothing when all is well.
# Exit 0 = fine, 11 = repaired the launchd job (supervisor reloads it).
set -u
D="${FRONTDOOR_DIR:-$HOME/.aside-mobile/front-door}"
. "$D/frontdoor.env"
PLIST="${GUARD_PLIST:-$HOME/Library/LaunchAgents/com.aside.mobile.plist}"
PB=/usr/libexec/PlistBuddy
[ -f "$PLIST" ] || { echo "no app server job at $PLIST; run npm run launchd"; exit 0; }

host="${FRONT#https://}"
changed=""
pin() { # key value
  local cur
  cur="$("$PB" -c "Print :EnvironmentVariables:$1" "$PLIST" 2>/dev/null)"
  [ "$cur" = "$2" ] && return
  [ -z "$changed" ] && cp -p "$PLIST" "$PLIST.bak-guard-$(date +%Y%m%d%H%M%S)"
  "$PB" -c "Add :EnvironmentVariables dict" "$PLIST" 2>/dev/null
  "$PB" -c "Delete :EnvironmentVariables:$1" "$PLIST" 2>/dev/null
  "$PB" -c "Add :EnvironmentVariables:$1 string $2" "$PLIST"
  changed="$changed $1"
}
pin MINIAPP_TUNNEL external
pin MINIAPP_TUNNEL_HOSTNAME "$host"
pin MINIAPP_RELAY_FUNNEL 0
pin MINIAPP_RELAY_NGROK 0
if [ -n "$changed" ]; then echo "repaired app server job:$changed"; exit 11; fi
exit 0

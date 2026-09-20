#!/bin/bash

# --- tailnet hostname ------------------------------------------------------
#
# Every install has a different one, so it is resolved here rather than
# written into the repo. Asking Tailscale is more reliable than asking the
# user to remember it, and it is the same value the server publishes on.
#
# Some installs run a userspace tailscaled of their own rather than the
# system one. Those are checked first, then the system daemon.
if [ -z "${ASIDE_TAILNET_HOST:-}" ]; then
  TS_BIN="${TAILSCALE_CLI:-$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)}"
  for TS_SOCK in \
    "$HOME/.aside-mobile/tailscale/ts.sock" \
    "$HOME/.aside-telegram-bridge/tailscale/ts.sock"
  do
    [ -S "$TS_SOCK" ] || continue
    ASIDE_TAILNET_HOST="$("$TS_BIN" --socket "$TS_SOCK" status --json 2>/dev/null \
      | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.Self.DNSName.replace(/\.$/,""))' 2>/dev/null || true)"
    [ -n "${ASIDE_TAILNET_HOST:-}" ] && break
  done
  if [ -z "${ASIDE_TAILNET_HOST:-}" ]; then
    ASIDE_TAILNET_HOST="$("$TS_BIN" status --json 2>/dev/null \
      | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.Self.DNSName.replace(/\.$/,""))' 2>/dev/null || true)"
  fi
fi
if [ -z "${ASIDE_TAILNET_HOST:-}" ]; then
  echo "error: could not work out this Mac's tailnet hostname." >&2
  echo "Start Tailscale, or set it by hand:" >&2
  echo "  export ASIDE_TAILNET_HOST=your-mac.tailXXXX.ts.net" >&2
  exit 1
fi
export ASIDE_TAILNET_HOST
echo "==> tailnet host: $ASIDE_TAILNET_HOST"
#
# Rebuild the Aside Android app.
#
# Run this after any change to the web app that you want baked into a fresh
# APK. Note that for most changes you do NOT need to rebuild at all: the
# shell loads the UI from the Mac at runtime, so a `npm run build` in
# miniapp/web plus a reload on the phone is enough. Rebuild the APK only
# when something in the native shell changes: the icon, the app name, the
# server URL in capacitor.config.ts, or a Capacitor plugin.
#
# The toolchain lives outside Homebrew on this machine on purpose:
# `brew install openjdk@21` produced a broken install here (empty libexec,
# every symlink dangling), so the JDK is an unpacked Temurin tarball. That
# is a local accident, not a requirement -- everything below resolves the
# toolchain rather than assuming one, so a clean clone builds.
#
set -euo pipefail

# JDK 21, in order of preference: whatever the caller exported, then the
# system's registered JDK, then the unpacked tarball this machine happens
# to use.
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
fi
if [ -z "${JAVA_HOME:-}" ] && [ -d "$HOME/java/jdk-21.0.12+8/Contents/Home" ]; then
  JAVA_HOME="$HOME/java/jdk-21.0.12+8/Contents/Home"
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/javac" ]; then
  echo "error: no JDK 21 found." >&2
  echo "  brew install --cask temurin@21" >&2
  echo "  # or: export JAVA_HOME=/path/to/jdk-21" >&2
  exit 1
fi
export JAVA_HOME
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ ! -d "$ANDROID_HOME" ]; then
  echo "error: no Android SDK at $ANDROID_HOME." >&2
  echo "  set ANDROID_HOME, or install the SDK (see README)." >&2
  exit 1
fi
for required in \
  "$ANDROID_HOME/platforms/android-36" \
  "$ANDROID_HOME/build-tools/36.0.0"
do
  if [ ! -d "$required" ]; then
    echo "error: missing Android SDK package: $required" >&2
    echo '  sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"' >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Build this checkout. ASIDE_WEB_DIR may point at another checkout.
WEB="${ASIDE_WEB_DIR:-$HERE/miniapp/web}"
if [ ! -d "$WEB" ]; then
  echo "error: no web project at $WEB" >&2
  exit 1
fi
OUT="$WEB/android/app/build/outputs/apk/debug/app-debug.apk"

echo "==> building from: $WEB"
cd "$WEB"

if [ ! -d node_modules ]; then
  echo "error: dependencies are not installed. Run this first:" >&2
  echo "  (cd $(dirname "$WEB") && npm install)" >&2
  exit 1
fi

echo "==> building web assets"
npm run build

echo "==> syncing into the native project"
npx cap sync android

echo "==> checking the shell carries no pairing credential"
#
# Pairing codes are one-time and expire after ten minutes, so there is
# nothing durable to embed: a baked code would be dead before the APK is
# installed. The shell always launches unpaired; the owner pastes one
# fresh link into its pairing screen on first run, the same flow iPhone
# already uses. Pairing writes the HttpOnly session cookie, so the app
# stays paired after the code is spent.
ASSET_CFG="$WEB/android/app/src/main/assets/capacitor.config.json"
if grep -q '#pair=' "$ASSET_CFG" 2>/dev/null; then
  echo "error: pairing fragment baked into $ASSET_CFG. Remove it first." >&2
  exit 1
fi
echo "  clean: no pairing fragment in the shell config"

echo "==> assembling APK"
cd android
#
# Memory flags, not preferences.
#
# This is an 8 GB M1 Air that is usually already running Chrome, the Aside
# daemon and a Node server, so a default Gradle invocation gets OOM-killed
# by the kernel partway through (`zsh: killed`, no stack trace, nothing in
# the log). Three things keep it inside the budget:
#
#   --no-daemon        a lingering daemon cannot be killed from the agent
#                      sandbox, and a stale one holds the SDK lock
#   --max-workers=1    parallel workers each get their own JVM
#   -Xmx1280m          under the 1536m in gradle.properties, and low enough
#                      that the JVM plus metaspace still fits
#
# With these the whole assemble runs in ~13s and has not been killed since.
#
# AAPT2: the binary Gradle downloads from Maven is quarantined by macOS on
# some machines and its daemon refuses to start. The copy that ships with
# the installed build-tools is identical in function and does run, so AGP
# is pointed at that when one is present. Detected rather than hardcoded --
# this used to be an absolute path in gradle.properties, which meant the
# repo only built on one Mac.
AAPT2_ARG=()
LOCAL_AAPT2="$(ls "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$LOCAL_AAPT2" ]; then
  AAPT2_ARG=(-Pandroid.aapt2FromMavenOverride="$LOCAL_AAPT2")
  echo "==> using local aapt2: $LOCAL_AAPT2"
fi

./gradlew assembleDebug --no-daemon --max-workers=1 \
  "${AAPT2_ARG[@]}" \
  -Dorg.gradle.jvmargs="-Xmx1280m -XX:MaxMetaspaceSize=384m" -q

echo "==> done"
ls -lh "$OUT"
cp "$OUT" "$HOME/Downloads/Aside-mobile.apk"
echo "copied to ~/Downloads/Aside-mobile.apk"

echo
echo "Install on the phone with either:"
echo "  adb install -r ~/Downloads/Aside-mobile.apk"
echo "  (or AirDrop/copy the file and tap it on the phone)"

# PUBLISH_BLOCK_V1
# The APK is NOT served over the tailnet: past builds copied it into
# web/dist, where the app server would happily serve it to anyone on the
# tailnet, credential baked in. Keep exactly one local archive copy.
mkdir -p "$HOME/.aside-mobile/apk"
cp "$OUT" "$HOME/.aside-mobile/apk/Aside-mobile.apk"
echo "archived (local only, never served): $HOME/.aside-mobile/apk/Aside-mobile.apk"

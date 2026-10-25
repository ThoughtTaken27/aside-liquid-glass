# Setting up Aside Mobile as an agent

Follow this checklist in order and verify each success condition.

Ask the user only for actions an agent cannot complete safely: signing in to Aside, Cloudflare, or Tailscale, entering an administrator password, handling the phone, or approving a security-relevant change.

Do not expose the default pairing port `8791`, copy credentials into the repository, disable device security, or publish an APK.

## Success test

The setup is complete when:

- `npm run doctor` exits with no failures.
- The Mac answers `/api/health` locally and `/app` over the chosen front door (Cloudflare Worker or Tailscale HTTPS).
- If Tailscale is used, Tailscale Serve proxies the default app port `8790` only.
- The phone opens the session list and receives a reply.
- A fresh pairing link is spent once and cannot be replayed.

## 1. Verify prerequisites

```bash
sw_vers -productVersion
node --version
which git
```

Require macOS, Node **22.5+**, Git, and an installed/signed-in Aside app.

Do not assume an account lives at `~/.aside/u/0`; the server resolves the active account from Aside's account metadata and `npm run doctor` verifies the resulting CLI and session paths.

If Homebrew is absent, direct the user to <https://brew.sh/> rather than piping an unreviewed remote script into a shell.

## 2. Clone and build reproducibly

```bash
git clone https://github.com/ThoughtTaken27/aside-liquid-glass.git ~/aside-liquid-glass
cd ~/aside-liquid-glass/miniapp
npm run setup
```

This uses `npm ci`, builds both workspaces, and runs the doctor.

**Check:** Toolchain, Build, and Configuration contain no `FAIL`; Runtime and Tailscale warnings are expected before those services are configured.

Do not work around a failed install by recursively removing quarantine flags. Report the exact failure and use the package manager's documented recovery path.

## 3a. Permanent address (default choice)

Use this unless the user asks for Tailscale. It needs no app on the phone and works behind VPNs and restrictive Wi-Fi.

```bash
cd ~/aside-liquid-glass/miniapp
npm run frontdoor
```

The user must complete the Cloudflare browser sign-in once. The script deploys the Worker, installs `com.aside.mobile` and `com.aside.frontdoor` as login services, and prints the phone address.

**Check:** `curl -s https://<printed-address>/api/health` returns `"ok":true`, and `~/Library/Logs/com.aside.frontdoor.log` shows `published=200`. Then skip to step 5.

## 3. Configure Tailscale (alternative)

```bash
brew install --cask tailscale
open -a Tailscale
```

Ask the user to sign in on the Mac and phone with the same Tailscale account.

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
$TS status
export ASIDE_TAILNET_HOST="$($TS status --json | node -e \
  'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(d.Self.DNSName.replace(/\.$/,""))')"
printf '\nexport ASIDE_TAILNET_HOST=%q\n' "$ASIDE_TAILNET_HOST" >> ~/.zshrc
```

Ask the user to enable HTTPS Certificates in Tailscale's DNS settings, then run:

```bash
$TS serve --bg 8790
$TS serve status
```

**Check:** HTTPS routes to `http://127.0.0.1:8790`, and no rule mentions `8791`.

## 4. Start the server

```bash
cd ~/aside-liquid-glass/miniapp
npm start
```

In another shell:

```bash
curl -s http://127.0.0.1:8790/api/health
curl -sI "https://$ASIDE_TAILNET_HOST/app" | head -1
npm run doctor
```

**Check:** health returns `{"ok":true}`, HTTPS returns 200, and the doctor reports no failures.

For launchd persistence:

```bash
npm run launchd
```

The installer snapshots supported `MINIAPP_*`, `ASIDE_TAILNET_HOST`, and `TAILSCALE_CLI` values from the current shell because launchd does not source shell startup files.

Rerun the installer after changing those values.

## 5. Pair the requested client

Open the loopback-only page on the Mac:

```bash
open "http://127.0.0.1:${MINIAPP_PAIR_PORT:-8791}/pair"
```

**Check:** it shows an HTTPS MagicDNS link, not `127.0.0.1`; otherwise fix Tailscale discovery before proceeding.

Each page load issues a new one-time code that expires after ten minutes.

- **Android web app:** scan the QR, then add the page to the home screen.
- **Android native APK:** install/open the APK first, then paste the copied link into its pairing screen.
- **iPhone:** install `/app` from Safari first, open the home-screen app, then paste the copied link.

**Check:** the app lists sessions and a test message receives a reply.

## 6. Build Android only when requested

```bash
brew install --cask temurin@21
brew install --cask android-commandlinetools
export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
cd ~/aside-liquid-glass
./build-android.sh
```

**Check:** `~/Downloads/Aside-mobile.apk` exists and the script reports no pairing fragment.

The script keeps a second local archive under `~/.aside-mobile/apk/`; it does not publish or serve either file.

Do not disable Play Protect or advise the user to do so.

## 7. Final verification

```bash
cd ~/aside-liquid-glass/miniapp
npm run typecheck
npm test
npm run build
npm audit --omit=dev
npm run doctor
cd ..
git diff --check
git status --short
```

Explain every remaining warning and changed file before asking for approval to commit or push.

Do not push, publish, submit, or install anything without the user's explicit approval for that exact action.

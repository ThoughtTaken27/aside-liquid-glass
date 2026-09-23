# Public relays: the phone reaches the Mac over plain HTTPS

The phone used to need the Tailscale app holding the iOS VPN slot to reach
this server. That slot fits exactly one VPN app, so the owner's real VPN and
the bridge fought over it. The relays end that fight: the Mac publishes its
app port to the public internet over plain HTTPS, and the phone becomes an
ordinary browser client. Nothing to install, nothing to sign in to, no VPN
slot involved, on any network anywhere.

Two relays, both free, both supervised by the server itself:

| Relay | Address | Needs from the owner |
|---|---|---|
| **Funnel** (primary) | `https://<mac>.tailnet.ts.net` — the Mac's existing Tailscale name, no port | Funnel switched on once in the Tailscale admin console |
| **ngrok** (backup) | `https://<name>.ngrok-free.dev` — a free static domain | Free ngrok account, one reserved domain, its authtoken in the bridge config |

Both addresses are stable: they never rotate and never expire, so each one
is paired once from the pairing page and trusted afterwards. When the
primary is down the app moves to the backup on its own; when the primary
answers again a banner offers the way back. Either relay being down is an
inconvenience, never a disconnection — and both being down behaves exactly
like the server did before relays existed.

## One-time setup

### 1. Funnel (primary, ~1 minute)

1. Open the [Tailscale admin console](https://login.tailscale.com/admin/settings/general),
   find **Funnel**, and switch it **On** for the tailnet.
2. Restart the server (or wait ~30 seconds). It enables Funnel for the app
   port itself and verifies it by reading the status back.

Confirm with the doctor:

```
cd miniapp && npm run doctor
```

Look for `ok funnel serves this server (https://<mac>...)` under
**Public relays**. If it says Funnel is not enabled, step 1 has not
propagated yet — give it a minute and rerun.

No account, no daemon, no config: the Tailscale the Mac already runs does
it. The phone needs nothing at all.

### 2. ngrok (backup, ~5 minutes)

1. Install ngrok: `brew install ngrok`.
2. Sign up free at [ngrok.com](https://ngrok.com) and open the dashboard.
3. **Domains** → **New Domain**: reserve a free static domain
   (`<name>.ngrok-free.dev`, one per free account).
4. Copy the **authtoken** from **Your Authtoken**.
5. Put both in the bridge config's `miniapp` section:

```jsonc
{
  "miniapp": {
    "ngrok_domain": "aside-mac.ngrok-free.dev",
    "ngrok_authtoken": "<authtoken>"
  }
}
```

(The launchd service does not inherit shell exports, so the token lives in
the config file next to the bot token — never in a plist. `NGROK_AUTHTOKEN`
as an environment variable also works for terminal runs and wins over the
config value.)

6. Restart the server. It spawns ngrok, waits for the agent API to confirm
   *your* domain (not just any tunnel), and supervises it from then on.

The doctor should show `ok ngrok tunnel is up (https://<name>...)`.

Free-tier realities, stated plainly: the static domain shows a one-time
browser interstitial until dismissed, and the free tier carries request and
bandwidth quotas. This is a backup, not a home.

### 3. Pair each address once

Open `http://127.0.0.1:8791/pair` on the Mac (or your configured pair port).
The page lists every verified address — Funnel first, ngrok next, the
tailnet fallback last — each with its own one-time link. Open each link
once on the phone (same install-first-then-paste order on iPhone as
before). Each origin keeps its own stored token, which is why every
address needs its own pairing and why the app can then move between them
without asking again.

## How failover behaves

- **Dead origin, healthy backup:** the next failed request probes the
  current origin, then each relay in order, and navigates to the first one
  that answers — same page, same thread, pairing key preserved. Boot does
  the same while launching, so a dead primary at launch lands on the
  backup instead of an error.
- **On the backup:** a slim banner says so, re-checks the primary every
  minute, and offers a **Switch** button the moment it answers. Switching
  back is always a tap, never automatic mid-thread.
- **Launched into a total outage:** the service worker serves its offline
  page with links to every backup address it learned from earlier visits.
- **Everything down:** the app says the Mac is unreachable and offers the
  pairing prompt, exactly as before. Failover only ever moves *toward* an
  address that just answered a probe — it never navigates on a guess.

## Verifying and troubleshooting

The server log names each relay at boot:

```
relay funnel: https://mac.tail123.ts.net
relay ngrok: no static domain configured (miniapp.ngrok_domain, e.g. ...)
```

`[funnel]` / `[ngrok]` lines after that are supervision events
(enabled, dropped, retrying). The authenticated `/api/relays` route and
the doctor's **Public relays** section show the same state on demand.

| Symptom | Meaning | Fix |
|---|---|---|
| `Tailscale CLI not found` | No Tailscale on this Mac | `brew install --cask tailscale`, sign in |
| `Funnel is not enabled for this tailnet` | Admin switch is off | Admin console → Settings → Funnel: On |
| `tailnet not connected (no MagicDNS name yet)` | Daemon not signed in / starting | `open -a Tailscale`, wait, rerun doctor |
| `NGROK_AUTHTOKEN is not set` / `no static domain` | Backup half-configured | Finish ngrok setup step 5 above |
| `cannot start ngrok` | Binary missing | `brew install ngrok`, or set `NGROK_BIN` |
| `static domain never came up` | Token rejected, domain released, or quota spent | Check the ngrok dashboard, then restart |
| Phone lands on backup asking to pair | That address was never paired | Open its link from the pairing page once |

## Disabling

Either relay can be switched off without touching the other:

```jsonc
{ "miniapp": { "relay_funnel": false, "relay_ngrok": false } }
```

or `MINIAPP_RELAY_FUNNEL=0` / `MINIAPP_RELAY_NGROK=0` for one run. With
both off the server is byte-for-byte the old behaviour: tailnet only, plus
the quick cloudflared tunnel if `miniapp.tunnel` says so.

## Security posture

- The relays proxy **only the app port**. The pairing page lives on its
  own loopback-only port that nothing proxies, and the doctor fails if any
  tailscale rule ever points at it.
- Every API route except auth/pair/health needs the JWT; `/api/relays`
  included. Pairing codes are 192-bit, one-time, ten-minute, 5 spends per
  minute.
- Rate limits key off the socket peer, never off client-writable headers,
  so they hold behind any relay. `trustProxy` stays off.
- The paired token is now a normal web session (bearer over TLS, 90-day
  expiry, rotation on use) rather than a second lock inside the tailnet.
  Deleting the signing secret still revokes every device at once.
- The client only probes and navigates to exact `https://host` origins the
  server verified; no wildcards anywhere in the chain (CSP included).

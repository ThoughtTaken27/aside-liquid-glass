# Security and public releases

This is a single-owner remote control surface for a local Aside account, not a
multi-user or tenant-isolated service. A paired client can access that owner's
sessions, files, history, and enabled integrations. Treat session tokens, pairing
links, visual capability URLs, and front-door update secrets as credentials.

## Deployment boundaries

- Bind the app and pairing services to loopback. Only proxy the app port.
- Never expose the pairing listener, development server, or debugging ports.
- Pairing codes are short-lived and single-use. Never include one in a build,
  screenshot, log, URL query, or source commit.
- Use HTTPS remotely; preserve authentication and cookie security at the proxy.
- Never automatically replay writes after a tunnel/proxy failure: delivery may
  already have occurred. GET/HEAD retries do not authorize retrying mutations.
- Keep runtime configuration, TLS/private keys, databases, device enrollments,
  uploads, credentials, and build artifacts outside Git.

## Generated visuals

Visuals run in an opaque-origin sandbox with scripts only: no app cookies,
storage, DOM, popups, top navigation, forms, or downloads. The trusted parent
explicitly uses `frame-src 'self'`, which also constrains frame self-navigation.

Chrome/Chromium 152+ receives `Connection-Allowlist: (); redirects=block;
webrtc=block` on each visual response. This browser-enforced deny-all network
policy covers outgoing resource requests, navigations, DNS hints, WebRTC, and
other explicit connections; a restrictive CSP remains a second layer. It does
not stop CPU/memory exhaustion or every browser side-channel/vulnerability.

Interactive rendering requires a browser engine supporting that header. The
server uses the Chromium version in User-Agent as a compatibility check, NOT as
an authentication boundary. Older/unrecognized engines receive a CSP permitting
only the exact trusted resize/theme bridge by SHA-256 hash; untrusted visual
scripts do not execute. They retain readable HTML and an upgrade notice.
Unsupported/modified browsers that falsely advertise a supported Chromium
engine cannot be guaranteed to enforce the native policy. iOS browser branding
does not imply Chromium and is not treated as supported.

Chart.js 4, D3 7, Three.js 0.170.0 and OrbitControls are built locally from the
lockfile and embedded into visual responses, including data-module imports. No
visual fetches a CDN at runtime. Unknown libraries, remote images, live data
fetches and arbitrary external links are intentionally blocked; use embedded
data/images and reviewed offline libraries instead. Library version mappings
are deterministic local compatibility mappings, not runtime downloads.

Visual capability URLs are bearer access to their contents, not identity-based
authorization. Do not share or log them. New URLs use a versioned path and all
responses are no-store so changes to the isolation policy are not masked by an
immutable browser cache. Previously cached legacy responses cannot be revoked
from a browser remotely; reload/update the app or clear old site data when
transitioning from an older release.

## Supply chain and checks

Use the committed npm lockfile and `npm ci`; review dependency changes before
running installation lifecycle scripts. CI actions are pinned to commit hashes
and granted read-only repository permissions. CI audits development dependencies
as well as production dependencies. Advisory databases and tests are incomplete;
zero reported advisories is not proof that no vulnerabilities exist.

Before release, run typechecks, tests, a production build, `npm audit`, and a
secret/privacy scan of every branch/tag and reachable historical blob. Review
binary images manually; deleting an image in a later commit does not remove it
from Git history. Check GitHub branches, tags, releases, artifacts, and cached
attachments rather than relying only on the local working tree.

## Phone version verification

A source commit, on-disk build, running backend process, front-door assets, and
phone browser/service-worker cache are separate versions. Verify each before
claiming deployment parity. Rebuild in isolation, preserve rollback artifacts,
and do not restart a server with active/queued work. An unavailable device-side
inspection must be reported as unverified, not inferred from the Mac's build.

## Reporting

Report suspected vulnerabilities privately to the repository owner through
GitHub. Do not post credentials, pairing links, personal data, or private visual
capability URLs in public issues. Rotate real exposed credentials before any
publication; deleting them from the newest commit is insufficient.

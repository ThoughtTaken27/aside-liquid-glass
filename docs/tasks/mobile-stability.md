# Mobile stability acceptance contract

## Goal
Chat opening is reliable and stable, Mac tab lists connect quickly, and passive desktop views cannot exhaust the phone's request quota.

## Baseline
Live launchd log (Oct 14, latest sampled 17:45 UTC): over 10 minutes, 361 safety reads + 360 activity reads + 360 plan reads. Failures included 38 tab-list 429s, 10 thread 429s, 18 service-worker 429s and 10 app-shell 429s. Successful threads median 55ms / max 102ms; successful tab read 117ms. Four live read probes all returned 429, with retry-after 5s.
The global limiter keys every socket peer on loopback, with 120/min total. ActivityTab depends on a parent callback which NextDesk recreates each render; each activity read invokes that callback and refreshes the plan, re-rendering the parent and restarting the activity load effect. This is a request feedback loop, not intentional polling.

## Invariants
- Forwarding headers and unverified tokens never select a fresh quota bucket.
- Verify token signature, expiry and allowed owner before using credential identity; keep unauthenticated and route-specific write/auth limits.
- Do not replay mutations automatically; dedupe/retry only idempotent reads.
- Keep Telegram chat, notification opt-in, queued messages and verified Agent-tab ownership unchanged.
- No existing main-task browser tabs are navigated or closed.
- Do not build over live web/dist during testing.

## Exit checks
- Failing regression first: callback rerenders must not generate another safety/activity load or another unchanged paused notification.
- Authenticated phone reads remain successful after anonymous quota exhaustion and after another signed device uses its quota; rotating invalid tokens / forwarding headers still throttle.
- App assets and health do not compete with API reads.
- Rejected stale thread loads cannot overwrite newer success; successful socket transcript removes initial REST error.
- Cold and warm chat opens: capture post-paint text positions in a 393x852 harness, check markdown/visual readiness and first reveal, then perform two screenshot polish passes.
- Browser helper failure retires the failed process, preserves serialization and permits a clean future start; no silent endless reuse of a timed-out helper.
- Run focused + full regressions, both typechecks, production build, diff-check and measured before/after request count / error / latency.
- Distinguish implemented, verified, deployed and actual S24 verification; restart only approved scope and report any platform blocker.

## Design
Inherit app palette and typography; no redesign. Keep chat history stationary, with opacity-only entrance using existing cubic-bezier(.22,1,.36,1); no extra blur/lift. Use existing 44px touch targets and stable skeleton footprint. Values from ui-polish/references/extracted-values.md: Zeron touch geometry, transitions.dev curve, Apple direct-response and no positional animation during content reveal.

## Implemented and verified
- Activity callback identity no longer controls the polling effect; unchanged pause state is reported once, per-filter overlapping loads are shared, and hidden pages stop passive requests.
- Signature/expiry/allowlist-verified credential fingerprints have a finite 600/min budget, separate from anonymous socket quotas (120/min), health, and static assets. Auth/write route-specific limits remain. Rotating junk tokens and forwarded addresses stay in the same anonymous bucket.
- Client GETs share only in-flight work and retry a 429 once after Retry-After, with cancellation. No POST/PUT/DELETE replay; writes clear read flights so a post-write refresh cannot join a pre-write snapshot.
- Old failures cannot overwrite a newer successful thread load; successful socket data clears initial load error. Slow REST snapshots cannot overwrite newer socket sources, counters, todos, child work, or queue cards.
- History reveal checks after paint, waits for final markdown, and considers fonts/images and scroll anchoring. Chrome's native anchoring is disabled on the virtualized scroller because React Virtual and the tail observer already manage it.
- A single restored answer is history, not a fresh message/visual-generation arrival. Real streaming answers remain live and settle without a second entrance.
- Formatting module failure preserves readable text and app controls. Warm-up errors are caught.
- MCP timeouts retire the evaluator, startup abort cannot resurrect it, queued work fails promptly, and the next shared request can start clean. Stale screenshot handles are evicted for reattachment; warm tab-list wait is capped at 2.5s before the existing facade fallback.

## Measured phone QA
393x852, real Thread/Composer/style stack with generic fixture content. An intentionally delayed markdown chunk (2.3s) exposed 166 raw-text frames and one visible 8px row resize before; after, zero raw-visible frames and zero visible row resizes. Normal live warm chat baseline already had zero jumps, so no blanket claim that every open was broken.
Two polish passes: post-paint/final-renderer reveal first; then single-history motion correction, native anchoring removal, quiet-label contrast and 44px copy hit target. Retain existing layout/palette, 20px transcript insets, 16px resident prose/26px line height, and opacity-only entrance. Measured light prose contrast 14.5:1 and subtitle/table/action labels 5.2:1 after (3.09/4.27/4.27 before). Light/dark phone captures, no duplicated or clipped frames.
The harness's first pass revealed Vite's symlink-font allow-list problem; restrictively allowed the real node_modules font root, then recaptured with actual Geist loaded. Temporary harness files are not shipping.
Production critical JS: 255.17KB -> 256.03KB raw; 85.61KB -> 85.93KB gzip, under 1% growth, no new runtime dependency.

## Activation safety
The old live quota continues to deny status checks, so active/queued mobile work could not be established. Process inspection (`ps`) is sandbox-denied. TurnRunner.shutdown explicitly clears its in-memory waiting queue and terminates running CLI children; do not silently restart with unknown work. Activation requires confirmation or a user-run restart after runs/queue are clear. Mac browser tabs and saved transcripts are not deleted by this change. Refresh the existing Mac desk page as well as reopening the phone so the old client loop stops.
Live after-restart latency/429 and real S24 gesture checks remain unverified until activation; fixture measurements are not represented as device measurements.

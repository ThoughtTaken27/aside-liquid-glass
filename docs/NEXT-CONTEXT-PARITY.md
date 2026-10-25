# Next Context Awareness parity contract

Goal contract: local planning document (not part of the release).

Reference: Aside 1.0.928.1 shipped UI bundle. SHA-256 23ebaedf4afb32b5c84b684fc5628185fbc0af6216a5d5ee4294c09083f62107. Static code inspection only, not native execution, observed network behavior or a usability benchmark. Readable copy is in this session tmp; it is not redistributed in the deliverable. Prior daemon architecture findings remain static evidence and must not be promoted to verified native behavior.

No percentage is reported: denominator is this bounded matrix, not all unknown Aside internals. No blocked capability is silently scored as matched. Privacy-preserving substitutes (factual summaries, strict retention) must be labelled, not misrepresented as semantic/native parity.

| ID | Required user capability | Evidence | Baseline | Acceptance verifier |
|---|---|---|---|---|
| C01 | Default-off enable switch, explicit source opt-in | UI: Enable Context Awareness; enable mutation | partial: backend policy only | source consent + fail-closed API tests; phone switch journey |
| C02 | Pause 15m / 30m / 1h / until resume; disable preserves history | UI pause menu and disable confirmation | missing | fake-clock pause/resume + history survives disable |
| C03 | Context-source controls with trustworthy actual status | UI capture state / permission warnings | missing | source off/paused/unavailable states and no ingestion while off |
| C04 | Never-observe app/domain exclusions | UI exclusion list and app selector | missing | host boundary tests; typed/native unavailable until approved |
| C05 | Chronological history with today/yesterday/day selection | UI History day / historyList | missing | bounded day paging and synthetic phone history journey |
| C06 | Expandable summary with source/application provenance | UI history expansion, detail and application chips | missing | expand a factual rollup and trace only its source IDs |
| C07 | Storage bytes and average daily usage | UI historyStatus storage tooltip | missing | bounded encrypted store reports exact on-disk bytes |
| C08 | Clear last 10 minutes / hour / today / all | UI clear mutation / explicit all-history confirmation | missing | deletion scope and confirmation tests; no source-file deletion |
| C09 | Retention controls and automatic expiry | UI raw retention text: summaries stay | missing; stricter derivative expiry required | raw facts AND derived recall expire; no retained summary leaks |
| C10 | Loading / empty / error / retry states | UI skeleton, Nothing captured, Try again | missing | render each state; recover without resetting controls |
| C11 | Local factual condensation at short/long windows | Prior static daemon findings: 10min summaries + 6h rollups | missing | deterministic source-cited windows, no invented content; semantic gap separate |
| C12 | Bounded recent/relevant recall with source evidence | Prior static daemon context tools | missing | lexical/time query and strict scope tests; semantics separately unverified |
| C13 | Persistence across restarts | Prior static daemon local event/index storage | missing | encrypted journal reopen and dedupe tests |
| C14 | Encryption, private file permissions, fail-closed corruption | Prior static daemon encrypted blob storage | missing for new persistent context | encryption/owner/symlink/corruption tests; threat model documents key limits |
| C15 | Deletion generation fences / no resurrection | Prior static daemon delete epochs and index updates | partial: ephemeral projection recomputes | late ingest, old response, restarted process and derived-rollup tests |
| C16 | Distinct observation, source authority and inference | Next hardening source-status vs foreground records | implemented foundation only | activity never marks completion; source stale status distinguished |
| C17 | Fresh / stale / unknown status, source last check | Next hardening evidence TTL | backend only | expiry boundaries, future timestamps, unknown sources; UI indicators |
| C18 | Planner consumes exact context and explains its influence | Next-specific extension; not a reference UI claim | missing | evidence changes resume tie-break only, never overrides deadline/snooze; explanation |
| C19 | Authoritative completion removes queued task | Next buildPlan source resolved handling | existing, needs integrated verifier | complete synthetic school source → queue removal, not click/minutes inference |
| C20 | Accessible touch, keyboard, focus and reduced motion | Reference controls + Apple/coss research | needs UI work | 44px targets, contrast, phone/desktop light/dark, keyboard evidence |
| C21 | Phone cache/offline deletion safety | Next-specific safety requirement | missing | context never persisted to browser cache; stale in-flight response suppressed |
| C22 | Explain on-device vs cloud processing honestly | UI Summary model + background summary wording | missing for Next UI | show Local factual summaries; no cloud claim/egress; provider switch absent |
| C23 | Broad browser page/document content capture | Prior daemon readable page snapshots; UI capture wording | approval-gated, not replicated | selected source permission + approved runtime comparison required |
| C24 | Native application attention/input capture | UI helper availability, Input Monitoring permission | approval/runtime-gated, unverified | approved native helper/tooling and OS permissions required |
| C25 | Typed sentences excluding passwords/keystrokes | UI Capture typed text | approval-gated, not replicated | approved typed-text collector and sensitive-field adversarial checks required |
| C26 | OCR fallback when page has no readable text | UI Allow Screen Recording: text only | approval-gated, not replicated | approved OCR tool/OS permissions and transient bitmap deletion proof required |
| C27 | Rich semantic summary/retrieval and model selection | UI Summary model + prior semantic index observations | approval/provider-gated, not replicated | selected local model/provider policy, quality and egress verifier required |
| C28 | Live served UI and reference/native behavior parity | Goal requires actual ease/use rather than static guesses | deployment/runtime-gated | approved deployment, source/version check and real-device journey |
| C29 | No unapproved external or irreversible action | Existing disabled helper boundary and this session constraints | existing boundary, keep regression | authenticated/unauth helper blocks, no model/network call in context routes |
| C30 | Provider-retention and historical processing clarity | Prior unresolved release blockers | unverified | primary provider evidence + approved inspection; do not imply earlier data erased |

## Security invariants

- Context input is untrusted data, not instructions, permissions or completion authority.
- Personal mail, sensitive/flagged/tainted records and broad private activity never enter this context path.
- Source off means no new processing; pause has visible expiry; old history is retained only per explicit retention.
- Forget removes facts and every derived result, fences stale imports and responses, and never deletes original school/doc/mail records.
- The offline plan may survive; private context and history must not be copied into persistent browser storage.
- Current local facts may influence a bounded same-urgency resume tie-break; they cannot overrule overdue work, low source confidence, snoozes or source completion.
- Protected local storage is not protection against the logged-in owner, root, malware or endpoint compromise; no cloud or perfect-privacy claims.

## Design brief

Purpose: Understand what Next remembers, why it matters, and control or forget it without a config file.
First message: Actual context state and where processing happens, not a security marketing claim.
Surface: Context inside Activity, plus inline task evidence in Today/detail; desktop uses the existing Next frame.
Inherited tokens: Existing Next font, colors, radii and surface variables; no whole-app redesign.

Source-backed values: 44px minimum targets (Apple HIG buttons); clearly labelled row switches, text plus state rather than color alone (Apple toggles / coss switch); 16px grouped-panel radius and 8-10px controls (coss extracted-values); 4px spacing rhythm; system sans; short explicit transform/opacity 150ms ease-out, reduced-motion instant. History uses time-grouped rows, not a wall of identical floating cards. Source/private-processing details use progressive disclosure. Destructive forget has a named scope and explicit confirmation, never generic one-tap trash.

Research URLs: https://developer.apple.com/design/human-interface-guidelines/buttons ; https://developer.apple.com/design/human-interface-guidelines/toggles ; https://developer.apple.com/design/human-interface-guidelines/searching ; https://coss.com/ui/docs/components/switch ; https://coss.com/ui/docs/components/alert-dialog ; https://github.com/zeronsh/zeron/blob/main/ARCHITECTURE.md .

## Next slice

Local-first factual memory over already structured Schoology/work-trail metadata, source controls, pause, history/rollups, bounded lexical recall, deletion fences, evidence in task details, synthetic API and browser acceptance. Rich page capture/native/OCR/typed-text/model behavior remain explicit gates, not fake toggles. All sources default off; local previews use only generic synthetic content.

## Current verification checkpoint — 2026-10-13T06:58:10.826Z

This is an isolated local implementation, not a deployed parity claim. Main remains at 5597694a5474. No live capture, account access, cloud processing, merge, live-service restart or deployment was performed for this slice.

| Requirements | Current implementation and evidence | Remaining gap |
|---|---|---|
| C01–C03 | Default-off consent, actual source gating, disable, timed pause and global pause. context-memory / context-routes tests; synthetic off/paused/control screens. | Live source/runtime comparison unapproved. |
| C04 | Exact domain/subdomain exclusions, exclusion deletion confirmation, saved-event/link removal and replay fences. | Native-app exclusions not implemented; capture permission required. |
| C05–C06 | Day/space/source history, paging and expanded provenance; synthetic phone and desktop screens. | Structured factual evidence only, not captured page/app content. |
| C07 | Private encrypted journal reports on-disk storage and average daily bytes; API tests. | OS/device and live storage behavior not verified. |
| C08–C09 | Scoped explicit forgetting and retention cover facts, links and derived views; no source deletion; clock rollback and replay tests. | Backups/exports/previously shared data are not erased. |
| C10 | Loading, empty, off, paused, protected-storage error/retry and stale views exercised with real modules against synthetic API. | Real Android keyboard and native runtime not tested. |
| C11–C12 | Local deterministic 10-minute/six-hour factual windows and bounded lexical recall. | Labelled substitute, not semantic/model parity. |
| C13–C15 | Encrypted reopen/dedupe, private permissions, corruption/symlink/crash recovery, revision fences and stale response invalidation tested. | Independent security audit unavailable; endpoint compromise remains outside encryption guarantee. |
| C16–C19 | Status authority separate from activity; fresh/stale/unknown evidence; conservative resume tie only; queue completion tied to source. | Live authoritative source journey unapproved. |
| C20 | 393×852 and 320px phone, 1280×900 desktop; no horizontal overflow, reviewed targets >=44px; sampled composited text contrast >=5.16:1; two phone/doc and desktop review passes; cancel/Escape focus tested. | Existing Next phone theme remains light under global dark flag; actual dark mode unmatched. Reduced-motion CSS exists, browser emulation API unavailable; runtime/real-device review outstanding. |
| C21 | Browser cache strips all context, trail and pickup; offline/visibility/lease/stale-response protections covered by frontend tests. | Actual network-offline/device journey not verified; UI-event and synthetic tests only. |
| C22 | UI names local factual processing and encryption limits; no model/network operation in memory/linking modules. | Does not establish privacy of other existing app paths. |
| C23–C27 | No unsupported fake controls, no activation or broad capture implementation. | Page content, native, typed text, OCR, semantic models require exact permission/provider/runtime review. |
| C28 | Real rendered source UI against a synthetic-only API, never fallback to live. | Unmerged, undeployed; live served version and actual reference/native behavior unverified. |
| C29 | Authenticated/unauthenticated helper blocking and source/default-off no-egress tests pass. | Live egress not observed; no guarantee about unrelated helpers. |
| C30 | UI explicitly avoids guarantees about historical processing or erasure. | Provider retention and previously processed data unverified. |

### Owner-controlled document relationship extension

Next can save a confirmed canonical Google Docs/Slides/Sheets/Forms URL for a known, untainted task; it never fetches or reads the document. Source consent and pause are checked before task-source lookup. A document cannot be silently linked to another task; shared-document ambiguity produces no visit inference. Unlink/change removes only the matching document-derived facts, leaves original documents/portal facts/source status intact, and prevents replay. Re-saving the same relationship preserves its history. Links expire and are removed by matching forgetting/exclusions. Task-link data is volatile in the browser, hidden offline/not visible and rejected below deletion revision floors.

### Test and build evidence

- Server: 75 files, 1,357 tests pass, context-reviewed-server-tests.log.
- Frontend: 66 files, 720 tests pass, context-final-web-tests.log.
- Both typechecks and production server/frontend builds pass, context-reviewed-builds.log.
- One first-run TLS fixture failure used a missing OpenSSL distinguished-name configuration. A temporary synthetic OPENSSL_CONF made the unchanged test pass; no live configuration changed.
- Final CSS-only desktop wrapping refinement passes the frontend typecheck, all 720 frontend tests and production build; portable preview starts successfully and health fingerprints the reviewed compiled module.
- Independent visual reviewer failed before review with free-tier 403/insufficient-quota. No replacement provider or paid call was used. No independent ship/security/parity verdict is available; Jev met-veto not applicable because no met verdict was claimed.

### Reproducible synthetic preview

From miniapp: build the server, then run node server/scripts/context-preview.mjs (127.0.0.1:5342). In a separate terminal, run npm exec -w @aside-miniapp/web -- vite --config vite.context-preview.config.ts (127.0.0.1:5341). Open the gallery links to create off/ready/empty/stale/paused/error fixtures. API health reports synthetic:true and the compiled memory-module fingerprint. Unsupported API paths fail closed. This entry is development-only and never proxies the live mobile service.

Overall verdict: unmet. Next safe step is approved independent review / explicit treatment of unmatched UI scope; merge, deployment, source activation and native/provider work remain separately approval-gated.

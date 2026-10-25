# TypeUI foundation adoption, 2026-10-20

## Outcome contract
Apply the publicly inspected TypeUI UI Foundations to the existing Aside phone/PWA and native Jarvis, retaining their palettes, routing and interaction model. The reference is a diagnostic set of bad/good examples, not a replacement theme or a requirement to add decorative animation.

Success: readable role-based type and wrapping; 44px phone targets that do not overlap; visible keyboard focus; semantic status beyond color; stable controls during updates; interruptible existing transitions; unchanged functional behavior; no new dependencies or animation clock. Capture actual components at 393x852 and 320px, light/dark, normal/reduced motion. Run existing regressions and focused tests. A static capture does not establish S24 frame pacing or real-voice correctness.

## Boundaries
- Phone source: miniapp/web. Native Jarvis: ~/Downloads/04-AI-and-Software/Aside-Browser/Hey-Aside/Sources.
- No server, authentication, pairing, networking, permissions, approval decisions, model selection, speech/audio, storage or task execution changes.
- Preserve one thread scroll owner, frame-coalesced streaming and virtualized identities.
- Preserve Jarvis's existing critically damped, velocity-preserving island silhouette and native neutral glass; retain the blue orb.
- Preserve all pre-existing untracked native screenshots, tests and backups.
- Local source changes/build/test only. Installation/restart/publication is separate and must be explicitly authorized.
- Rollback is the pre-change git revision, with no destructive cleanup of pre-existing files.

## Source availability
Inspected public configurator: https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space . Its picker enumerates 118 examples in 24 categories. The 'Download all rules' button redirects to the Creative subscription page in the current browser session. The paid full-rule export is unavailable; do not bypass this gate or describe public example names as the complete exported instructions.

## Product/component/state coverage
| Product | Surface | States | Acceptance |
| --- | --- | --- | --- |
| Phone | Home, mode control, history | empty, populated, narrow, long labels, light/dark | Fixed targets, stable selection and timestamp metrics |
| Phone | Chat, code, live work | streaming, working, finished, error, expanded | Existing scroll/stream ownership retained; no reading-text balancing during streaming |
| Phone | Questions/approvals | choice, custom answer, keyboard, submitting, error, receipt | 44px options/actions, 16px phone input, whole-row hit target; no change to submission logic |
| Phone | Settings, model picker, sheets | open/close, selection, keyboard, reduced motion | Clear hierarchy, wrapping, focus, no load-order regression |
| Jarvis | Island captions | listening partials/revisions, speaking, thinking, idle | Stable text node, no per-word transition/remount during transcript updates |
| Jarvis | Work/notice/approval glances | initial, step update, finish/error, decision | Stable run identity, localized feedback; no whole-sheet check bounce |
| Jarvis | HUD/Deck/cards | empty, working, finished, narrow content | Shared type and control invariants retained; regression checks and renders |

## Design decisions before implementation
- Reuse Paper/Midnight, existing surface tokens, system/Geist fonts and existing 4px spacing family.
- Keep reading text on normal wrapping; use balanced wrapping only for static headings and pretty wrapping only for bounded descriptions, never growing stream text.
- Fix cascaded 38px segmented targets back to the intended 44px size using order-proof selectors.
- Give keyboard focus one high-contrast, geometry-neutral outline across standalone controls.
- Give phone question options/footer actions real 44px targets and custom inputs 16px text; retain desktop density.
- Reserve numeric and copy-feedback slots rather than animating typography or width.
- Use a stable native caption line for high-frequency transcripts; keep existing parent enter/exit but do not recreate speaking text on each update.
- Animate work completion locally, not by applying the check's bouncy spring to the entire sheet.

## Verification receipt
- All 118 public About explanations inspected; per-example decisions and exemptions: [typeui-foundations-audit.md](typeui-foundations-audit.md). The paid export itself remains unavailable; no claim of paid-export parity.
- Source changes are local and uncommitted. Neither live phone assets nor installed Jarvis have been replaced.
- Final typecheck: successful. Final regressions: server 84 files / 1,432 tests; phone 105 files / 954 tests; total 189 files / 2,386 tests, zero failures. New settings-label tests verify one delegated action, no duplicate toggle, unchanged Telegram/read-only markup and accessible selection semantics.
- Isolated production web build successful. Initial referenced JS increased 96 bytes; CSS increased 3792 bytes, measured against the existing served build. This is a size check, not a startup/performance improvement claim.
- Final system.css craft audit: zero FIX, zero WARN.
- Browser geometry: changed mode targets 64x44px in a 52px shell, including production CSS in emitted order on static synthetic real-component DOM. Long question controls at 393px and 320px are at least 44px, have no overlaps and do not overflow horizontally; custom input is 16px. Settings switch labels are 367x82px whole-row activation targets; browser verification confirms one label click/one toggle with synthetic, in-memory settings only.
- Keyboard: mode selection transition is 0s after keyboard activation; pointer input clears that flag and restores the existing .34s thumb transition. Focused custom-input wrapper is a 2px outline plus 2px gap, exactly within the component clip. Sample question/description/progress contrast: 20.75:1 / 7.46:1 / 7.46:1 against the light card, not a whole-product contrast certification.
- Rapid status probe: 28 samples, zero removed anchors, monotonic count, max unchanged-anchor displacement 0px. This bounded synthetic run does not establish real S24 frame pacing.
- Two phone review rounds captured; round one led to phone-only geometry, fixed wrapped-choice marker alignment, focus-gap clearance and a stronger context-specific mode selector after live computed-style inspection exposed a competing old 38px rule.
- Native source: isolated optimized compile and local-identity signing successful. Nine new unit checks cover transcript whitespace/Unicode/partial revisions/windowing and noted live-run identity, but the updated unit binary stalled before main, emitted no test output and was terminated. Metadata includes macOS quarantine; no security flag was removed. Existing installed baseline had 335 unit checks with zero failures.
- Native source review found no material functional regression in the reviewed diff; updated native runtime tests/renders remain blocked and must not be described as verified. No live audio, model, approval or device-control run was performed.
- Known validation limits: Asidewright does not expose media emulation, so forced-colors runtime and OS media-toggle captures are not verified here; existing reduced-motion regression tests and source branches are retained. No actual S24/paired-device test.
- Warnings: Node test localStorage experimental warning; native compiler deprecation/preview Sendable warnings in existing audio/preview code. No new dependencies, server changes or runtime restart.

## Release gate
[blocked] New Jarvis binary execution requires resolving its macOS quarantine/launch approval; do not remove the flag without explicit authorization.

[blocked] Commit, phone asset activation and Jarvis installation/restart require explicit approval for those exact actions. Retain rollback copies, preserve old hashed phone assets for open clients, verify served bundle IDs and computed styles, then restart Jarvis only after its checks succeed. Never push, change permissions, repair unrelated infrastructure or delete existing native untracked files.

## Changed-file inventory for local commit approval
| Product / file | Purpose |
| --- | --- |
| Phone miniapp/web/src/components/ModeSwitch.tsx | Track keyboard versus pointer interaction for instant keyboard selection |
| Phone miniapp/web/src/components/SettingsScreen.tsx | Label activates its existing switch once; selected choice has aria-pressed |
| Phone miniapp/web/src/theme/system.css | Phone-only target geometry, order-proof mode selector, shared focus/wrapping/numeric corrections |
| Phone miniapp/web/src/gallery.tsx | In-memory synthetic settings fixture; no real defaults are saved |
| Phone miniapp/web/test/foundations.test.tsx | Five control identity, input-mode and style-contract regressions |
| Phone miniapp/web/test/foundation-settings.test.tsx | Three label/selection/unchanged-Telegram regressions |
| Phone docs/typeui-foundations.md | Outcome contract, verification limits, release gate and this inventory |
| Phone docs/typeui-foundations-audit.md | All 118 public examples with adoption decisions and exceptions |
| Jarvis Sources/Island.swift | Stable live/speaking caption nodes, bounded display helper and identity-keyed glance unfolding |
| Jarvis Sources/IslandGlance.swift | Noted work retains its underlying run identity |
| Jarvis Sources/IslandWork.swift | Local completion animation and quiet stable-width timer |
| Jarvis Sources/main.swift | Nine focused native regression checks, not yet run successfully |
| Jarvis docs/typeui-foundations.md | Native invariants, compile/review evidence and execution/release blockers |

Only these files belong to this change. Existing native untracked backups, images, demo outputs and tests are not to be staged or deleted. Local commit approval does not authorize any remote push.

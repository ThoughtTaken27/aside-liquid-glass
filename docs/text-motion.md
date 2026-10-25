# Calm text motion, October 20, 2026

## Outcome
Real work reads as live without moving the words or the surrounding layout.
No backend, permissions, model routing, reading-position, voice, or data changes.
No new packages. Independent implementation informed by the free Arc UI demos.

## Coverage and state table

| Surface | Idle / queued | Working | Changed label | Done / failed | Reduced motion |
| --- | --- | --- | --- | --- | --- |
| Phone live footer / work timeline | Existing plain copy | Quiet sweep | 240ms in, 160ms out, 2px maximum | Existing still summary | Plain readable text |
| Phone subagents | Existing plain copy | Same sweep | Existing label data flow, no letter dance | Existing receipt | Plain readable text |
| Phone home / empty title | Existing copy | Not applicable | First appearance only, 440ms + capped 40ms word stagger | No repeat on reading | Immediate text |
| Next helper / research / item sheet | Queued is still | Same sweep only on real work | Current text updates without extra motion | Plain result | Plain readable text |
| Next Mac desk helpers | Queued is still | Same shared sweep | No per-letter morph or width spring | Plain result | Plain readable text |
| Jarvis island / HUD / work glance | Existing voice/transcript behavior | One shared native sweep | 240ms in, 160ms out, max 2pt | Existing receipts unchanged | No sweep or travel |
| Jarvis notice / glance reveal | Existing content | Not applicable | 440ms, 2pt, no blur, capped stagger | Existing content | Immediate text |

## Tokens and design decisions
Inherit every palette/font/spacing/radius. Shimmer adds no visual accessory.
Arc shimmer: 1.8s pass, rest, 240/160ms swaps, in-view and hidden-page guards.
Adaptation: 3.2s cycle with 18% rest at each edge; 50% foreground highlight.
Text uses a solid readable base. Only transform/opacity animate on the web.
No animated gradient position, blur, font size/weight/width, per-letter morph,
or JS frame loop. Offscreen/hidden/reduced-motion work pauses; completed work
stops. Reduced motion and forced colors preserve the unadorned text.

Sources inspected: https://uiarc.dev/components/text-shimmer,
https://uiarc.dev/r/text-shimmer.json, /text-reveal and /text-morph.
No source code from Arc copied; character morph deliberately rejected because
it reflows letters and would overanimate frequently changing statuses.

## Verification criteria
- Stable current text node; outgoing copy absolutely positioned and aria-hidden.
- Rapid updates coalesce, newest text wins, no stacked exits or stale timers.
- Zero unchanged-anchor drift during status swaps and active sweeps.
- Offscreen, document-hidden, reduced-motion and forced-color checks.
- Light/dark phone screenshots at 393x852, narrow 320px and desktop coverage.
- Focused regression tests, full web suite, typecheck, isolated production build.
- Native build/unit tests and static glance captures; do not label a static
  capture as live native animation verification.
- Two visual critique rounds and final diff review.

## Release boundary
Build web assets into isolated scratch output, never web/dist, until release
approval. Phone assets publish dependency-first, retaining previous hashes.
Native build does not install/restart Jarvis. No GitHub push.
Real S24 hardware and live-voice interaction require device-level verification.

## Evidence from the implementation pass
- 946/946 web checks and 325/325 native unit checks passed; web typecheck clean.
- Production QA: matched 3.2s inverse-transform clocks, solid inherited ink,
  no legacy generated ::after sweep, inactive/offscreen clocks paused.
- Real status-button swap: current node identity retained, unchanged anchor
  drift 0px, one outgoing copy maximum, then removed.
- Rapid burst: newest label Done, 0px anchor drift, no stacked copies.
- craft-audit: new text-motion.css 0 FIX / 0 WARN; affect.css 0 FIX / 1 WARN
  for the inherited 10.5px favicon letter tile (graphic, not reading copy).
- Native work/done/HUD static renders produced; live voice/animation and S24
  device-level validation are not established by those captures.

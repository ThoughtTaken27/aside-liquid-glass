# Curated phone controls

The September 30, 2026 pass preserves Aside's existing neutral pearl canvas (#F6F9F8), graphite ink (#202627), semantic orange (#E87D4F), artwork, component hierarchy, fonts, and handlers. Production changes are standalone-scoped CSS only; no packages or registry source were copied.

## Reference decisions

| Reference | Applied | Deliberately rejected |
| --- | --- | --- |
| [Arc button](https://uiarc.dev/components/button), [motion](https://uiarc.dev/docs/motion) | 44px touch targets; 160ms press and 240ms sheet/selection entrance | A second button framework, ResizeObservers per button |
| [Arc sheet](https://uiarc.dev/components/bottom-sheet) | Preserve a drag-driven header and a separately scrolling body | Replacing tested sheet behavior or adding detents in a visual-only pass |
| [Skecher AI chat box](https://skecher-ui.com/docs/ai-chat-box) | Restrained .97 press feedback, stable action slots | Its 32px targets, three-column model grid, extra icon/motion packages |
| [Planes segmented control](https://useplanes.com/components/segmented-control) | One explicit moving selection; no second goo silhouette | Hover-only controls, paid components, fabricated rotating work phases |
| [Space UI](https://www.spaceui.one/docs/installation) | Evaluated, not integrated | Base UI / Tailwind / Motion migration for a polish request; no verified component geometry |
| [Componentry](https://componentry.dev/) | Evaluated, not integrated | Decorative shaders, matrix rain and magnetic pointer effects on a phone |

No purchase, third-party dependency, backend, authentication, model default, sending, dictation, or attachment change.

## Token translation

- Existing palette and font stacks retained; muted control text uses existing `--rf-quiet` at 66% ink, instead of 46-52% ink for placeholders/inactive labels.
- Existing 4px rhythm: 44px actual button boxes; 4px composer row gap; send radius 14px within the existing 24px composer.
- Segmented control: 44px options, 3px inset plus border, 52px shell, 22/26px nested radii, 240ms transform using existing `--rf-ease`.
- Sheet: 240ms entrance, unchanged drag and 200ms exit, 36x4px handle.
- Keyboard focus: graphite 2px outline with 2px offset. Composer input focus stays on its enclosing surface.
- Reduced motion disables new animation/transition and press transform. Existing opaque material fallbacks remain untouched.

## Preview

`npm run dev` in `miniapp/web`, then `/qa-frame.html`.

- `?src=/gallery.html?home` is the interactive generic home fixture.
- `?src=/gallery.html?home%26dark` previews dark mode.
- `?src=/gallery.html?home%26empty` previews no history.
- `width=360&height=780` checks narrow phones; default is 393x852.
- `src=/app` renders the real app through the existing Vite API proxy.

The gallery now imports the same stylesheet stack as the live app. It is development-only and not an entry in the production build.

## Verification

- Baseline web: 568 passed. After six added regression checks: 574 passed; both-workspace typecheck passed.
- Server: 1000 passed, one unchanged OpenSSL fixture failure (missing distinguished_name in sandbox configuration); no backend files changed.
- Two screenshot review rounds; final independent verdict: ship for the changed controls/sheets.
- 393x852 light/dark home, model sheets, question cards, expanded work; 360px web mode/draft preservation; 320x640 long-model stress; empty and streaming states captured.
- Actual model picker -> settings navigation checked without writing preferences.
- Actual control boxes measured 44px; history labels/titles share x=35px; 320/360/393px screens have no horizontal document overflow.
- Screenshot-backed light contrast: inactive Web 4.88:1, composer placeholder 4.80:1, model label 5.95:1. No decorative orange pixels on idle home.
- Browser tool cannot emulate OS media preferences: actual reduced-motion CSS branches were applied as a QA-only stylesheet and computed send/question transitions measured 0s; no OS preference was changed.
- Phone-sized browser verification, not a physical Samsung device session.

# Interactive visual security

Goal: preserve interactive visual cards while preventing untrusted visual HTML
from reaching app credentials/DOM or sending embedded data to an outside origin.

Base: local main 866234d. Do not change the visual design or disable scripts.

Required invariants:
- Untrusted card always has an opaque-origin sandbox (scripts only).
- Card resource loads cannot access arbitrary remote code, images, fonts, APIs.
- Parent frame-src constrains child self-navigation before network dispatch.
- Generated visual response is never executable outside a restrictive trusted
  embedding context; direct navigation must not create an escape route.
- No unauthenticated API can create/upgrade the trusted embedding context.
- Theme/resize messages accept only the intended parent/frame and limited data.
- Local libraries may be supported without allowing remote network requests.

Verification:
- Synthetic positive-control attacker collector proves the test can detect leaks.
- Browser adversarial matrix: location/replace/anchor/meta/redirect/same-origin,
  fetch/XHR/beacon/image/CSS/font/script/WebSocket/prefetch/nested frames/popups,
  top navigation, app cookie/storage/DOM reads, WebRTC and speculative DNS.
- Interactive controls: tabs/expand/sliders/calculator/canvas/WebGL, theme update,
  resizing, production lifecycle and virtualized remount.
- Unit/component tests, typechecks, production build, independent diff review.
- Do not claim device or deployed parity from source/build-only evidence.

Publication remains gated on approved backed-up history cleanup, complete audit
and deployment verification; no claim that testing proves zero vulnerabilities.

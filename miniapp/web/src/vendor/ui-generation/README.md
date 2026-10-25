# transitions.dev UI generation (vendored)

Source: https://github.com/Jakubantalik/transitions.dev, `skills/transitions-ui-generation/`
at commit 9cb3a4a (2026-10-14). License: `LICENSE.txt` (free use inside products;
no redistribution as a competing transitions library).

One local change in `ui-generation.js`: when the target element is `document.body`,
the overlay is appended to `<html>` instead, because the runtime hides its target
while it draws. Aside's phone app plays it on a whole `visual` page inside its
sandboxed frame (see `web/src/utils/visual.ts`), so the target is the body.

Do not retune the timings; they are designed together.

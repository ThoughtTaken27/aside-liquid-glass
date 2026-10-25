# Phone motion and navigation repair

## Outcome
Preserve the Paper/Midnight palette, existing font split and functional glass. Remove flicker, replayed motion and scroll jumps; make Next enter/leave on the left; system Back dismisses the deepest view without leaving the app until the user is at Home.

## Invariants
- No messages sent, sessions deleted, task actions triggered or server settings changed during QA.
- UI state owns the content. History stores only opaque navigation-layer keys; no message/draft content.
- Manual Back, native popstate and Escape share close actions. Manual closes consume history without calling close twice.
- Keyboard dismiss remains native; no edge-swipe handler that competes with Android/iOS navigation.
- At Home, Back can leave normally. No infinite sentinel trap.
- Existing live server remains unchanged until approval to deploy these fixes.

## Motion tokens
Existing drawer curve: cubic-bezier(.32,.72,0,1), from beUI/Ionic as recorded in ui-polish/references/extracted-values.md.
Page 280ms, return 240ms; sheet exit 200ms. Ordinary destinations on the right, Next on the left. Press feedback remains short and touch-safe. No replayed Recents stagger, no per-word blur; streaming fade 160ms with a bounded 48ms chunk stagger. Respect reduced motion.

## Acceptance tests
- Native Back: Next -> Home; item -> Next -> Home; project -> projects -> Today -> Home.
- Model sheet: Reasoning/Permission/More models drilldown -> preceding page -> sheet -> calling page.
- Settings -> Memory -> file Back returns one level at a time. Routines behaves similarly.
- Session panel -> FileViewer -> session; browser deck -> live fullscreen -> deck -> caller.
- Image viewer closes independently; slash menu/search/expanded activity close before the page.
- Fast open/close commits in order, retires frozen View Transition snapshots, has no late reopen.
- Home/Recents and Next tabs restore scroll without first painting the wrong position.
- Recents dark ground is exactly Home's existing canvas (no separate tint, image, blur, border or shadow).
- No blank first-open destination while its lazy chunk resolves.
- Capture 393x852 light/dark, Home/Recents/Next/sheets/thread. Measure geometry and pixels; two critique/correction rounds.
- Existing web regressions, new BackStack and interrupted-transition tests, typechecks, production build, diff check.

## Evidence, round 1
- Old dark history computed background: srgb(.12549,.117647,.105882)/.8 + warm gradient + 20px backdrop blur. Repaired: transparent, no image/blur/shadow.
- Old Home retained 110 animation objects; initial repaired Home retained 8 (working indicators/critter and small control arrivals).
- Browser verification: Next depth 1 -> Home 0; Reasoning 2 -> model 1; Settings/Memory/file 1/2/3 -> 2 -> 1 -> 0.
- Matched baseline Next frame recording: 49 samples, max 51ms, 4 >32ms, 17 frames with no .app destination. Baseline is 9f1b882 in isolated worktree, same live backend.
- Fixed first-open blank caused by React.lazy resolving even a prefetched module inside flushSync; ready destination component is selected before transition.
- Initial full regressions: 618/620; two Escape tests caught stale layer selection during rapid mounts. Corrected to current visible registry; focused image + history 21/21.

## Unverified
Physical Samsung S24 keyboard timing and OS edge gesture animation; cannot claim hardware smoothness from desktop Chrome alone. Browser history path is tested through real history.back(), not only mocks.

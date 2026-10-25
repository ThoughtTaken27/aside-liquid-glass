# Phone notifications

## Outcome
On the existing Android Chrome PWA, opted-in devices receive a system notification when a top-level Aside turn becomes ready, needs input, or fails, even with the PWA closed. Tap opens the correct thread; Android Chrome text actions can submit a reply without opening the PWA, with a recoverable draft/open fallback on platforms without text actions or when network/auth fails.

## Platform boundary
System-owned notification spacing, placement, animation and heads-up behavior are controlled by Android/Chrome and the user's notification settings. This implementation does not claim an Android Live Update/Now Bar or an iOS Dynamic Island. Native Android Live Updates require native integration and eligibility, not PWA CSS. The installed PWA can show its own restrained foreground banner, never a system-wide imitation.

## Invariants
- Explicit per-device opt-in; no permission request on launch. Completion/needs-input enabled, optional progress disabled, summary previews disabled by default.
- One session notification tag; progress updates quiet; final status can alert. Never expose raw tool arguments, reasoning, HTML or attachment paths.
- Use Web Push encryption and stable VAPID keys persisted with owner-only modes. Auth required for subscription, testing, settings, and reply routes. Restrict destinations to recognized HTTPS browser push services, not arbitrary network endpoints.
- Monitor daemon status read-only; no historical completion flood on startup; no subagent/incognito notifications. No extra model calls.
- Replies use normal phone runner, reminder, current session settings and suspension safeguards. No stop/approval actions masquerading as replies; no destructive actions on notification tap.
- Failure keeps the entered reply as a local recoverable draft and opens the correct thread; no automatic retries that could duplicate work.
- Keep Telegram, composer/queue, visuals and service worker fetch/cache behavior intact.

## Verification
Focused server validation/dedupe/payload/transition/auth/reply tests; service-worker push/click/failure tests; browser-client/settings/banner tests; typecheck, full web tests, server tests, production build and diff-check. Clean 393x852 light/dark captures and two polish rounds. Real closed-PWA delivery and inline-reply test requires S24 notification permission and deployed server restart. macOS sandbox cannot restart com.aside.mobile; coordinate one user restart with composer task.

## Sources and design
Chrome: https://web.dev/articles/push-notifications-display-a-notification (inline text actions and system variance).
Claude mobile: https://code.claude.com/docs/en/mobile.md (completion/decision push alerts).
Apple HIG: https://developer.apple.com/design/human-interface-guidelines/live-activities (glanceable state, exact deep link, only essential alerts).
Research on X distinguishes third-party island demos from official Claude features; do not present imitation demos as Claude product evidence.
Inherited app palette/tokens, system sans, 16px banner inset, 20px functional panel radius, 44px touch controls (Zeron extracted reference); 200ms enter /150ms exit cubic-bezier(.22,1,.36,1), 100ms press .97; reduced-motion equivalent fade/static. Android notification geometry is not custom-styled.

## Added phone UX fixes
- Diff additions/deletions now use semantic green/red instead of the shared clay accent. Light: #16803c/#d32746; dark: #68cf8b/#ff8398. Measured small-text contrast on the inherited paper canvas: 4.60:1 / 4.65:1.
- Reopening, resuming, inspecting, or deep-linking to an existing thread never expands Agent view automatically. A conversation explicitly created from the home composer gets one reveal when positively agent-owned tab metadata arrives. Manual hide/show wins over later target changes, and the reveal permission is consumed in the root thread state.
- `active_tab_target_id` is only a ranking hint, never proof of ownership. Agent previews and Browser-sheet owner labels require an owned session_tabs record. Borrowed attachments and inherited current-page pointers are excluded, including the unrelated Reddit counterexample.
- Runtime observation: the inspected daemon DB currently contained borrowed attachment records only. Missing owned-tab evidence fails closed; this observation does not establish what every future CLI/browser turn records. Real new-conversation auto-reveal still requires device/runtime verification.

## Verified Oct 14, 2026
- Both workspace typechecks passed.
- Server: 78 files, 1,405 tests passed. Web: 71 files, 747 tests passed. Total: 2,152.
- Production web and server builds passed; notification-worker source participates in the service-worker build hash.
- Real worker code is exercised for private payloads, exact-thread taps, foreground quiet delivery, cookie-only inline replies, saved-draft failure, and absence of automatic retry.
- Timestamped final-answer evidence covers short Mac turns between scans without mistaking a title/read update for completion or repeating an already-observed final answer.
- Focused client tests cover permission refusal, expired-device reconnection, and preserving explicitly chosen preferences.
- Two phone-size polish passes: shared content insets; inherited 44px switch hit areas; reduced shadow; redundant connected check removed; light/dark and reply-expanded captures. Temporary visual QA pages were removed, and no live task browser tabs were used.
- Full-suite test isolation fixes: shutdown fake queue runners between tests; await actual request dispatch rather than a 10ms sleep; provide a disposable certificate fixture config instead of inheriting the sandbox's OPENSSL_CONF; update an old send mock to the queue receipt schema.
- Disabled Telegram task-alert callbacks now return before facade lookups and completion thumbnail captures; Telegram chat/connection code remains intact.

## External acceptance still blocked
The sandbox cannot kickstart com.aside.mobile or grant Android notification permission. After the combined build, run one service restart, opt in on the installed S24 PWA, test with the PWA closed, tap into the exact thread, try an inline reply, and verify Agent view using a real positively owned browser tab. Android owns system notification presentation; the custom screenshot is the in-app banner, not a system overlay or Live Update.

# Next phone convenience, 2026-10-10

Outcome: a phone user can reject an irrelevant task directly from Today or a list row, undo it, find a task, refresh, add work, and reach every destination without hidden navigation.

Scope: Next phone components and theme, opt-in accessible Sheet close/focus handling, generic fixture and regression tests. Aside usage logo is a separate local dashboard change, using the existing official Aside path. No new autonomous actions, model changes, permissions, or data sources.

Invariants: server remains source of truth; School and Personal stay separate; dismiss/snooze/done use existing endpoints with reopen Undo; helpers start only on explicit taps; private-mail restrictions unchanged; desktop layout unaffected.

Token plan: inherit Paper/Midnight tokens. System sans 34/40 title, 22/28 task title, 16px row text, 14px actions. 4px spacing rhythm, 8px action gaps, 20px shared content edge. 24px focal card, 12px controls. Minimum 44px hits, 50px primary buttons (Zeron/Nexvyn); 2px focus outline/3px offset; .97 press scale. No extra motion; reduced motion/transparency/contrast fallbacks.

Sources: https://github.com/zeronsh/zeron; https://coss.com/ui/docs/components/button; https://developer.apple.com/design/human-interface-guidelines/buttons; https://developer.apple.com/design/human-interface-guidelines/accessibility; https://ui.nexvyn.dev/components/button. Exact prior values reused from account ui-polish extracted-values.md.

Exit criteria:
- Visible Not for me on hero and open list rows; manual tasks use Remove.
- Reject and Later use existing endpoint and offer Undo; source tasks are not deleted externally.
- Search title/context/why across current space, with result count, no-result and clear state.
- Persistent bottom navigation, labeled Add, 44px control targets.
- Task sheet has explicit Close, Tab containment, Escape and focus restoration.
- No horizontal overflow at 393px or larger-text spacing overrides.
- Paper, Midnight, empty, top/mid/bottom and sheet captures; two measured polish rounds.
- Typecheck, web regressions, build, diff check; local merge/deployment only after approval.

Evidence and review: in progress.

Evidence (12:55 PM): 658/658 web tests incl. new test/next-convenience.test.tsx; tsc clean; staged build ok; 0 px overflow at zoom 1.18; no buttons under 36px; quiet action text ~7:1 contrast; Paper + Midnight, top/mid/bottom, empty, search, sheet captured over 4 rounds. Fixed along the way: phone day line said "1 hours of work in all" (now mirrors server), Midnight sheet primary/close colors, serif empty title, late-row side stripe.

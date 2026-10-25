# Next context and security hardening

## Outcome contract

Build a local-only first milestone from main `cac5f3d`, in an isolated checkout. This build does not change the deployed application, capture, credentials, live settings, or the existing Next UI checkout. Separately, the owner approved personal-mail disconnection and deletion of its feed/cache; that live config is disabled, but its old process restart was blocked by OS permissions.

### First milestone

- School-email sweeps and fresh reply-draft reads wait rather than reaching the text model when a required safety check is absent, invalid, failed, or incomplete.
- Recognized sensitive school email is excluded in deterministic code before either classifier or text model. No sensitive content is copied into pending/error telemetry.
- Action-capable Next helpers are unavailable until an architectural last-action approval boundary exists. Existing research and tool-less draft paths stay separate; queued helper requests are preserved rather than automatically executed or deleted.
- Add an opt-in local context projection over structured records already supplied to Next: exact source IDs, checked-at times, freshness, and exact-matched foreground activity. No new capture, document export, free-text memory reads, model calls, storage of page contents, or ranking claims based on guessed completion.
- Personal email requires explicit enabled:true; disconnects are rechecked before scheduled/manual reads, and leftover personal feeds are excluded from Next. A check already in flight is not canceled by a config edit.
- Context is unavailable by default and cannot be enabled by a request body or model output. A future separately approved local policy file chooses sources.

## Invariants

1. Source identity and authority remain explicit. Observed activity never means completed work.
2. Unknown, stale, malformed, or future-dated evidence cannot become fresh evidence or trigger an action.
3. The task list remains the source of truth; the context layer describes existing tasks and does not create or close them.
4. Mail-derived tasks are not linked to the browser work trail. Personal-mail helper/research/draft prohibitions remain unchanged.
5. No new network destination, provider, account permission, package, or live API call is introduced.
6. Safety-unavailable mail remains retryable. Previously unsafe cached classifications are invalidated under a new cache version.
7. No automatic helper starts, session creation, queue deletion, capture enablement, or privilege changes are introduced.
8. Deletion/expiry is respected by recomputing from current inputs, without a second persistent evidence cache.

## Verification

| Requirement | Verifier | Status |
| --- | --- | --- |
| Safety outage makes zero downstream text-model requests | Synthetic sweeper with null, thrown, missing and partial gate | Passed in synthetic tests |
| Sensitive mail reaches neither classifier nor text model | Synthetic code/security/payment messages; spy counts | Passed in synthetic tests |
| Helper cannot start through forged brief or direct route | Pure prompt tests and authenticated server injection with mock runner | Passed in synthetic tests |
| Local context remains off by default | Policy loader and /api/next tests | Passed in synthetic tests |
| Exact linking, expiry, future time and no guessed completion | Pure context fixtures | Passed in synthetic tests |
| No existing regressions or source pollution | Full server/web tests, both type checks, production server compile, diff review | Passed; main checkout unchanged |

## Release blockers and next slices

This milestone is not a certification of the whole application. Existing already-running helper sessions are not canceled by this patch. It blocks new and queued helper starts; adding real final-action approval remains a later architectural change. Deterministic private filters can over-block legitimate notices and do not guarantee detection of every secret. Provider retention/route policy for existing mail classifiers, historical data already sent, native-helper internals, daemon permission reload behavior and live egress require separate review. A local proxy alone does not prove data never leaves the Mac. The safety screen now labels Jev/Space Bunny retention unverified instead of promising no retention. Do not deploy until outgoing data/provider policy and the running-session migration are approved.

After verified first-milestone acceptance: explicit outgoing-data policy, authoritative completion refresh, read-only calendar availability, selected planning preferences, and local-only duration/snooze learning. Every added source needs approval before activation.

Do not merge, commit, deploy, restart services, enable the context policy, change live mail config, cancel running helpers, or contact external systems without the exact approval required by the phone session. Release review must explain that action helpers become unavailable and unchecked school mail waits.

## Final verification

- Full server suite: 72 files, 1,244 tests passed.
- Full frontend suite: 63 files, 674 tests passed.
- Total: 1,918 tests passed.
- Server source/test type check and frontend type check: exit 0.
- Production server TypeScript compile: exit 0, isolated dist only.
- git diff --check: clean.
- Tests used a throwaway HOME, synthetic mail, mocked model/CLI/history routes, and local transport fixtures; no live mail or browser captures were read.
- System LibreSSL needed missing request configuration in the sandbox; the unmodified certificate test passed with the already-installed Homebrew OpenSSL on PATH.
- Reproduced and fixed: missing/failed/partial school gate, malformed probabilities, transformed-text/reply gate coverage, stale done hints after retries, private sweep/draft input, direct/forged helper starts, and context freshness/identity/deletion/consent failures.
- Reviewed final source diff and new files; no packages, UI files, live capture settings, or live context policy changed.
- Commit/merge/deployment remain unperformed pending approval; provider privacy policy and running-helper migration remain release blockers.

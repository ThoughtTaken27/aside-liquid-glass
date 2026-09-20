# Cross-device session sync implementation plan

**Goal:** Keep an open Aside session's model, thinking level, permission, title, and running state synchronized between the desktop daemon and mobile UI, and make mobile changes update the daemon session.

## 1. Pin the contracts with failing tests

- Add StateDb tests for uncached reads and complete model parsing, including `fastMode`.
- Add model-update tests that validate safe facade expressions and preserve the existing session's `fastMode`.
- Add a WebSocket integration test that mutates the daemon-shaped SQLite row and expects a `session_state` event without a transcript write.
- Add web reducer/control tests proving daemon state replaces a stale phone-local model and distinguishes running from stoppable.

## 2. Add the authoritative server state path

- Extend `StateDb` with `readFresh()` and the fields needed for live sync.
- Build one session-state mapper used by REST and WebSocket code.
- Poll the single subscribed SQLite row at a short bounded interval, suppress unchanged frames, and avoid overlapping reads.
- Emit `session_state` immediately on subscribe and whenever authoritative state changes.

## 3. Write model and effort changes through Aside

- Add a narrowly scoped facade helper for `aside.sessions.update`.
- Validate provider/model pairs and thinking levels against the live catalog.
- Add `POST /api/sessions/:id/model`, preserve `fastMode`, invalidate caches, read back the daemon row, and return authoritative state.

## 4. Make the mobile UI session-aware

- Keep local-storage choices only as defaults for new sessions.
- In an existing thread, always render the session model and effort from server state.
- Route thread picker changes through the new endpoint with a temporary optimistic value, then reconcile with server state.
- Apply `session_state` frames directly to `useThread` metadata.
- Show live desktop work immediately. Only expose Stop when this mobile server owns the process and can stop it.

## 5. Verify and deploy locally

- Run focused red/green tests during implementation.
- Run full server and web test suites, typecheck, production build, and configured doctor.
- Restart the existing `com.aside.miniapp` launchd service and verify the live API/WebSocket behavior on port 8790.

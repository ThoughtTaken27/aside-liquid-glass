# Aside Mobile Performance and Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repeated transcript I/O and background polling while preserving the live desktop-turn behavior in the current uncommitted patch.

**Architecture:** Keep liveness inference at the transcript boundary, but cache the parsed tail by file signature so repeated REST and WebSocket checks only pay for `stat`. Index dated session directories once per refresh window, make the session watcher consume appended bytes exactly once, and use visible, completion-scheduled home polling so slow requests cannot overlap.

**Tech Stack:** TypeScript, Node.js filesystem APIs, React, Vitest.

## Global Constraints

- Preserve all existing uncommitted work.
- Add no dependencies.
- Keep the server compatible with Node.js 22.5 or newer.
- Use test-first red-green-refactor cycles for every behavior change.
- Do not change the app's visible design or product behavior.

---

### Task 1: Cache transcript-tail parsing

**Files:**
- Modify: `miniapp/server/src/transcript.ts`
- Modify: `miniapp/server/test/transcript.test.ts`

**Interfaces:**
- Consumes: transcript path, current time, and liveness window.
- Produces: `TranscriptLiveness.isLive(msgFile, opts): boolean`; the existing `transcriptIsLive` function delegates to one bounded shared instance.

- [ ] **Step 1: Write the failing test**

Add a test that creates a fresh unfinished transcript, checks it through a new `TranscriptLiveness`, then corrupts the file contents while restoring the same `size` and `mtimeMs`. The second call must reuse the cached unfinished-tail result. Add a second test proving a changed signature is parsed again and a third proving recency is recalculated on every call even when parsing is cached.

- [ ] **Step 2: Run the focused test and verify red**

Run: `npm test -w @aside-miniapp/server -- transcript.test.ts`

Expected: FAIL because `TranscriptLiveness` is not exported.

- [ ] **Step 3: Implement the bounded cache**

Add a cache entry with literal fields `{ size, mtimeMs, unfinished }`. On each check, perform one `statSync`; reuse `unfinished` only when size and mtime match, and always recalculate the recency window from the supplied clock. Limit the map to 256 paths by deleting the oldest entry on overflow. Keep `transcriptIsLive` as the stable public function.

- [ ] **Step 4: Run the focused test and verify green**

Run: `npm test -w @aside-miniapp/server -- transcript.test.ts`

Expected: all transcript tests pass.

### Task 2: Consume watcher bytes once

**Files:**
- Modify: `miniapp/server/src/watcher.ts`
- Create: `miniapp/server/test/watcher.test.ts`

**Interfaces:**
- Produces: `JsonlFramer.push(chunk: Buffer): string[]` and `JsonlFramer.reset(): void`; `SessionWatcher` feeds only newly appended bytes into it.

- [ ] **Step 1: Write the failing test**

Add literal chunk fixtures that split one JSON record across several pushes. Assert that no line is emitted before the newline, the complete line is emitted exactly once when finished, multiple later lines preserve order, and `reset()` drops an abandoned partial record.

- [ ] **Step 2: Run the focused test and verify red**

Run: `npm test -w @aside-miniapp/server -- watcher.test.ts`

Expected: FAIL because `JsonlFramer` does not exist.

- [ ] **Step 3: Implement incremental framing**

Store partial byte chunks inside `JsonlFramer`. Advance the watcher's byte cursor immediately after each successful read, feed only that new chunk, and parse returned complete lines. Reset the framer when the file truncates or is replaced. Preserve the existing `activity` and `entries` events.

- [ ] **Step 4: Run focused and integration tests**

Run: `npm test -w @aside-miniapp/server -- watcher.test.ts integration.test.ts`

Expected: both files pass, including the half-written-line WebSocket case.

### Task 3: Make home polling visible and non-overlapping

**Files:**
- Create: `miniapp/web/src/utils/polling.ts`
- Create: `miniapp/web/test/polling.test.ts`
- Modify: `miniapp/web/src/App.tsx`

**Interfaces:**
- Produces: `startVisiblePolling(task, intervalMs, documentLike): () => void`.

- [ ] **Step 1: Write the failing test**

Use fake timers and a deferred task. Assert that a second tick cannot start while the first task is pending, hidden documents do not poll, becoming visible refreshes immediately, and cleanup prevents later calls.

- [ ] **Step 2: Run the focused test and verify red**

Run: `npm test -w @aside-miniapp/web -- polling.test.ts`

Expected: FAIL because the polling helper does not exist.

- [ ] **Step 3: Implement and wire the poller**

Schedule the next timeout only after the current promise settles. Cancel the timeout while hidden, run immediately on `visibilitychange` to visible, and remove the listener during cleanup. Replace the `setInterval(loadSessions, 8000)` effect with this helper.

- [ ] **Step 4: Run focused web tests**

Run: `npm test -w @aside-miniapp/web -- polling.test.ts stability.test.tsx`

Expected: both files pass.

### Task 4: Index session directories

**Files:**
- Modify: `miniapp/server/src/sessions.ts`
- Modify: `miniapp/server/test/sessions.test.ts`

**Interfaces:**
- Produces: `SessionDirectoryIndex.resolve(sessionsDir, sessionId): string | null`; the existing `resolveSessionDir` function delegates to one shared index.

- [x] **Step 1: Write and run the failing tests**

Assert that several id lookups trigger one directory read and that a new session appears after the one-second cache window. The focused test must fail because `SessionDirectoryIndex` does not exist.

- [x] **Step 2: Implement and verify the index**

Cache a map of opaque ids to dated directories, reuse it for one second, and re-read only when the root directory changes. Keep at most eight roots. Run `sessions.test.ts` and `stability-api.test.ts`.

### Task 5: Verify the complete app

**Files:**
- Review: every changed file and `git diff --check` output.

- [ ] **Step 1: Run complete verification**

Run: `npm test && npm run typecheck && npm run build`

Expected: all server and web tests pass, both TypeScript projects pass, and both production builds exit 0.

- [ ] **Step 2: Inspect the final diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors, no generated build output tracked, and only the existing Sonnet changes plus this focused performance pass.

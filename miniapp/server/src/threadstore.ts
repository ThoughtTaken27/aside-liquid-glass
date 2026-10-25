/**
 * Thread snapshots and the deltas between them.
 *
 * Round 2 pushed "something changed" over the WebSocket and let the client
 * refetch the whole structured thread through the CLI facade. That is what
 * made a reply land in one lump: the refetch was throttled, it spawned a
 * ~139MB binary, and nothing could be shown until the whole turn's payload
 * came back.
 *
 * Here the server owns the thread instead. Building it is a file read plus
 * a parse -- no process spawn -- so it is cheap enough to redo on every
 * transcript write. What goes over the wire is only the tail that actually
 * changed.
 *
 * The diff is a plain first-divergence scan rather than a keyed merge, and
 * deliberately so: thread items change only at the tail (a step is appended,
 * a pending step gains its result, the last fold gains an answer), so the
 * first index whose serialisation differs is exactly the point from which
 * the client must replace. That is O(n) over small JSON strings and cannot
 * get out of sync with the client the way an id-keyed patch can.
 */
import {
  attachChildren,
  buildThread,
  currentTodos,
  threadStats,
  workSteps,
  type ChildSession,
  type SubagentSpawn,
  type ThreadItem,
  type ThreadStats,
  type WorkStep,
} from './thread.js';
import type { Todo } from './todos.js';
import fs from 'node:fs';
import { readHistory } from './jsonl.js';
import { sessionMsgFile } from './sessions.js';
import { collectSources, type CitationSource } from './sources.js';
import { EMPTY_SNAPSHOT, type SubagentSnapshot } from './subagents.js';

export interface ThreadDelta {
  /** Replace the client's items from this index onward. */
  fromIndex: number;
  items: ThreadItem[];
  /** Total length after applying, so the client can truncate a longer list. */
  length: number;
}

/**
 * First index at which two item lists differ, or the length of the shorter
 * list when one is a prefix of the other.
 */
export function firstDivergence(
  prev: ThreadItem[],
  next: ThreadItem[],
): number {
  const shared = Math.min(prev.length, next.length);
  for (let i = 0; i < shared; i += 1) {
    // `ThreadStore` hands back the same snapshot object while the transcript
    // is unchanged, so on a quiet push every item is identical BY REFERENCE
    // and the comparison below never has to run. That matters: serialising a
    // real thread costs 176ms against a 150ms push throttle, so without this
    // a subscribed client kept the event loop permanently behind.
    if (prev[i] === next[i]) continue;
    if (JSON.stringify(prev[i]) !== JSON.stringify(next[i])) return i;
  }
  return shared;
}

/**
 * Compute what to send, or null when nothing changed.
 *
 * A shrinking list still produces a delta (with an empty tail) so the
 * client truncates rather than keeping orphaned items -- that happens when
 * a running fold's trailing text is promoted to an answer.
 */
export function diffThread(
  prev: ThreadItem[],
  next: ThreadItem[],
): ThreadDelta | null {
  const from = firstDivergence(prev, next);
  if (from === prev.length && from === next.length) return null;
  return { fromIndex: from, items: next.slice(from), length: next.length };
}

/**
 * Everything one pass over a transcript yields: the drawn thread, the token
 * counters behind the context ring and the streaming footer, and the search
 * results any citation in the answers can refer to.
 */
export interface ThreadSnapshot {
  items: ThreadItem[];
  stats: ThreadStats;
  sources: Record<string, CitationSource>;
  /**
   * The session's children, carrying the palette slot of the spawn row
   * each came from -- see `attachChildren`. The panel lists these, and it
   * has to draw the same colour the thread does.
   */
  subagents: ChildSession[];
  /**
   * The agent's task list, replayed from this transcript's `write_todos`
   * calls. Drawn above the composer and in the session panel, not in the
   * transcript, so it travels beside the items rather than among them.
   */
  todos: Todo[];
}

/**
 * Builds thread snapshots from a session's transcript, with a tiny cache so
 * several subscribers on one session share a single parse.
 *
 * The cache key folds in the subagent snapshot as well as the file stamp,
 * because a child session changing state (spawned, finished) changes the
 * thread without touching the parent's transcript.
 */
/**
 * How many sessions' snapshots are retained.
 *
 * This was unbounded, which is the wrong shape for a process meant to run
 * for weeks against a directory that holds 2250 sessions: one entry is a
 * whole parsed thread, and a single real 57MB transcript costs ~180MB of
 * retained heap. Opening a handful of large threads was enough to sit on
 * gigabytes that nothing would ever release. A small LRU is plenty -- the
 * cache exists so several subscribers to ONE session share a parse, not to
 * remember every session ever opened.
 */
const MAX_CACHED_THREADS = 16;

export class ThreadStore {
  private cache = new Map<string, { key: string; snapshot: ThreadSnapshot }>();

  constructor(private readonly statOf: (file: string) => string) {}

  /**
   * The cache key of the snapshot last built for a session: its file stamp,
   * liveness and subagent stamp. Two equal keys mean byte-identical items,
   * which is what lets a socket's first subscribe trust what REST sent.
   */
  keyOf(sessionId: string): string | null {
    return this.cache.get(sessionId)?.key ?? null;
  }

  /** Retained snapshots -- exposed so the bound is testable. */
  get size(): number {
    return this.cache.size;
  }

  build(
    sessionId: string,
    msgFile: string,
    running: boolean,
    subagents: SubagentSnapshot = EMPTY_SNAPSHOT,
  ): ThreadSnapshot {
    const key = `${this.statOf(msgFile)}|${running}|${subagents.stamp}`;
    const hit = this.cache.get(sessionId);
    if (hit && hit.key === key) {
      // Re-insert so the LRU order reflects the read, not just the write.
      this.cache.delete(sessionId);
      this.cache.set(sessionId, hit);
      return hit.snapshot;
    }

    const messages = readHistory(msgFile);
    const items = buildThread(messages, running);
    const snapshot: ThreadSnapshot = {
      items,
      stats: threadStats(messages),
      sources: collectSources(messages),
      subagents: attachChildren(items, subagents.children),
      todos: currentTodos(messages),
    };
    this.cache.delete(sessionId);
    this.cache.set(sessionId, { key, snapshot });
    // Map iteration is insertion-ordered, so the head is least-recently used.
    while (this.cache.size > MAX_CACHED_THREADS) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return snapshot;
  }
}

/**
 * How much of a subagent's timeline travels with its card. The card shows
 * the last few rows and summarises the rest, so the tail plus an honest
 * total is everything it needs.
 */
const CHILD_STEP_TAIL = 12;

export interface ChildSteps {
  childId: string;
  steps: WorkStep[];
  /** Steps the child has taken in total, including the ones not sent. */
  total: number;
  /** Actual child turn usage, never estimated by the view. */
  tokens?: number;
  /** A bounded final-answer preview for the tree's result surface. */
  summary?: string;
  /** Spawn ownership is retained independently of the sliding step tail. */
  spawns?: SubagentSpawn[];
}

/** A parent thread and everything its subagents contribute to it. */
export interface ParentView extends ThreadSnapshot {
  children: ChildSteps[];
  /** ThreadStore key of the parent snapshot; see ThreadStore.keyOf. */
  rev: string | null;
}

/**
 * Build a thread together with its subagents' timelines and sources.
 *
 * The sources merge is not a nicety. When a session delegates research, the
 * searches run in the CHILD, so the parent's own transcript has no source
 * catalog -- yet the parent's answer is the one carrying the `<citation>`
 * tags naming those source ids. Resolving against the parent alone leaves
 * every chip suppressed on exactly the sessions that cite the most. Seen on
 * the owner's own "Aside browser" session, where all 40-odd sources sat in
 * three children.
 *
 * The parent's own entries win a collision, since they are the newest
 * definition the reader actually saw.
 */
export function buildParentView(
  threads: ThreadStore,
  sessionsDir: string,
  sessionId: string,
  msgFile: string,
  running: boolean,
  subagents: SubagentSnapshot,
  childSnapshot?: (parentId: string, active: boolean) => SubagentSnapshot,
): ParentView {
  const snapshot = threads.build(sessionId, msgFile, running, subagents);
  // Read now: building the children below can evict this entry from the
  // cache on a session with many subagents.
  const rev = threads.keyOf(sessionId);
  const children: ChildSteps[] = [];
  const sources = { ...snapshot.sources };

  // Bound fan-out/depth and preserve real ownership; cycles never recurse.
  const visited = new Set<string>([sessionId]);
  const visit = (list: ChildSession[], depth: number) => {
    for (const child of list) {
      if (visited.has(child.id) || visited.size >= 65) continue;
      visited.add(child.id);
      const file = sessionMsgFile(sessionsDir, child.id);
      if (!file || !fs.existsSync(file)) continue;
      const nested = depth < 4 ? childSnapshot?.(child.id, child.running) ?? EMPTY_SNAPSHOT : EMPTY_SNAPSHOT;
      const built = threads.build(child.id, file, child.running, nested);
      for (const [id, source] of Object.entries(built.sources)) if (!sources[id]) sources[id] = source;
      const all = workSteps(built.items);
      const lastAnswer = [...built.items].reverse().find(item => item.kind === 'answer');
      children.push({
        childId: child.id,
        steps: all.slice(-CHILD_STEP_TAIL).map(slimChildStep),
        total: all.length,
        spawns: all.flatMap(step => step.subagent ? [{ ...step.subagent, description: step.subagent.description.slice(0, 200), prompt: step.subagent.prompt.slice(0, 1000) }] : []).slice(0, 64),
        tokens: Math.max(0, built.stats.turnTokens || 0),
        summary: lastAnswer?.kind === 'answer' ? lastAnswer.text.slice(0, 1200) : undefined,
      });
      if (depth < 4) visit(nested.children, depth + 1);
    }
  };
  visit(subagents.children, 0);

  return { ...snapshot, sources: citedSources(snapshot.items, sources), children, rev };
}

/**
 * A subagent card draws a step's icon, label and status, nothing else; the
 * output, diff and screenshots belong to the child's own thread, which the
 * card opens. Sending them made the subagent tails 279KB of a 1MB thread.
 */
export function slimChildStep(step: WorkStep): WorkStep {
  return {
    kind: 'step',
    id: step.id,
    icon: step.icon,
    label: step.label,
    tool: step.tool,
    status: step.status,
    diffstat: null,
    detail: null,
    images: [],
    ...(step.subagent ? { subagent: { ...step.subagent, description: step.subagent.description.slice(0, 200), prompt: step.subagent.prompt.slice(0, 1000) } } : {}),
  };
}

const CITATION_REFS_RE = /refs\s*=\s*(?:\\?"([^"\\]*)\\?"|'([^']*)'|([^\s>/"'\\]+))/g;

/**
 * Only the sources a citation in this thread actually names.
 *
 * The catalog is every search result the session and all of its subagents
 * ever saw, and a research session's ran to 727KB of a 1MB thread payload
 * while its answers cited a handful. Citations only ever appear in thread
 * text (answers and work-fold prose), so scanning the serialised items for
 * `refs=` is exact. A ref the scan cannot place keeps nothing; the chip for
 * it would have resolved to nothing either way.
 */
export function citedSources(
  items: ThreadItem[],
  sources: Record<string, CitationSource>,
): Record<string, CitationSource> {
  if (!Object.keys(sources).length) return sources;
  const memo = citedMemo.get(items);
  if (memo && memo.keys === Object.keys(sources).length) return memo.out;
  const out = scanCited(items, sources);
  citedMemo.set(items, { keys: Object.keys(sources).length, out });
  return out;
}

/** Unchanged threads hand back the same items array; scan it once. */
const citedMemo = new WeakMap<ThreadItem[], { keys: number; out: Record<string, CitationSource> }>();

function scanCited(
  items: ThreadItem[],
  sources: Record<string, CitationSource>,
): Record<string, CitationSource> {
  const text = JSON.stringify(items);
  if (!text.includes('refs')) return {};
  const out: Record<string, CitationSource> = {};
  for (const match of text.matchAll(CITATION_REFS_RE)) {
    const list = match[1] ?? match[2] ?? match[3] ?? '';
    for (const raw of list.split(',')) {
      const id = raw.trim();
      if (id && sources[id]) out[id] = sources[id];
    }
  }
  return out;
}

/** Default cache key: the transcript's size and mtime. */
export function fileStamp(
  file: string,
  statSync: (p: string) => { size: number; mtimeMs: number } | undefined,
): string {
  const stat = statSync(file);
  return stat ? `${stat.size}:${stat.mtimeMs}` : 'missing';
}

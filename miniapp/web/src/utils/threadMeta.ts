import type { ThreadModel } from '../types';

/**
 * What a chat's header and composer last showed, kept across launches.
 *
 * Opening a chat used to paint "Conversation" and the phone's default model
 * for the length of the fetch, then swap both for the real ones while the
 * page was still sliding in: a title that changes under the eye, and a
 * model pill that changes width. The last known values are good enough to
 * draw the first frame with; the fetch then confirms them (usually with no
 * change at all) or corrects them.
 *
 * Small and bounded: a few strings per chat, newest 200 chats.
 */
export interface ThreadMeta {
  title?: string;
  model?: ThreadModel | null;
  permissionMode?: string | null;
}

const KEY = 'aside.threadMeta.v1';
const LIMIT = 200;

let memory: Map<string, ThreadMeta> | null = null;

function load(): Map<string, ThreadMeta> {
  if (memory) return memory;
  memory = new Map();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as [string, ThreadMeta][];
      if (Array.isArray(parsed)) for (const [id, meta] of parsed) memory.set(id, meta);
    }
  } catch {
    /* a corrupt or unavailable store only costs the seed */
  }
  return memory;
}

export function readThreadMeta(id: string): ThreadMeta | undefined {
  return load().get(id);
}

export function writeThreadMeta(id: string, meta: ThreadMeta): void {
  const map = load();
  const before = map.get(id);
  if (before && JSON.stringify(before) === JSON.stringify(meta)) return;
  map.delete(id);
  map.set(id, meta);
  while (map.size > LIMIT) map.delete(map.keys().next().value as string);
  try {
    localStorage.setItem(KEY, JSON.stringify([...map]));
  } catch {
    /* quota or private mode: the in-memory copy still serves this launch */
  }
}

/** Test seam. */
export function resetThreadMetaForTests(): void {
  memory = null;
}

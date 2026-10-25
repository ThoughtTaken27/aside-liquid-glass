/**
 * "This server ran that turn, and it is over."
 *
 * `transcriptIsLive` decides whether a session is working by looking at how
 * recently its transcript was written, inside a 30-second window. That
 * heuristic exists for turns started in Aside on the Mac, which this server
 * has no other way to see, and for those it is right.
 *
 * For a turn this server ran itself it is wrong, and visibly so. The child
 * exits, `runner.isBusy` goes false, and the transcript's mtime keeps the
 * session reading as "running" for the next thirty seconds. On the phone
 * that means the composer holds the stop control for half a minute after
 * the answer has finished printing -- and, since the turn is no longer
 * stoppable, holds it in the greyed-out state whose explanation says the
 * turn belongs to the Mac. It never did.
 *
 * The fix is not to widen or narrow the window. It is to notice that we
 * have better information than the heuristic in exactly one case:
 *
 *   We watched our own child exit, AND nothing has written to the
 *   transcript since. Therefore nothing is running.
 *
 * Comparing mtimes rather than elapsed time is what keeps this safe. If the
 * user finishes a turn on the phone and immediately continues the same
 * session on the Mac, the daemon's very first write moves the file past the
 * mark we recorded, the suppression stops applying on that same tick, and
 * the session goes back to reading as live. There is no window during which
 * a genuinely running turn is hidden.
 */
import fs from 'node:fs';

/** Bounded: keyed by session id, and there are thousands on disk. */
const MAX_ENTRIES = 256;

export class OwnedTurns {
  /** Transcript mtime at the moment this server's own turn ended. */
  private readonly finished = new Map<string, number>();

  constructor(private readonly statMtime: (file: string) => number | null = defaultMtime) {}

  /** Record that our child for `sessionId` has exited. */
  markFinished(sessionId: string, msgFile: string | null): void {
    if (!msgFile) return;
    const mtime = this.statMtime(msgFile);
    if (mtime === null) return;
    this.finished.delete(sessionId);
    this.finished.set(sessionId, mtime);
    while (this.finished.size > MAX_ENTRIES) {
      const oldest = this.finished.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.finished.delete(oldest);
    }
  }

  /** Our turn is running again, so the old mark says nothing useful. */
  markStarted(sessionId: string): void {
    this.finished.delete(sessionId);
  }

  /**
   * True when the recent transcript activity is only the tail of a turn we
   * already know has ended, and therefore must NOT be read as liveness.
   */
  settled(sessionId: string, msgFile: string | null): boolean {
    const mark = this.finished.get(sessionId);
    if (mark === undefined || !msgFile) return false;
    const mtime = this.statMtime(msgFile);
    if (mtime === null) return false;
    if (mtime > mark) {
      // Something else has written since. Whatever it is, it is not ours,
      // and the transcript heuristic is the right answer again.
      this.finished.delete(sessionId);
      return false;
    }
    return true;
  }
}

function defaultMtime(file: string): number | null {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return stat?.isFile() ? stat.mtimeMs : null;
}

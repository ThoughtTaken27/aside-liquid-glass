/**
 * Who is actually looking at a session right now, from the WebSocket's own
 * point of view.
 *
 * A push notification while the mini app is open and subscribed to that
 * exact thread is the textbook definition of notification fatigue (Day 2
 * plan, 6.6). The WS already knows this for free: `subscribe`/`unsubscribe`
 * on ws.ts is the same moment a client starts or stops actively viewing a
 * thread. This is a reference count rather than a boolean because a
 * reconnect can briefly hold two sockets on the same session (old one not
 * yet closed, new one already subscribed).
 */
export class ActiveViewers {
  private counts = new Map<string, number>();

  enter(sessionId: string): void {
    this.counts.set(sessionId, (this.counts.get(sessionId) || 0) + 1);
  }

  leave(sessionId: string): void {
    const next = (this.counts.get(sessionId) || 0) - 1;
    if (next <= 0) this.counts.delete(sessionId);
    else this.counts.set(sessionId, next);
  }

  isActive(sessionId: string): boolean {
    return (this.counts.get(sessionId) || 0) > 0;
  }
}

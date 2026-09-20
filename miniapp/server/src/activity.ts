/** Only this sanitized shape may leave the server. No reasoning or tool args. */
export interface LiveActivity {
  phase: 'thinking' | 'writing' | null;
  tools: string[];
  /** The agent-authored purpose title for one active tool, never its args. */
  summary: string | null;
}
export const NO_ACTIVITY: LiveActivity = { phase: null, tools: [], summary: null };

/** Consume the official CLI's raw-event pipe, never its human-readable stdout. */
export class ActivityReader {
  private partial = '';
  private dropping = false;
  private phase: LiveActivity['phase'] = null;
  private tools = new Map<string, { name: string; title: string | null }>();
  /**
   * A turn purpose, not a tool spinner label.
   *
   * Aside keeps this sentence through tool end, later thinking, and text
   * generation; it changes only when the agent supplies a newer purpose.
   */
  private latestSummary: string | null = null;
  private last = '';
  constructor(private readonly emit: (activity: LiveActivity) => void) {}

  feed(chunk: string): void {
    // Events include provisional message snapshots. Bound memory, fail closed
    // on malformed/oversize frames, and recover at the next newline.
    for (const piece of chunk.split(/(?<=\n)/)) {
      if (!this.dropping) this.partial += piece;
      if (this.partial.length > 8 * 1024 * 1024) {
        this.partial = '';
        this.dropping = true;
        this.pause();
      }
      if (!piece.endsWith('\n')) continue;
      if (!this.dropping) {
        try { this.accept(JSON.parse(this.partial)); } catch { this.pause(); }
      }
      this.partial = '';
      this.dropping = false;
    }
  }

  private accept(event: Record<string, any>): void {
    switch (event.type) {
      case 'agent_start':
        this.reset(); return;
      case 'agent_end':
        // Keep the last purpose until turn_finished removes the whole row.
        // Clearing it here created one final frame of generic “Working…”.
        this.pause(); return;
      case 'message_update': {
        const type = event.assistantMessageEvent?.type;
        if (type === 'thinking_start' || type === 'thinking_delta') this.phase = 'thinking';
        else if (type === 'text_start' || type === 'text_delta') this.phase = 'writing';
        else if (type === 'thinking_end' || type === 'text_end' || type === 'done' || type === 'error') this.phase = null;
        break;
      }
      case 'message_end':
        if (event.message?.role === 'assistant') this.phase = null;
        break;
      case 'tool_execution_start':
        this.phase = null;
        if (typeof event.toolCallId === 'string' && typeof event.toolName === 'string') {
          // Forward only the short UI purpose title. Commands, paths, other
          // arguments, output, and thinking deltas never enter LiveActivity.
          const rawTitle = typeof event.args?.title === 'string'
            ? event.args.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
            : '';
          const title = rawTitle ? rawTitle.slice(0, 140) : null;
          this.tools.set(event.toolCallId.slice(0, 256), {
            name: event.toolName.split('.').pop()!.slice(0, 100),
            title,
          });
          if (title) this.latestSummary = title;
        }
        break;
      case 'tool_execution_end':
        if (typeof event.toolCallId === 'string') this.tools.delete(event.toolCallId.slice(0, 256));
        break;
      default: return;
    }
    this.publish();
  }

  /** Lose live phase/tool certainty without throwing away a safe purpose. */
  pause(): void {
    this.phase = null;
    this.tools.clear();
    this.publish();
  }

  /** A genuinely new run is the only point that retires the old purpose. */
  reset(): void {
    this.phase = null;
    this.tools.clear();
    this.latestSummary = null;
    this.publish();
  }

  private publish(): void {
    const active = [...this.tools.values()];
    const activity: LiveActivity = {
      phase: this.phase,
      tools: active.map(tool => tool.name),
      summary: this.latestSummary,
    };
    const encoded = JSON.stringify(activity);
    if (encoded === this.last) return;
    this.last = encoded;
    this.emit(activity);
  }
}

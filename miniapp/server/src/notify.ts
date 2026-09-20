/**
 * Outbound-only Telegram notifications, for the moments the owner is not
 * looking: a session finishing, erroring, sitting on a question, or a turn
 * that has been running a while.
 *
 * Deliberately outbound only. `bridge.py` owns the single `getUpdates`
 * poller (see the Day 2 plan, 4.2) -- a second poller on the same bot
 * token would steal that one's updates. This module only ever calls
 * `sendMessage` / `editMessageText`, which are stateless and carry no
 * polling conflict.
 *
 * Every notification carries FULL CONTEXT (session title, the actual
 * question or a one-line summary, elapsed time, a deep link back into the
 * thread) rather than a bare "approval needed" ping -- thin approval
 * notifications were the number-two complaint across the competitive
 * research this plan is based on.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { QuestionBlock } from './questions.js';
import type { ErrorAlert } from './errors.js';

export interface NotifySession {
  id: string;
  title: string;
}

interface NotifyRecord {
  /**
   * The message id of the notification live for the CURRENT turn. A
   * long-running heads-up and the finished/blocked notice that follows it
   * are the SAME Telegram message, edited in place -- see 6.6's coalescing
   * rule. A new turn always gets a new message; see `beginTurn`.
   */
  messageId?: number;
  /** `turn_started`'s own timestamp, so a stale timer from a previous turn can never fire the long-running notice for a NEW one. */
  turnStartedAt?: number;
  /** Set to `turnStartedAt` once the long-running notice has fired for it, so it never fires twice for the same turn. */
  longRunningSentForTurn?: number;
  /** Epoch ms; notifications for this session are suppressed until then. */
  mutedUntil?: number;
  /**
   * True from the moment a soft-marker question is found pending at the
   * tail of a finished turn, until the NEXT turn starts (a fresh
   * `turn_started` always means the old question is no longer the live
   * state, whether because it was answered or because something else
   * moved the session on). Read by the session list route to sort
   * "waiting" sessions to the top -- see plan 6.4.
   */
  blockedOnQuestion?: boolean;
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Same atomic-write shape as bridge.py's own `save_json`: tmp file, then
 * rename.
 *
 * 0600 on the temp file, which is the one that matters: `rename` keeps the
 * mode of the file being renamed, so writing the temp world-readable and
 * fixing it afterwards would leave a window where it was not. This file
 * holds chat ids, message ids and session titles.
 */
function saveJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Telegram's inline callback data is capped at 64 bytes; session ids are 16 chars, so this always fits. */
function stopKeyboard(sessionId: string): Record<string, unknown> {
  return { inline_keyboard: [[{ text: 'Stop', callback_data: `stop:${sessionId}` }]] };
}

function questionKeyboard(
  sessionId: string,
  questionId: string,
  options: QuestionBlock['options'],
): Record<string, unknown> | undefined {
  if (!options.length) return undefined;
  // One row, capped at 6 -- a wider question still renders (the reply-in-
  // your-own-words path in the mini app covers anything more), but a push
  // notification's own keyboard is not the place for a wall of buttons.
  const row = options.slice(0, 6).map((option, index) => ({
    text: option.label.slice(0, 32),
    callback_data: `q:${sessionId}:${questionId}:${index}`,
  }));
  return { inline_keyboard: [row] };
}

export interface NotifierOptions {
  botToken: string;
  /**
   * False in standalone mode (no Telegram configured). Every outbound call
   * short-circuits; the rest of the class -- mute state, dedupe, viewer
   * accounting -- behaves identically, so nothing downstream needs to know
   * whether a push actually went anywhere.
   */
  enabled?: boolean;
  chatId: number;
  /** Directory to keep `notify-state.json` in; typically `config.miniapp.stateDir`. */
  stateDir: string;
  /**
   * `<bot_username>/<mini_app_short_name>` as registered in BotFather, for
   * building `t.me/...?startapp=session_<id>` deep links (Day 2 plan,
   * 6.5). Notifications simply omit the link when this is not configured
   * -- a push with full text context and no link is still useful, and
   * guessing at an unconfigured bot/app name would produce a dead link,
   * which is worse than none.
   */
  deepLinkBase?: string | null;
  /** True while the mini app is open and subscribed to this exact session -- see viewers.ts. */
  isBeingViewed: (sessionId: string) => boolean;
  /** Injectable for tests; defaults to a real call against api.telegram.org. */
  call?: (method: string, params: Record<string, unknown>) => Promise<any>;
  now?: () => number;
  /** Swallow-and-log rather than throw; defaults to a no-op. */
  onError?: (context: string, err: unknown) => void;
}

const LONG_RUNNING_THRESHOLD_MS = 60_000;

export class Notifier {
  private state: Record<string, NotifyRecord> = {};
  private readonly stateFile: string;
  private readonly now: () => number;

  constructor(private opts: NotifierOptions) {
    this.stateFile = path.join(opts.stateDir, 'notify-state.json');
    this.state = loadJson(this.stateFile, {});
    this.now = opts.now ?? Date.now;
  }

  private persist(): void {
    try {
      saveJsonAtomic(this.stateFile, this.state);
    } catch (err) {
      this.opts.onError?.('notify:persist', err);
    }
  }

  private record(sessionId: string): NotifyRecord {
    let existing = this.state[sessionId];
    if (!existing) {
      existing = {};
      this.state[sessionId] = existing;
    }
    return existing;
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    if (this.opts.call) return this.opts.call(method, params);
    if (this.opts.enabled === false) return null;
    const res = await fetch(
      `https://api.telegram.org/bot${this.opts.botToken}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      },
    );
    return res.json().catch(() => null);
  }

  // --- mute --------------------------------------------------------------

  isMuted(sessionId: string): boolean {
    const until = this.state[sessionId]?.mutedUntil;
    return Boolean(until && until > this.now());
  }

  mute(sessionId: string, forMs: number): void {
    this.record(sessionId).mutedUntil = this.now() + forMs;
    this.persist();
  }

  unmute(sessionId: string): void {
    delete this.record(sessionId).mutedUntil;
    this.persist();
  }

  // --- turn lifecycle ------------------------------------------------------

  /**
   * A new turn owns a fresh Telegram message -- it must never inherit and
   * silently overwrite whatever the PREVIOUS turn's finished/error message
   * said, which is what would happen if `messageId` were left set.
   */
  beginTurn(sessionId: string, startedAt: number): void {
    const record = this.record(sessionId);
    record.messageId = undefined;
    record.turnStartedAt = startedAt;
    record.longRunningSentForTurn = undefined;
    record.blockedOnQuestion = false;
    this.persist();
  }

  /**
   * Track "waiting on you" separately from whether a PUSH was actually
   * sent for it -- a muted or foregrounded session is still genuinely
   * waiting, it just did not interrupt anyone about it.
   */
  setWaiting(sessionId: string, waiting: boolean): void {
    this.record(sessionId).blockedOnQuestion = waiting;
    this.persist();
  }

  isWaiting(sessionId: string): boolean {
    return Boolean(this.state[sessionId]?.blockedOnQuestion);
  }

  private deepLink(sessionId: string): string | null {
    return this.opts.deepLinkBase
      ? `https://t.me/${this.opts.deepLinkBase}?startapp=session_${sessionId}`
      : null;
  }

  private shouldSkip(sessionId: string): boolean {
    return this.isMuted(sessionId) || this.opts.isBeingViewed(sessionId);
  }

  private async sendOrEdit(
    sessionId: string,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<void> {
    const record = this.record(sessionId);
    const params: Record<string, unknown> = {
      chat_id: this.opts.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (replyMarkup) params.reply_markup = replyMarkup;
    try {
      if (record.messageId) {
        await this.call('editMessageText', {
          ...params,
          message_id: record.messageId,
        });
        return;
      }
      const res = await this.call('sendMessage', params);
      const messageId = res?.result?.message_id;
      if (typeof messageId === 'number') {
        record.messageId = messageId;
        this.persist();
      }
    } catch (err) {
      // Best-effort: a dropped push is recoverable, the mini app (and the
      // desktop sidepanel) remain the source of truth regardless.
      this.opts.onError?.('notify:sendOrEdit', err);
    }
  }

  // --- the four notifications -------------------------------------------

  async notifyLongRunning(
    session: NotifySession,
    elapsedMs: number,
  ): Promise<void> {
    if (this.shouldSkip(session.id)) return;
    const record = this.record(session.id);
    if (
      record.turnStartedAt !== undefined &&
      record.longRunningSentForTurn === record.turnStartedAt
    ) {
      return; // already sent for this exact turn
    }
    record.longRunningSentForTurn = record.turnStartedAt;
    this.persist();
    const link = this.deepLink(session.id);
    const seconds = Math.round(elapsedMs / 1000);
    const lines = [
      `⏳ <b>${escapeHtml(session.title)}</b> is still running (${seconds}s)`,
    ];
    if (link) lines.push(link);
    await this.sendOrEdit(session.id, lines.join('\n'), stopKeyboard(session.id));
  }

  async notifyBlocked(
    session: NotifySession,
    question: QuestionBlock,
    questionId: string,
  ): Promise<void> {
    if (this.shouldSkip(session.id)) return;
    const link = this.deepLink(session.id);
    const lines = [
      `❓ <b>${escapeHtml(session.title)}</b> is waiting on you`,
      '',
      escapeHtml(
        question.header
          ? `${question.header}: ${question.question}`
          : question.question,
      ),
    ];
    if (link) lines.push('', link);
    await this.sendOrEdit(
      session.id,
      lines.join('\n'),
      questionKeyboard(session.id, questionId, question.options),
    );
  }

  async notifyFinished(session: NotifySession, summary: string): Promise<void> {
    if (this.shouldSkip(session.id)) return;
    const link = this.deepLink(session.id);
    const lines = [`✅ <b>${escapeHtml(session.title)}</b> finished`];
    if (summary) lines.push(escapeHtml(summary));
    if (link) lines.push(link);
    await this.sendOrEdit(session.id, lines.join('\n'));
  }

  /**
   * The Day 3 headline, plan 7.5: if a turn touched the browser, the
   * completion push carries visual proof of what happened, not just text.
   * A fresh `sendPhoto` message rather than an edit onto the tracked text
   * message -- Telegram cannot turn a text message into a photo one via
   * `editMessageText`, and the turn is already over, so there is nothing
   * further to coalesce onto it anyway.
   */
  async notifyFinishedWithPhoto(
    session: NotifySession,
    summary: string,
    photoWebpBase64: string,
  ): Promise<void> {
    if (this.shouldSkip(session.id)) return;
    const link = this.deepLink(session.id);
    const lines = [`✅ <b>${escapeHtml(session.title)}</b> finished`];
    if (summary) lines.push(escapeHtml(summary));
    if (link) lines.push(link);
    try {
      const form = new FormData();
      form.append('chat_id', String(this.opts.chatId));
      form.append('caption', lines.join('\n'));
      form.append('parse_mode', 'HTML');
      form.append(
        'photo',
        new Blob([Buffer.from(photoWebpBase64, 'base64')], {
          type: 'image/webp',
        }),
        'capture.webp',
      );
      if (this.opts.call) {
        // Test injection point: callers that supply `call` get a plain
        // JSON-shaped invocation instead of a real multipart POST, since
        // constructing a `FormData` body is not meaningfully testable
        // through a JSON-based stub anyway.
        await this.opts.call('sendPhoto', {
          chat_id: this.opts.chatId,
          caption: lines.join('\n'),
        });
        return;
      }
      if (this.opts.enabled === false) return;
      await fetch(
        `https://api.telegram.org/bot${this.opts.botToken}/sendPhoto`,
        { method: 'POST', body: form },
      );
    } catch (err) {
      this.opts.onError?.('notify:notifyFinishedWithPhoto', err);
      // Fall back to the plain text notice rather than losing the push
      // entirely because the image failed to send.
      await this.notifyFinished(session, summary);
    }
  }

  async notifyError(session: NotifySession, alert: ErrorAlert): Promise<void> {
    if (this.shouldSkip(session.id)) return;
    const link = this.deepLink(session.id);
    const lines = [
      `⚠️ <b>${escapeHtml(session.title)}</b> hit an error`,
      escapeHtml(alert.description || alert.title),
    ];
    if (link) lines.push(link);
    await this.sendOrEdit(session.id, lines.join('\n'));
  }

  /**
   * Rewrite a still-open notification to show the choice that was just
   * made from the notification shade itself (plan 6.2). A no-op when there
   * is no tracked message for this session -- nothing to rewrite, and
   * never worth surfacing as an error.
   */
  async resolveInPlace(sessionId: string, resolvedText: string): Promise<void> {
    const record = this.state[sessionId];
    if (!record?.messageId) return;
    try {
      await this.call('editMessageText', {
        chat_id: this.opts.chatId,
        message_id: record.messageId,
        /*
         * Escaped, because this is `parse_mode: 'HTML'` and the text is not
         * ours. Callers pass a question header and the option that was
         * tapped, both of which come from model output. An unbalanced `<`
         * in either one makes Telegram reject the edit outright, so the
         * message stays stuck showing buttons for a question that has
         * already been answered.
         */
        text: escapeHtml(resolvedText),
        parse_mode: 'HTML',
      });
    } catch (err) {
      this.opts.onError?.('notify:resolveInPlace', err);
    }
  }
}

export { LONG_RUNNING_THRESHOLD_MS };

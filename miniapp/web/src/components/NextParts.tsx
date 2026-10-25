/**
 * The context-aware parts of Next: the brief sheet shown before any agent
 * starts, the live row for work Aside is doing, and the work-trail lines.
 *
 * Nothing here decides what an agent may do. The brief is written by the
 * server's code (brief.ts) and the start button sends only the task id.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, FileText, Minus, Presentation, ShieldAlert, ShieldCheck, Sheet as SheetGlyph, Square, X } from 'lucide-react';
import { api } from '../api';
import { Sheet } from './Sheet';
import { Spinner } from './Icons';
import { LiveFullscreen, useLiveStream } from './LiveBrowser';
import { hostname } from './TabDeck';
import { stamp } from '../utils/nextFormat';
import type { NextItem, NextLink, NextNotice, NextTrail } from '../types';
import { openUrl } from '../utils/openUrl';

// --------------------------------------------------------------------------
// Brief sheet

export function BriefSheet({
  item,
  busy,
  onStart,
  onClose,
}: {
  item: NextItem;
  busy: boolean;
  onStart: () => void;
  onClose: () => void;
}) {
  const b = item.brief;
  return (
    <Sheet side="bottom" title={b.headline} subtitle={item.title} onClose={onClose}>
      <div className="next-brief">
        {b.note ? <p className="next-brief-note">{b.note}</p> : null}
        {b.will.length ? (
          <section className="next-brief-block" aria-label="Aside will">
            <h3 className="next-brief-label">It will</h3>
            <ul className="next-brief-list">
              {b.will.map((w) => (
                <li key={w}>
                  <Check size={15} strokeWidth={2} aria-hidden />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {b.wont.length ? (
          <section className="next-brief-block" aria-label="Aside won't">
            <h3 className="next-brief-label">It won't</h3>
            <ul className="next-brief-list is-wont">
              {b.wont.map((w) => (
                <li key={w}>
                  <Minus size={15} strokeWidth={2} aria-hidden />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {b.stopsAt ? (
          <p className="next-brief-stop">
            <span>Stops at</span> {b.stopsAt}
          </p>
        ) : null}
        {b.mode === 'agent' ? (
          <>
            <button type="button" className="next-primary next-brief-go" onClick={onStart} disabled={busy}>
              {busy ? <Spinner size={16} /> : null}
              {busy ? 'Starting' : 'Start'}
            </button>
            <p className="next-brief-fine">
              Runs on your Mac. Watch or stop it from here.
            </p>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

// --------------------------------------------------------------------------
// Trail

export function trailWhen(t: NextTrail, now: Date): string {
  return stamp(new Date(t.lastAt), now);
}

function TrailGlyph({ kind }: { kind: string }) {
  if (kind === 'Slides') return <Presentation size={16} strokeWidth={1.75} aria-hidden />;
  if (kind === 'Sheet') return <SheetGlyph size={16} strokeWidth={1.75} aria-hidden />;
  return <FileText size={16} strokeWidth={1.75} aria-hidden />;
}

/** The hero's "you already started this" line. */
export function TrailLine({ trail, now, onOpen }: { trail: NextTrail; now: Date; onOpen: () => void }) {
  const opened = trail.kind === 'Schoology';
  return (
    <button type="button" className="next-trail" onClick={onOpen}>
      <span className="next-trail-text">
        {opened
          ? `You opened it ${relWhen(trail, now)}`
          : `${trail.minutes} min in ${trail.title}, ${relWhen(trail, now)}`}
      </span>
      {opened ? null : <span className="next-trail-go">Resume</span>}
    </button>
  );
}

function relWhen(t: NextTrail, now: Date): string {
  const at = new Date(t.lastAt);
  const mins = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const s = stamp(at, now);
  return /^\d/.test(s) ? `at ${s}` : s;
}

export function PickUpRow({ trail, now, onOpen }: { trail: NextTrail; now: Date; onOpen: () => void }) {
  return (
    <button type="button" className="settings-row surface-row next-row next-pickup" onClick={onOpen}>
      <span className="next-lead next-pickup-glyph" aria-hidden>
        <TrailGlyph kind={trail.kind} />
      </span>
      <span className="next-row-body is-static">
        <span className="settings-row-title">{trail.title}</span>
        <span className="settings-row-description surface-meta">
          {trail.kind === 'Doc' ? 'Google Doc' : trail.kind === 'Slides' ? 'Google Slides' : trail.kind}, last opened{' '}
          {relWhen(trail, now)}
        </span>
      </span>
      <span className="next-est">{trail.minutes} min</span>
    </button>
  );
}

// --------------------------------------------------------------------------
// Aside rows

function elapsed(fromISO: string | null, now: Date): string {
  if (!fromISO) return '';
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(fromISO)) / 1000));
  if (s < 60) return 'just started';
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A live thumbnail of the agent's own tab. Streams only while on screen. */
function AsideThumb({ sessionId, busy, step }: { sessionId: string; busy: boolean; step: string | null }) {
  const [full, setFull] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const ref = useRef<HTMLButtonElement | null>(null);
  const { meta, frame, badge } = useLiveStream({ sessionId }, onScreen || full, full ? 'full' : 'card');

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((e) => setOnScreen(e.some((x) => x.isIntersecting)), { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const tab = meta?.tab ?? null;
  const title = tab ? tab.title || hostname(tab.url) : '';
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="next-thumb"
        onClick={() => setFull(true)}
        aria-label={`Watch Aside's tab${title ? `: ${title}` : ''}`}
      >
        {frame ? <img src={frame.url} alt="" draggable={false} /> : <span className="next-thumb-wait" />}
      </button>
      {full && tab ? (
        <LiveFullscreen
          title={title}
          host={hostname(tab.url)}
          who="Aside"
          favicon={tab.faviconUrl}
          frame={frame}
          badge={badge}
          onClose={() => setFull(false)}
          note={busy ? (step ?? 'Aside is working in this tab.') : 'Aside has finished in this tab.'}
        />
      ) : null}
    </>
  );
}

/**
 * One piece of work Aside is doing: the agent's own purpose line (never
 * tool arguments), how long it has been at it, a live view of its tab,
 * and Stop.
 */
export function AsideRow({
  item,
  now,
  waiting,
  onOpenThread,
  onStop,
  onDone,
}: {
  item: NextItem;
  now: Date;
  waiting: boolean;
  onOpenThread: () => void;
  onStop: () => void;
  onDone: () => void;
}) {
  const live = item.live ?? null;
  const busy = Boolean(live?.busy);
  const said = !busy && live?.result ? live.result.replace(/\s+/g, ' ').slice(0, 140) : null;
  const status = waiting ? 'Needs your answer' : busy ? live?.step || 'Working' : said ? `Done: ${said}` : 'Ready for you to review';

  return (
    <div className={`settings-row surface-row next-row next-aside${busy ? ' is-busy' : ''}`}>
      <span className="next-lead" aria-hidden>
        {busy && !waiting ? <Spinner size={15} /> : <span className={`next-dot${waiting ? ' is-waiting' : ''}`} />}
      </span>
      <button type="button" className="next-row-body" onClick={onOpenThread}>
        <span className="settings-row-title">{item.title}</span>
        <span className={`settings-row-description surface-meta${waiting ? ' is-waiting' : ''}`}>
          <span className="next-aside-step">{status}</span>
          {busy && live?.startedAt ? <span className="next-aside-time">{elapsed(live.startedAt, now)}</span> : null}
        </span>
      </button>
      {busy && live?.tab && item.sessionId ? (
        <AsideThumb sessionId={item.sessionId} busy={busy} step={live.step} />
      ) : null}
      {busy ? (
        <button type="button" className="next-icon-button" onClick={onStop} aria-label="Stop">
          <Square size={11} strokeWidth={0} fill="currentColor" />
        </button>
      ) : (
        <button type="button" className="next-text-button" onClick={onDone}>
          Done
        </button>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Email pieces. The server decided everything shown here: whether a link
// checked out, whether a draft is offered, whether an email is flagged.

/** Where an email's link really goes. Only a verified link is tappable. */
export function LinkLine({ link, onOpen }: { link: NextLink; onOpen: () => void }) {
  if (!link.verified) {
    return (
      <p className="next-link is-unverified">
        <ShieldAlert size={15} strokeWidth={1.75} aria-hidden />
        <span className="next-link-text">
          Link goes to {link.host}: {link.reason}
        </span>
      </p>
    );
  }
  return (
    <button type="button" className="next-link" onClick={onOpen}>
      <ShieldCheck size={15} strokeWidth={1.75} aria-hidden />
      <span className="next-link-text">
        {link.host}, {link.reason}
      </span>
      <span className="next-trail-go">Visit</span>
    </button>
  );
}

const BLANK = /\[[^\]\n]{1,60}\]/g;

type DraftState =
  | { phase: 'writing' }
  | { phase: 'ready'; to: string }
  | { phase: 'error'; message: string };

/**
 * A reply, written by a model with no tools and edited here. He copies it
 * and opens the email itself; nothing is written into Gmail for him, and
 * there is no send button anywhere.
 */
export function DraftSheet({
  item,
  onClose,
  onCopied,
}: {
  item: NextItem;
  onClose: () => void;
  onCopied: () => void;
}) {
  const [state, setState] = useState<DraftState>({ phase: 'writing' });
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const run = useRef(0);

  const write = async () => {
    const mine = ++run.current;
    setState({ phase: 'writing' });
    setSaveError(null);
    try {
      const d = await api.nextDraft(item.id);
      if (mine !== run.current) return;
      setText(d.text);
      setState({ phase: 'ready', to: d.to });
    } catch (e) {
      if (mine !== run.current) return;
      const msg = String((e as Error)?.message ?? '');
      setState({
        phase: 'error',
        message: /no_reply|409/.test(msg)
          ? 'This came from a no-reply address, so there is no one to answer.'
          : 'Could not write a draft right now. Try again.',
      });
    }
  };

  useEffect(() => {
    void write();
    return () => {
      run.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const blanks = (text.match(BLANK) ?? []).length;
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await navigator.clipboard.writeText(text.trim());
      if (item.url) void openUrl(item.url);
      onCopied();
    } catch {
      setSaveError('Could not copy. Select the text and copy it yourself.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet side="bottom" title="Reply draft" subtitle={item.title} onClose={onClose}>
      <div className="next-brief next-draft">
        {state.phase === 'writing' ? (
          <p className="next-draft-wait">
            <Spinner size={14} /> Writing with a model that cannot open links or act
          </p>
        ) : null}
        {state.phase === 'error' ? <p className="next-brief-note">{state.message}</p> : null}
        {state.phase === 'ready' ? (
          <>
            <p className="next-draft-to">
              <span>To</span> {state.to}, as a reply on the same email
            </p>
            <textarea
              className="next-draft-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={9}
              aria-label="Reply text"
            />
            {blanks ? (
              <p className="next-draft-blanks">
                Fill the {blanks === 1 ? 'blank' : `${blanks} blanks`} in brackets. Only you can answer {blanks === 1 ? 'it' : 'them'}.
              </p>
            ) : null}
            {saveError ? <p className="next-draft-blanks">{saveError}</p> : null}
            <button
              type="button"
              className="next-primary next-brief-go"
              onClick={() => void save()}
              disabled={saving || blanks > 0 || !text.trim()}
            >
              {saving ? <Spinner size={16} /> : null}
              Copy and open the email
            </button>
            <div className="next-quiet next-draft-quiet">
              <button type="button" onClick={() => void write()} disabled={saving}>
                Write it again
              </button>
            </div>
            <p className="next-brief-fine">In Gmail, tap Reply and paste. Nothing is sent for you.</p>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

/** Something worth a glance that is not a task. Flagged mail says why. */
export function NoticeRow({
  notice,
  onOpen,
  onClear,
}: {
  notice: NextNotice;
  onOpen: () => void;
  onClear: () => void;
}) {
  const meta = notice.flag
    ? notice.why
    : [notice.context, notice.why].filter(Boolean).join('. ');
  return (
    <div className={`settings-row surface-row next-row next-notice${notice.flag ? ' is-flagged' : ''}`}>
      <button type="button" className="next-row-body" onClick={onOpen} disabled={!notice.url}>
        <span className="settings-row-title">
          {notice.flag ? <ShieldAlert size={14} strokeWidth={2} aria-label="Flagged" className="next-flag-glyph" /> : null}
          {notice.title}
        </span>
        <span className="settings-row-description surface-meta">{meta}</span>
      </button>
      <button type="button" className="next-clear" onClick={onClear} aria-label={`Clear ${notice.title}`}>
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}

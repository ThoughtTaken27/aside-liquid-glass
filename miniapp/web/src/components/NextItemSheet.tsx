import { Shine } from './Affect';
/**
 * One task, everything you can do with it. Nothing here runs on its own:
 * every helper starts only from a button in this sheet, and each one says
 * in plain words what it will and won't do before you tap.
 */
import { alsoLine, doneHintLine, estLabel, flagLine } from '../utils/jevMarks';
import { useState } from 'react';
import { ArrowUpRight, Check, Spinner } from './Icons';
import { EyeOff, Timer } from 'lucide-react';
import { Sheet } from './Sheet';
import type { NextItem, NextSpace } from '../types';
import { formatMinutes, senderLine, stamp } from '../utils/nextFormat';
import { skipLabel } from '../utils/nextFormat';
import { dueTone, isPlanned, whenText } from './NextToday';
import { SpaceGlyph } from './NextSpace';
import { ContextEvidence } from './NextContext';
import { DocumentLinkControl } from './NextDocument';

export function laterChoices(now: Date): Array<{ label: string; until: Date }> {
  const at = (days: number, h: number, m = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const out: Array<{ label: string; until: Date }> = [];
  const weekend = (d: number) => d === 0 || d === 6;
  if (now.getHours() < 20) out.push({ label: 'Tonight', until: at(0, 21) });
  // After school on a school day, mid-morning on a weekend.
  const tmr = (now.getDay() + 1) % 7;
  out.push({ label: 'Tomorrow', until: weekend(tmr) ? at(1, 10) : at(1, 15, 30) });
  if (weekend(now.getDay()) || now.getDay() === 5) {
    const toMon = (8 - now.getDay()) % 7 || 7;
    out.push({ label: 'Monday', until: at(toMon, 15, 30) });
  } else {
    out.push({ label: 'Saturday', until: at(6 - now.getDay(), 10) });
  }
  return out;
}

export function ItemSheet({
  item,
  busy,
  onClose,
  onOpenUrl,
  onDone,
  onLater,
  onDismiss,
  onHelp,
  onCancelHelp,
  onResearch,
  onOpenResearch,
  onDraft,
  onFocus,
  onMove,
}: {
  item: NextItem;
  busy: string | null;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
  onDone: () => void;
  onLater: (until: Date, label: string) => void;
  onDismiss: () => void;
  onHelp: () => void;
  onCancelHelp: () => void;
  onResearch: () => void;
  onOpenResearch: (id: string) => void;
  onDraft: () => void;
  onFocus: () => void;
  /** Only for tasks you added: move between School and Personal. */
  onMove?: (space: NextSpace) => void;
}) {
  const now = new Date();
  const [ticked, setTicked] = useState<Record<number, boolean>>({});
  const tone = dueTone(item, now);
  const est = formatMinutes(item.estMinutes);
  const b = item.brief;
  const research = b.research ?? null;
  const helping = item.status === 'handed-off';
  const waiting = item.handoff?.state === 'waiting';

  return (
    <Sheet showClose side="bottom" title={item.context || (item.taint === 'email' ? 'School email' : 'Task')} subtitle={item.taint === 'email' ? senderLine(item.sender) : undefined} onClose={onClose}>
      <div className="n3-sheet">
        {/* The full title, never cut off; the sheet's one serif line. */}
        <h2 className="n3-sheet-title">{item.title}</h2>
        <dl className="n3-facts">
          {item.dueISO ? (
            <div>
              <dt>{isPlanned(item) ? 'Planned' : 'Due'}</dt>
              <dd className={`n3-due is-${tone}`}>
                {tone === 'late' || tone === 'today' ? <span className="n3-due-mark" aria-hidden /> : null}
                {(() => {
                  const w = whenText(item, now).replace(/^due /, '').replace(/^planned for /, '').replace(/^was due/, 'was due');
                  return w.charAt(0).toUpperCase() + w.slice(1);
                })()}
              </dd>
            </div>
          ) : null}
          {est ? (
            <div>
              <dt>Takes</dt>
              <dd>{estLabel(item, est)}</dd>
            </div>
          ) : null}
          {item.link ? (
            <div>
              <dt>Link</dt>
              <dd>
                {item.link.host}
                <small className={item.link.verified ? 'is-ok' : 'is-warn'}>{item.link.verified ? `Checked: ${item.link.reason}` : `Not checked: ${item.link.reason}`}</small>
              </dd>
            </div>
          ) : null}
          {item.trail ? (
            <div>
              <dt>Last opened</dt>
              <dd>
                {item.trail.kind}, {stamp(new Date(item.trail.lastAt), now)}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="n3-sheet-actions">
          {item.url ? (
            <button type="button" className="n3-btn is-primary" onClick={() => onOpenUrl(item.url!)}>
              {item.taint === 'email' ? 'Open email' : 'Open'}
              <ArrowUpRight size={16} strokeWidth={2} />
            </button>
          ) : null}
          <button type="button" className={`n3-btn ${item.url ? 'is-secondary' : 'is-primary'}`} onClick={onDone} disabled={busy === 'done'}>
            Done
          </button>
        </div>

        <div className="n3-now-more n3-sheet-more" role="group" aria-label="Task choices">
          <button type="button" onClick={onFocus}>
            <Timer size={17} strokeWidth={1.9} aria-hidden />
            Focus timer
          </button>
          <button type="button" onClick={onDismiss}>
            <EyeOff size={17} strokeWidth={1.9} aria-hidden />
            {skipLabel(item)}
          </button>
        </div>

        {item.flag ? <p className="n3-warn">{flagLine(item)}</p> : null}
        {item.doneHint && item.status === 'open' ? (
          <div className="n3-donehint" role="note">
            <p>{doneHintLine(item, now)}</p>
            <button type="button" className="n3-btn is-secondary n3-donehint-btn" onClick={onDone} disabled={busy === 'done'}>
              Mark done
            </button>
          </div>
        ) : null}
        {item.why ? <p className="n3-sheet-why">{item.why}</p> : null}
        <ContextEvidence item={item} />
        <DocumentLinkControl item={item} />
        {alsoLine(item) ? <p className="n3-sheet-note n3-also">{alsoLine(item)}</p> : null}
        {item.ask && item.ask !== item.why ? <p className="n3-sheet-ask">The email asks: {item.ask}</p> : null}

        {item.steps.length ? (
          <ol className="n3-steps">
            {item.steps.map((s, i) => (
              <li key={i}>
                <button type="button" aria-pressed={!!ticked[i]} onClick={() => setTicked((t) => ({ ...t, [i]: !t[i] }))}>
                  <span className={`n3-mini-check${ticked[i] ? ' is-on' : ''}`} aria-hidden>
                    {ticked[i] ? <Check size={11} strokeWidth={3} /> : null}
                  </span>
                  <span>{s}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : null}

        <div className="n3-chip-row" role="group" aria-label="Move to later">
          <span className="n3-chip-label">Later</span>
          {laterChoices(now).map((c) => (
            <button type="button" key={c.label} className="n3-chip" onClick={() => onLater(c.until, c.label)}>
              {c.label}
            </button>
          ))}
        </div>


        {b.mode === 'agent' || research || b.mode === 'draft' ? <h3 className="n3-sheet-head">Get help</h3> : null}

        {b.mode === 'agent' ? (
          <section className="n3-help">
            <div className="n3-help-top">
              <p className="n3-help-title">Let Next help</p>
              <p className="n3-help-line">{b.headline}</p>
            </div>
            <ul className="n3-help-list">
              {b.will.map((w) => (
                <li key={w} className="is-will">
                  {w}
                </li>
              ))}
              {b.wont.map((w) => (
                <li key={w} className="is-wont">
                  Won't {w.charAt(0).toLowerCase()}
                  {w.slice(1)}
                </li>
              ))}
            </ul>
            {b.stopsAt ? <p className="n3-help-stop">Stops at: {b.stopsAt}</p> : null}
            {helping ? (
              item.live && !item.live.busy && item.live.result ? (
                <div className="n3-help-result">
                  <p className="n3-help-state">Next finished. Nothing was submitted.</p>
                  <p className="n3-help-line" style={{ whiteSpace: 'pre-line' }}>{item.live.result}</p>
                </div>
              ) : (
                <p className="n3-help-state"><Shine active={!!item.live?.busy} text={`Next is working on this${item.live?.step ? `: ${item.live.step}` : ''}.`} /></p>
              )
            ) : waiting ? (
              <div className="n3-help-row">
                <p className="n3-help-state">
                  You asked for help. Next is getting ready{item.handoff?.readyInMin ? `, about ${item.handoff.readyInMin} min` : ''}.
                </p>
                <button type="button" className="n3-text-btn" onClick={onCancelHelp}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="n3-btn is-secondary is-full" onClick={onHelp} disabled={busy === 'help'}>
                {busy === 'help' ? <Spinner size={15} /> : null}
                Get help
              </button>
            )}
          </section>
        ) : null}

        {research ? (
          <section className="n3-help">
            <div className="n3-help-top">
              <p className="n3-help-title">Look into this</p>
              <p className="n3-help-line">
                {research.kind === 'web'
                  ? 'Next searches the web and brings back a short answer with sources. It cannot see your files or use your logins.'
                  : `Next reads the page on ${research.host ?? 'that site'} and sums up what you need. It cannot click, type, or submit anything.`}
              </p>
            </div>
            {item.research && item.research.state !== 'dismissed' ? (
              item.research.state === 'ready' ? (
                <button type="button" className="n3-btn is-secondary is-full" onClick={() => onOpenResearch(item.research!.id)}>
                  Read the answer{item.research.verdictLabel ? `: ${item.research.verdictLabel}` : ''}
                </button>
              ) : item.research.state === 'failed' ? (
                <button type="button" className="n3-btn is-secondary is-full" onClick={onResearch}>
                  Try again
                </button>
              ) : (
                <p className="n3-help-state"><Shine text={item.research.state === 'preparing' ? 'Getting ready' : 'Looking into it'} /></p>
              )
            ) : (
              <button type="button" className="n3-btn is-secondary is-full" onClick={onResearch} disabled={busy === 'research'}>
                {busy === 'research' ? <Spinner size={15} /> : null}
                Look into this
              </button>
            )}
          </section>
        ) : null}

        {b.mode === 'draft' ? (
          <section className="n3-help">
            <div className="n3-help-top">
              <p className="n3-help-title">Write a reply</p>
              <p className="n3-help-line">Next writes a short reply for you to edit. You copy it and send it yourself. Nothing is sent or saved.</p>
            </div>
            <button type="button" className="n3-btn is-secondary is-full" onClick={onDraft}>
              Write a reply
            </button>
          </section>
        ) : null}

        {b.mode === 'none' && b.note && !item.flag ? <p className="n3-sheet-note">{b.note}</p> : null}

        {onMove && item.source === 'manual' ? (
          <button type="button" className="n3-text-btn is-muted n3-move" onClick={() => onMove(item.space === 'school' ? 'personal' : 'school')}>
            <SpaceGlyph space={item.space === 'school' ? 'personal' : 'school'} size={7} />
            Move to {item.space === 'school' ? 'Personal' : 'School'}
          </button>
        ) : null}


      </div>
    </Sheet>
  );
}

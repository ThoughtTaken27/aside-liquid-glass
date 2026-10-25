/**
 * A failed turn, drawn as Aside's own alert card.
 *
 * The mini app used to render nothing at all here: a rate-limited turn was
 * a blank response, because the failure lives on an assistant record with
 * `stopReason: "error"` and an EMPTY content array, and a renderer that
 * only reads content sees nothing to draw. The server classifies it (see
 * `server/src/errors.ts`) and this is the card.
 *
 * Shape (AI SDK Agents' model-unavailable / limit-reached / interrupted
 * reply, fitted to Aside): the title says what happened, one sentence says
 * why, a real fact stands where reassurance would ("Your message is
 * saved."), and the one action is named by what it does. A stopped turn is
 * not an error at all, so it is a quiet line with Continue rather than a
 * card. The action only appears on the latest failure -- an old one in the
 * history is a record, not a control.
 *
 * Copy is re-voiced here, on the phone, from the server's titles, so the
 * server (and the desktop's wording it mirrors) stays untouched.
 */
import { useRef, useState } from 'react';
import { TriangleAlert } from './Icons';
import type { ErrorAlert } from '../types';

type Kind = 'stopped' | 'retryable' | 'blocked';

interface Voiced {
  kind: Kind;
  title: string;
  cause: string;
  /** A true statement about what was kept; never a "don't worry". */
  fact?: string;
}

const SAVED = 'Your message is saved.';

/** Map the server's classified alert onto the phone's wording. */
export function voiceAlert(alert: ErrorAlert): Voiced {
  const t = alert.title.trim();
  if (t === 'Task was aborted') {
    return { kind: 'stopped', title: 'This reply was stopped', cause: '' };
  }
  if (t === 'Request rate limited') {
    return {
      kind: 'retryable',
      title: 'Too many requests',
      cause: 'The model provider is limiting requests right now.',
      fact: SAVED,
    };
  }
  if (t === 'The AI provider is temporarily unavailable.') {
    return {
      kind: 'retryable',
      title: 'The model provider isn\u2019t answering',
      cause: 'Aside retried, but the provider didn\u2019t recover in time.',
      fact: SAVED,
    };
  }
  if (t === "You're out of credits for this task.") {
    return { kind: 'blocked', title: 'Out of credits', cause: alert.description };
  }
  if (t === 'There was an error while running the task') {
    return {
      kind: 'retryable',
      title: 'The task stopped with an error',
      cause: firstSentence(alert.description) || 'It stopped before it finished.',
      fact: SAVED,
    };
  }
  if (t === 'The task could not be run') {
    return { kind: 'retryable', title: 'The task couldn\u2019t start', cause: alert.description, fact: SAVED };
  }
  // Sign-in expired, disk full, and anything new: the server's own words,
  // and no Continue, because sending again cannot fix them from here.
  return { kind: 'blocked', title: t, cause: alert.description };
}

function firstSentence(text: string): string {
  const s = text.trim();
  if (s.length <= 140) return s;
  const cut = s.slice(0, 140);
  const end = cut.lastIndexOf('. ');
  return end > 40 ? cut.slice(0, end + 1) : `${cut.trimEnd()}\u2026`;
}

export function ErrorCard({
  alert,
  onContinue,
}: {
  alert: ErrorAlert;
  /** Present only on the latest failure while nothing is running. */
  onContinue?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The raw message is not in the page until asked for; once opened it
  // stays mounted so closing can fold instead of vanish.
  const [opened, setOpened] = useState(false);
  const [sent, setSent] = useState(false);
  // State lands on the next render; a ref stops a fast double tap now.
  const pressed = useRef(false);
  const voiced = voiceAlert(alert);
  // A detail identical to what the card already says would just repeat it,
  // so the button is only offered when it reveals something.
  const hasDetail = Boolean(
    alert.detail &&
      alert.detail.trim() !== alert.description.trim() &&
      alert.detail.trim() !== voiced.cause.trim(),
  );
  const canContinue = Boolean(onContinue) && voiced.kind !== 'blocked' && !sent;
  const press = () => {
    if (!onContinue || pressed.current) return;
    pressed.current = true;
    setSent(true);
    onContinue();
  };

  if (voiced.kind === 'stopped') {
    return (
      <div className="stopped-line" data-card-kind="stopped" role="status">
        <span className="stopped-mark" aria-hidden="true" />
        <span className="stopped-text">{voiced.title}</span>
        {canContinue ? (
          <button type="button" className="craft-pill" onClick={press}>
            Continue
          </button>
        ) : null}
      </div>
    );
  }

  const foot = canContinue || hasDetail;
  return (
    <div
      className={`alert-card utility-card craft-tray${alert.tone === 'destructive' ? ' is-destructive' : ''}`}
      data-card-group="utility"
      data-card-kind="error"
      data-card-state={open ? 'expanded' : 'collapsed'}
      data-card-tone={alert.tone}
      role="status"
    >
      <div className="craft-card alert-head">
        <span className="alert-icon">
          <TriangleAlert size={15} strokeWidth={1.75} aria-hidden />
        </span>
        <div className="alert-body">
          <p className="alert-title">{voiced.title}</p>
          {voiced.cause ? <p className="alert-description">{voiced.cause}</p> : null}
        </div>
      </div>
      {foot || voiced.fact ? (
        <div className="craft-foot">
          <span className="craft-foot-note">{voiced.fact ?? ''}</span>
          {hasDetail ? (
            <button
              type="button"
              className="craft-ghost alert-details"
              aria-expanded={open}
              onClick={() => {
                if (!opened) {
                  // Mount closed, then open on the next frame, so the
                  // first opening folds out instead of popping in.
                  setOpened(true);
                  requestAnimationFrame(() => setOpen(true));
                  return;
                }
                setOpen((prev) => !prev);
              }}
            >
              Details
            </button>
          ) : null}
          {canContinue ? (
            <button type="button" className="craft-pill is-primary" onClick={press}>
              Continue
            </button>
          ) : null}
        </div>
      ) : null}
      {hasDetail && opened ? (
        <div className="craft-fold" data-open={open ? '' : undefined} inert={open ? undefined : true}>
          <div>
            <p className="alert-detail">{alert.detail}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

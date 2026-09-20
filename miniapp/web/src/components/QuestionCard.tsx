/**
 * A question the agent has put to the user.
 *
 * This replaces the worst thing in the app: an `ask_user_question` call
 * rendered as a raw JSON blob under a "Success" badge, while the turn it
 * belonged to spun forever. See the reference screenshot.
 *
 * One card serves both sources, because to a reader they are the same
 * thing:
 *
 *  - a NATIVE pending tool, which only Aside on the desktop can answer.
 *    The options are shown but disabled, with a notice saying where to
 *    answer it -- an honest dead end beats a button that silently does
 *    nothing.
 *  - a SOFT-marker question, which sessions this app starts are instructed
 *    to use instead (see `server/src/preamble.ts`). Tapping an option
 *    sends the choice as an ordinary follow-up, which works because the
 *    agent ended its turn before asking.
 *
 * A question that has already been answered keeps its shape and shows the
 * choice, so scrolling back through a thread reads as history rather than
 * as a wall of live prompts.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Check, Spinner } from './Icons';
import { haptic, mainButton, secondaryButton } from '../telegram';
import type { QuestionBlock, QuestionItem } from '../types';

export interface QuestionCardProps {
  item: QuestionItem;
  /** Send a choice. Absent on a card that cannot be answered from here. */
  onAnswer?: (header: string, label: string) => Promise<void> | void;
  /**
   * Carry on in a NEW session, seeded with this question and the option
   * the user picked.
   *
   * Only ever passed for a pending NATIVE question, which is the one card
   * that cannot be answered from here. Absent means the dead end stays a
   * dead end, which is what happened before this existed.
   */
  onRecover?: (label: string) => Promise<void> | void;
  /** True while a send from this thread is in flight. */
  busy?: boolean;
}

function Options({
  block,
  disabled,
  chosen,
  onPick,
  describedBy,
}: {
  block: QuestionBlock;
  disabled: boolean;
  chosen: string | null;
  onPick: (label: string) => void;
  describedBy?: string;
}) {
  if (!block.options.length) return null;
  return (
    <div className="question-options">
      {block.options.map((option) => (
        <button
          key={option.label}
          type="button"
          className={`question-option ${chosen === option.label ? 'is-chosen' : ''}`}
          disabled={disabled}
          aria-describedby={describedBy}
          onClick={() => onPick(option.label)}
        >
          <span className="question-option-label">
            {option.label}
            {chosen === option.label ? <Check size={13} strokeWidth={2} /> : null}
          </span>
          {option.description ? (
            <span className="question-option-description">
              {option.description}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function QuestionCard({
  item,
  onAnswer,
  onRecover,
  busy,
}: QuestionCardProps) {
  /**
   * The option this client just tapped.
   *
   * Held locally so the card acknowledges the tap immediately. The
   * transcript's own record of the answer arrives a turn later and is what
   * finally settles the card (`item.status === 'answered'`); until then
   * this is the only feedback there is.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const noticeId = useId();

  const settled = item.status === 'answered';
  const live = item.answerable && !settled && Boolean(onAnswer);
  /**
   * The dead end, with a way out.
   *
   * A pending native question cannot be answered from here -- the daemon
   * is holding the session for the desktop sidepanel and no request this
   * app can make reaches it. What CAN happen is a new session that starts
   * already knowing what was asked and what the user picked, so the
   * options become tappable again: they seed the continuation rather than
   * answering the session they were asked in. The stuck one is untouched,
   * because nothing can touch it.
   */
  const recoverable = !settled && !item.answerable && Boolean(onRecover);
  const disabled =
    (!live && !recoverable) || sending || (Boolean(busy) && !recoverable) || chosen !== null;

  const send = async (header: string, label: string) => {
    if (disabled) return;
    const act = recoverable
      ? () => onRecover!(item.questions.length > 1 && header && label ? `${header}: ${label}` : label)
      : onAnswer
        ? () => onAnswer(header, label)
        : null;
    if (!act) return;
    haptic('light');
    setChosen(label);
    setSending(true);
    setError(null);
    try {
      await act();
    } catch {
      // Let the reader try again rather than leaving a choice that never
      // went anywhere ticked.
      setChosen(null);
      setError("Your reply was not sent. Please try again; your chat is safe.");
    } finally {
      setSending(false);
    }
  };

  // A ref rather than a plain closure, so the native-button bindings below
  // (which only rebind when the QUESTION text changes, not on every
  // keystroke-driven render) always call the current `send` -- one that
  // sees the live `disabled`/`chosen` state instead of whatever it was the
  // moment the button was bound.
  const sendRef = useRef(send);
  sendRef.current = send;

  // A pending question is the one moment this app should interrupt
  // someone -- fire once per card, not on every re-render.
  const warnedRef = useRef(false);
  useEffect(() => {
    if ((live || recoverable) && !warnedRef.current) {
      warnedRef.current = true;
      haptic('warning');
    }
  }, [live, recoverable]);

  /**
   * The common shape -- one block, two options (approve/deny, yes/no) --
   * gets Telegram's own MainButton/SecondaryButton instead of relying on
   * the inline row. This is the single strongest "feels native" signal
   * available (Day 1 plan, 5.3): the OS-level button bar, not a webview
   * button pretending to be one.
   */
  const soleBlock = item.questions.length === 1 ? item.questions[0] : null;
  const twoOptions =
    soleBlock && soleBlock.options.length === 2 ? soleBlock.options : null;
  const [firstOption, secondOption] = twoOptions ?? [];

  useEffect(() => {
    if (!live || !twoOptions || !soleBlock) return undefined;
    const header = soleBlock.header;
    const first = mainButton.bind({
      text: firstOption!.label,
      onClick: () => void sendRef.current(header, firstOption!.label),
    });
    const second = secondaryButton.bind({
      text: secondOption!.label,
      onClick: () => void sendRef.current(header, secondOption!.label),
    });
    return () => {
      first.release();
      second.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, firstOption?.label, secondOption?.label]);

  useEffect(() => {
    if (!twoOptions) return;
    if (sending) mainButton.showLoader();
    else mainButton.hideLoader();
  }, [sending, twoOptions]);

  // Native buttons replace the inline row only while they are actually on
  // screen -- a client without MainButton support (or a settled/historical
  // card, where the binding above never mounts) keeps the inline row as
  // the fallback and the permanent record.
  const nativeButtonsActive = live && Boolean(twoOptions) && mainButton.isSupported();

  return (
    <div
      className={`question-card utility-card ${settled ? 'is-settled' : ''} ${
        live || recoverable ? '' : 'is-readonly'
      }`}
      data-card-group="utility"
      data-card-kind="question"
      data-card-state={settled ? 'settled' : live || recoverable ? 'actionable' : 'readonly'}
    >
      {item.questions.map((block, index) => (
        <div className="question-block" key={`${block.header}-${index}`}>
          <p className="question-header">{block.header}</p>
          <p className="question-text">{block.question}</p>
          {nativeButtonsActive ? null : (
            <Options
              block={block}
              disabled={disabled}
              describedBy={!settled && !item.answerable ? noticeId : undefined}
              chosen={chosen}
              onPick={(label) => void send(block.header, label)}
            />
          )}
        </div>
      ))}

      {item.artifact ? (
        <dl className="question-artifact">
          {item.artifact.summary.map((row) => (
            <div className="question-artifact-row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {/*
        Free text alongside the options, because a real answer is often
        "neither of those, here is what I actually want" -- which is what
        the desktop card's own reply field is for.
      */}
      {live || recoverable ? (
        <form
          className="question-reply"
          onSubmit={(event) => {
            event.preventDefault();
            const text = reply.trim();
            if (!text) return;
            void send(item.questions[0]?.header || '', text);
          }}
        >
          <input
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            placeholder="Or reply in your own words"
            disabled={disabled}
            aria-label="Reply to this question"
          />
          <button type="submit" disabled={disabled || !reply.trim()}>
            {sending ? <Spinner size={13} /> : 'Send'}
          </button>
        </form>
      ) : null}

      {settled && item.answer ? (
        <p className="question-answered">{item.answer}</p>
      ) : null}

      {/*
        The honest dead end. A pending native tool has the daemon holding
        the session open for an answer over its own authenticated channel,
        and that channel is the desktop sidepanel -- verified against the
        live CLI. There is no request this app can make that would deliver
        the answer, so it says so instead of pretending.
      */}
      {!settled && !item.answerable ? (
        <p className="question-notice" id={noticeId}>
          {recoverable ? (
            <>
              This session is waiting on Aside on your computer and can’t be
              answered from here. Pick an option (or reply) to carry on in a
              new session; the original chat stays saved.
            </>
          ) : (
            <>
              Respond from Aside on your computer — this request can’t be
              answered from mobile.
            </>
          )}
        </p>
      ) : null}

      {error ? <p role="alert" className="question-error">{error}</p> : null}

      {recoverable ? (
        <button
          type="button"
          className="question-recover"
          disabled={disabled}
          onClick={() => void send(item.questions[0]?.header || '', '')}
        >
          {sending ? <Spinner size={13} /> : 'Continue in a new session'}
        </button>
      ) : null}
    </div>
  );
}

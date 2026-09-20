/**
 * The composer, in Aside's two forms.
 *
 * `home` is the card at the top of the sidepanel home screen -- sending
 * from it starts a NEW session, which is why there is no separate
 * new-chat button anywhere. `reply` is the slimmer pill above a thread's
 * bottom bar.
 *
 * Both carry the same model and effort pills, so the setting you can see
 * is always the setting the next turn will use, plus the `+` attach button
 * and the permission badge.
 *
 * The placeholder no longer mentions "@ for context". The browser's
 * @-popover lists the user's live open tabs, and that inventory lives in
 * the extension rather than in the daemon -- the database only records the
 * tabs a session has already borrowed. There is no way to populate it
 * faithfully from a phone, and offering a control that cannot work is
 * worse than not offering it.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  FileIcon,
  Plus,
  ProviderMark,
  Spinner,
  StopSquare,
  X,
} from './Icons';
import { VoiceButton } from './VoiceButton';
import { haptic } from '../telegram';
import type { ComposerAttachment } from '../types';
import { pillModelLabel } from '../utils/pills';

export interface PillState {
  modelLabel: string;
  effortLabel: string;
  effortId: string;
  /**
   * Provider id behind the model pill, so the pill can carry that
   * provider's REAL brand mark -- the Claude starburst, the OpenAI knot --
   * exactly as the desktop composer does. It used to be a hand-drawn
   * asterisk regardless of which model was running.
   */
  provider?: string;
}

export interface ComposerProps {
  variant: 'home' | 'reply';
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pills: PillState;
  onOpenModel: (anchor: HTMLElement) => void;

  attachments: ComposerAttachment[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (key: string) => void;
  busy?: boolean;
  disabled?: boolean;
  /**
   * A turn is running.
   *
   * The send button turns INTO the stop control while this is true, which
   * is what the desktop composer does: one slot, one control, and the
   * shape of it tells you whether the agent is waiting for you or you are
   * waiting for it. The previous layout put a second, smaller square to
   * the left of an unchanged send arrow, so the phone never showed the
   * black-circle stop the desktop shows and the send arrow stayed lit
   * during a turn as if a second message were expected.
   */
  streaming?: boolean;
  /**
   * Kill the running turn. Absent on the home composer, which has none,
   * and absent for a turn this server does not own -- see `stopBlocked`.
   */
  onStop?: () => void;
  /**
   * Why the running turn cannot be stopped from here, when it cannot.
   *
   * A turn started in Aside on the Mac runs inside the daemon process,
   * which exposes no cancel to this server (its `sessions.abort` procedure
   * sits behind a signed handshake only the desktop app's own keychain
   * identity can complete). The control still appears -- the state IS
   * "running", and hiding it would make the composer disagree with the
   * desktop -- but it says why instead of pretending to fire.
   */
  stopBlocked?: string | null;
  /** Between tapping Stop and the turn actually ending. */
  stopping?: boolean;
  /**
   * The session is blocked on a question only the desktop app can answer.
   * The input is disabled and this is the reason shown in its place --
   * sending would queue a turn that hangs forever.
   */
  blockedReason?: string | null;
  /**
   * The way out of `blockedReason`, when there is one.
   *
   * A suspended session's own question card carries a "Continue in a new
   * session" button, but that card only renders when the transcript
   * parsed a clean native-question item. When it did not -- the driver
   * was reaped mid tool-call and the write never landed -- the banner had
   * nothing to tap. This puts the same escape hatch directly under the
   * banner so it is never just a dead end.
   */
  onRecover?: () => void;
  /** Between tapping the recover button and the new session existing. */
  recovering?: boolean;
  /** Button copy for `onRecover`. Defaults to "Continue in a new session". */
  recoverLabel?: string;
  /**
   * Context-window occupancy, drawn as a ring beside the model pill.
   * Absent on home, where there is no session to measure.
   */
  /** Rendered directly above the composer: the task list. */
  above?: React.ReactNode;
  /**
   * What this field is aimed at.
   *
   * Search used to be a second page reached by swiping, which made it a
   * place rather than a mode: you could not tell from the composer what
   * would happen when you typed, because typing happened somewhere else.
   * Both jobs are "put words in a box and go somewhere", so they differ in
   * destination and not in gesture, which is what a segmented control is
   * for. Absent on the reply composer, which has only one destination.
   *
   * The switch itself (top-bar pill, home-screen swipe) lives above this
   * component now; this only reads the current mode to adjust its own
   * furniture (placeholder, autocorrect, which buttons show).
   */
  mode?: ComposerMode;
}

export type ComposerMode = 'chat' | 'search';

/** The `✳ Fable 5 ∨` / `High ∨` triggers from the bottom bar. */
export function Pill({
  label,
  onOpen,
  mark,
  className = '',
}: {
  label: string;
  onOpen: (anchor: HTMLElement) => void;
  /** Provider id to draw a brand mark for, or absent for a bare pill. */
  mark?: string;
  /** Permission state worth flagging: 'full', 'read', or absent. */
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      className={`pill ${className}`}
      data-composer-control="model"
      data-composer-group="context"
      onClick={() => ref.current && onOpen(ref.current)}
    >
      {mark ? <ProviderMark id={mark} size={13} /> : null}
      <span className="pill-label">{pillModelLabel(label)}</span>
      {/*
        No chevron.

        The reference's model control is a plain capsule with a label and
        nothing else, and it is right: a filled pill sitting in a row of
        buttons is already unmistakably tappable, so the caret is spending
        13px plus a gap to repeat what the shape has said. Dropping it also
        buys the label that width back, which is the difference between
        `gpt-6-astra` and `gpt-6-ast…` on a narrow phone.
      */}
    </button>
  );
}

/**
 * What the OS picker is allowed to offer.
 *
 * Kept to what the agent can actually do something useful with locally.
 * `image/*` first so the phone's gallery is the obvious choice, which is
 * what the owner reaches for.
 */
const ACCEPT = 'image/*,application/pdf,.txt,.md,.csv,.json';

/**
 * Whether the primary input is a finger rather than a keyboard.
 *
 * `pointer: coarse` is the honest test: it asks the browser about the
 * primary pointing device instead of sniffing a user-agent string, and it
 * is what Telegram's iOS/Android webviews report. Desktop Telegram and a
 * plain browser tab report `fine` and keep Enter-to-send.
 *
 * Guarded because `matchMedia` is absent in the jsdom test environment,
 * where the desktop behaviour is the one being asserted.
 */
function isTouchPrimary(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/** One attachment chip: an image thumbnail, or a doc icon and its name. */
function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  const isImage =
    attachment.mimeType.startsWith('image/') && Boolean(attachment.previewUrl);

  return (
    <span
      className={`chip ${attachment.status === 'failed' ? 'is-failed' : ''} ${
        attachment.status === 'uploading' ? 'is-uploading' : ''
      }`}
      title={attachment.error || attachment.name}
    >
      {isImage ? (
        <img className="chip-thumb" src={attachment.previewUrl} alt="" />
      ) : (
        <span className="chip-glyph">
          <FileIcon size={13} strokeWidth={1.75} />
        </span>
      )}
      <span className="chip-name">{attachment.name}</span>
      {attachment.status === 'uploading' ? <Spinner size={12} /> : null}
      <button
        type="button"
        className="chip-remove"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </span>
  );
}

/*
 * There is no permission mark on the composer, by decision.
 *
 * It went through a corner dot and then an inline glyph, and both earned
 * the same question: what is that. The honest read is that permission has
 * no business competing for attention in the control row at all -- it is
 * a setting you change deliberately and then stop thinking about, not a
 * live readout like context. It lives in the model sheet with the other
 * two settings that describe how a turn will run, where it is named in
 * words instead of asking a colour to carry the whole meaning.
 */

export function Composer({
  variant,
  value,
  onChange,
  onSubmit,
  pills,
  onOpenModel,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  busy,
  disabled,
  streaming,
  onStop,
  stopping,
  stopBlocked,
  blockedReason,
  onRecover,
  recovering,
  recoverLabel,
  above,
  mode,
}: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * The composer's one inline notice line, shown under the input.
   *
   * Used by dictation for a failed take and by the stop control when the
   * running turn belongs to the Mac. Deliberately not a toast: both things
   * are about a control in this row, so they belong next to that control.
   */
  const [notice, setNotice] = useState<string | null>(null);

  // Grow with the content instead of scrolling inside a fixed box, which
  // is what the sidepanel composer does.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  const ready = attachments.filter((a) => a.status === 'ready');
  const uploading = attachments.some((a) => a.status === 'uploading');
  const blocked = Boolean(blockedReason);
  const hasContext = Boolean(above) || blocked || attachments.length > 0;
  const composerState = blocked
    ? 'blocked'
    : streaming
      ? stopping
        ? 'stopping'
        : 'streaming'
      : 'idle';
  const canSend =
    (Boolean(value.trim()) || ready.length > 0) &&
    !disabled &&
    !uploading &&
    !blocked;

  const submit = () => {
    if (!canSend) return;
    haptic('light');
    onSubmit();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // On a touch device the return key is a NEWLINE, always. The arrow
    // button is the only way to send.
    //
    // This is not a preference, it is the difference between the composer
    // being usable and not. A phone keyboard's return key is where your
    // thumb already is, so "Enter sends" means every paragraph break fires
    // a half-written message, and there is no Shift to hold. Desktop keeps
    // Enter-to-send because there a keyboard shortcut is faster than a
    // trip to the mouse.
    if (isTouchPrimary()) return;
    event.preventDefault();
    submit();
  };

  /*
   * Entering web mode puts the caret in the box.
   *
   * The swipe gesture itself now lives on the home screen shell (App.tsx),
   * not here -- it covers the whole screen instead of just this dock, so a
   * swipe anywhere flips the mode, not only one that starts on the
   * composer. This effect only reacts to the mode once something else has
   * already changed it.
   *
   * Otherwise switching costs two taps to do one thing. The keyboard comes
   * up with it, which is correct here: suggestions are docked directly
   * above the field, so the keyboard pushes them up rather than covering
   * them. Deliberately not the reverse -- leaving web mode does not steal
   * focus, because you may be flipping back mid-thought.
   */
  const wasSearch = useRef(false);
  useEffect(() => {
    if (mode === 'search' && !wasSearch.current) {
      // After paint, or the software keyboard does not come up.
      const t = window.setTimeout(() => textarea.current?.focus(), 60);
      wasSearch.current = true;
      return () => window.clearTimeout(t);
    }
    if (mode !== 'search') wasSearch.current = false;
  }, [mode]);

  return (
    <div
      className={`composer composer-${variant}${mode === 'search' ? ' composer-search' : ''}`}
      data-composer-surface="frosted"
      data-composer-variant={variant}
      data-composer-mode={mode || 'chat'}
      data-composer-state={composerState}
    >
      {/*
        The task list sits ON TOP of the composer, as in the desktop app.

        Wrapped so the card can react to it. With a strip present the
        composer stacks four bands -- tasks, input, controls, and the edge
        -- inside one card, and at the flat 12px rhythm that read as packed
        rather than composed. `.composer-above:empty` collapses the wrapper
        entirely, so the ordinary composer is untouched; the extra air only
        appears on the screens that need it.
      */}
      {hasContext ? (
        <section
          className="composer-context"
          data-composer-tier="context"
          aria-label="Message context"
        >
          <div className="composer-above">{above}</div>

          {blockedReason ? (
            <div className="composer-blocked-block">
              <p className="composer-blocked">{blockedReason}</p>
              {onRecover ? (
                <button
                  type="button"
                  className="question-recover"
                  disabled={Boolean(recovering)}
                  onClick={onRecover}
                >
                  {recovering ? (
                    <Spinner size={13} />
                  ) : (
                    recoverLabel || 'Continue in a new session'
                  )}
                </button>
              ) : null}
            </div>
          ) : null}

          {attachments.length ? (
            <div className="chip-row">
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.key}
                  attachment={attachment}
                  onRemove={() => onRemoveAttachment(attachment.key)}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <textarea
        ref={textarea}
        className="composer-input"
        data-composer-control="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          mode === 'search'
            ? 'Search the web'
            : streaming
              ? 'Queue a message…'
              : variant === 'home'
                ? 'Chat with Aside…'
                : 'Reply to Aside…'
        }
        rows={1}
        disabled={blocked}
        /*
         * Search mode gets the magnifier return key, and turns off the
         * corrections that fight a URL or a query. Chat wants all of them.
         */
        enterKeyHint={mode === 'search' ? 'search' : undefined}
        autoCorrect={mode === 'search' ? 'off' : undefined}
        autoCapitalize={mode === 'search' ? 'off' : undefined}
        spellCheck={mode === 'search' ? false : undefined}
      />

      {notice ? (
        <p className="composer-voice-error" role="status">
          {notice}
        </p>
      ) : null}

      <div className="composer-actions" data-composer-tier="actions">
        {/*
          A real file input, hidden behind the button. Telegram's webview is
          a normal WebView, so the OS picker (and the phone's gallery and
          camera) works exactly as it does in a browser -- no Telegram API
          involved.
        */}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          className="visually-hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            if (files.length) onAddFiles(files);
            // Reset so re-picking the same file fires change again.
            event.target.value = '';
          }}
        />
        {/*
          Attach, permission and model are hidden in search mode rather than
          disabled, because none of them mean anything to a web search and a
          greyed-out model picker still reads as "this will use a model".
          This is the one place the furniture is allowed to change: the rule
          elsewhere in this file is that it must not, and the reason is that
          a control which does nothing is worse than an absent one.
        */}
        {mode !== 'search' ? (
          <>
            <button
              type="button"
              className="round-button ghost composer-context-control"
              data-composer-control="attach"
              data-composer-group="context"
              aria-label="Attach files"
              onClick={() => {
                haptic('light');
                fileInput.current?.click();
              }}
            >
              <Plus size={17} strokeWidth={1.75} />
            </button>
          </>
        ) : null}

        {/*
          Pills sit immediately after the round buttons, with the slack
          pushed to the right of them -- the arrangement Claude's own
          composer uses. Right-aligning them (the old order) put the free
          space between the buttons and the pills, which read as two
          disconnected clusters rather than one row of controls.
        */}
        {/*
          Both screens carry the same control row. The reply composer used
          to drop the model pill and push it into a separate bottom bar,
          so sending a message visibly changed the furniture -- a different
          card, a different row, the model somewhere else. Claude's own app
          keeps one composer and only swaps the placeholder, which is why
          its thread does not feel like a second app.
        */}
        {mode !== 'search' ? (
          <Pill
            label={pills.modelLabel}
            onOpen={onOpenModel}
            mark={pills.provider}
            className="composer-context-control"
          />
        ) : null}
        <span className="composer-spacer" data-composer-spacer="true" aria-hidden="true" />

        {/*
          Dictation sits immediately to the LEFT of send, which is where
          Aside's own desktop composer puts it and where every other app
          that has both controls puts it.

          It used to live over on the left next to `+`, grouped with the
          setup controls (attach, permission, model). That grouping is
          wrong: attaching a file and choosing a model are things you do
          BEFORE composing, while dictating is composing. Putting it at the
          send end means the two ways to finish a message -- say it or send
          it -- are under the same thumb, and the thumb never crosses the
          keyboard to reach the other side of the screen.

          Deliberately AFTER the stop button rather than before it, so the
          mic stays adjacent to send even mid-turn when stop appears. A
          control that shifts position depending on whether the agent is
          talking is a control you have to look for.
        */}
        <VoiceButton
          disabled={blocked}
          onError={setNotice}
          onTranscript={(text) => {
            setNotice(null);
            // Append rather than replace: dictation is one more way to add to
            // the message, so it has to compose with whatever is already typed.
            const base = value.trimEnd();
            onChange(base ? `${base} ${text}` : text);
            textarea.current?.focus();
          }}
        />

        {/*
          One slot, two identities.

          Idle: the dark circle with the up arrow. Running: the same dark
          circle with a white rounded square in it -- the desktop's stop
          button, in the desktop's position, at the desktop's size. Nothing
          moves between the two states, so the thumb never has to hunt for
          the control, and the composer never shows a live send arrow for a
          turn that is still answering.
        */}
        {streaming ? (
          <button
            type="button"
            className="round-button send stop composer-primary-control"
            data-composer-control="stop"
            data-composer-group="primary"
            data-composer-primary="true"
            onClick={() => {
              if (stopping) return;
              if (!onStop) {
                haptic('warning');
                setNotice(
                  stopBlocked ??
                    'This turn is running in Aside on your Mac, so only the Mac can stop it.',
                );
                return;
              }
              // No confirmation sheet, deliberately. The desktop stops on
              // one tap, this is meant to match it, and a modal between the
              // tap and the kill is exactly the lag this control is here to
              // not have. `stopping` shows immediately so the tap is never
              // silent.
              haptic('medium');
              onStop();
            }}
            aria-label="Stop"
            // Genuinely disabled only while a kill is already in flight. The
            // Mac-owned case stays clickable on purpose: a dead button that
            // does nothing is the "just for decoration" failure, and the tap
            // is what surfaces the explanation.
            disabled={stopping}
            aria-disabled={!onStop}
            data-inert={onStop ? undefined : 'true'}
          >
            {stopping ? <Spinner size={16} /> : <StopSquare size={15} />}
          </button>
        ) : (
          <button
            type="button"
            className="round-button send composer-primary-control"
            data-composer-control="send"
            data-composer-group="primary"
            data-composer-primary="true"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send"
          >
            {busy ? (
              <Spinner size={16} />
            ) : (
              <ArrowUp size={17} strokeWidth={2} />
            )}
          </button>
        )}
      </div>
    </div>
  );
}


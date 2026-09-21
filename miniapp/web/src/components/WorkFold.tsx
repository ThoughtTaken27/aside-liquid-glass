/**
 * The step timeline, and the `Worked for 39m 8s ›` fold it settles into.
 *
 * The desktop app shows work as it happens: while the turn runs the steps
 * are on the page, one line each, spinners on the ones still in flight.
 * Only when the final answer starts arriving does the whole history fold
 * away into a single quiet row. That is what `live` selects between here --
 * a finished turn opens collapsed, exactly as before.
 *
 * A step can expand into its own detail. File writes and subagent spawns
 * get purpose-built cards; every other tool keeps the generic command and
 * output card. There are no per-step timestamps anywhere: the sidepanel
 * shows none.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  ChildSteps,
  CitationSource,
  FileEdit,
  WorkBlock,
  WorkStep,
  WorkText,
} from '../types';

import { summarizeSteps } from '../utils/summarizeSteps';
import { activityHeading, type WorkKind } from '../utils/activityPhase';
import { useSteadyText } from '../hooks/useSteadyText';
import { ChevronRight, Spinner, StepGlyph } from './Icons';
import { ActivityOrb } from './ActivityOrb';
import {
  ActivityMeta,
  type ActivityMetaProps,
  useActivityElapsed,
} from './ActivityMeta';
import { Markdown } from './MarkdownAsync';
import { FileCard } from './FileCard';
import { SubagentCard } from './SubagentCard';
import { haptic } from '../telegram';
import type { CitationMark } from '../utils/citations';
import { openImage } from './ImageLightbox';

const OUTPUT_CLAMP = 600;

/**
 * A diffstat, with its empty half left out.
 *
 * `+12 −0` renders a zero in the removal colour, so a pure addition is
 * reported with a red number attached to it. Red on this page means one
 * thing -- a step failed -- and spending it on "nothing was deleted" is
 * both noise and a small lie about what happened. A file that only grew
 * says `+12`, and one that only shrank says `−3`.
 */
function Diffstat({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null;
  return (
    <span className="diffstat">
      {added ? <span className="added">+{added}</span> : null}
      {added && removed ? ' ' : null}
      {removed ? <span className="removed">−{removed}</span> : null}
    </span>
  );
}

/**
 * Which folds the reader has opened or closed by hand, by block id.
 *
 * This lives outside the component on purpose. The thread is a virtualised
 * list, so a row that scrolls out of view -- or simply gets recycled when
 * a delta changes the list -- is unmounted and remounted with fresh state.
 * With the preference held in `useState` that meant a fold the reader had
 * opened silently snapped shut again a moment later, which is exactly the
 * "it collapses sometimes" behaviour. Block ids are stable across deltas,
 * so keying on them survives both recycling and a full re-render.
 *
 * A plain Map rather than storage: this is a within-session preference,
 * and a fold state restored days later would be stale and confusing.
 */
const FOLD_PINS = new Map<string, boolean>();

export interface WorkFoldProps {
  block: WorkBlock;
  /** Whose thread this is -- local image paths resolve against it. */
  sessionId: string;
  /** True while this turn is still working and no answer has begun. */
  live: boolean;
  subagentSteps: Record<string, ChildSteps>;
  onInspectSubagent: (childId: string, title: string) => void;
  sources: Record<string, CitationSource>;
  onOpenCitation: (mark: CitationMark) => void;
  /** The live run is drawn separately at the transcript tail when set. */
  detachLiveRun?: boolean;
  /** Kept for direct component fixtures; the app uses `LiveWorkTail`. */
  activity?: LiveActivity | null;
}

/** What a run in flight needs to draw itself as the live row. */
export interface LiveActivity extends ActivityMetaProps {
  /** The agent's own purpose title, already condensed for one line. */
  label: string;
  /** The current mode decides whether the heading uses purpose or voice. */
  work: WorkKind;
  /** The concrete action, when known. Preferred over the paced verb. */
  detail?: string | null;
  /** Stable per turn, so verb rotation is paced rather than random. */
  seed?: string;
}

/*
 * (`dominantIcon` lived here: it picked the run's most common tool icon
 * to lead the summary row, breaking ties against the server's `dot`
 * fallback so a real tool always won. The summary row no longer carries a
 * glyph -- see the note in `StepRun` -- and the icon each step shows
 * inside an opened run comes from that step, not from a vote across the
 * run, so nothing else needed it.)
 */

function ToolDetail({ step }: { step: WorkStep }) {
  const [showAll, setShowAll] = useState(false);
  const output = step.detail?.output || '';
  const clamped = !showAll && output.length > OUTPUT_CLAMP;
  const shown = clamped ? output.slice(0, OUTPUT_CLAMP) : output;

  return (
    <div
      className={`tool-card utility-card ${step.status === 'error' ? 'is-error' : ''}`}
      data-card-group="utility"
      data-card-kind="tool"
      data-card-state={step.status}
    >
      {/*
        The head names the TOOL, not the step.

        It used to repeat `step.label` -- the exact string on the row you
        just tapped to get here, so opening a detail printed the same
        sentence twice, three lines apart, and the card's first line
        carried no information at all. The tool id is the thing the row
        does not already say.

        And the badge only appears when it failed. "Success" on every card
        is a label with no alternative in view: it costs a pill, a colour
        and a corner of attention to tell the reader that nothing happened.
        Absence is the healthy state; the rust badge is the exception, and
        an exception nobody can miss precisely because it is rare.
      */}
      <div className="tool-card-head">
        <StepGlyph icon={step.icon} size={12} />
        <span className="tool-card-title">{step.tool}</span>
        {step.status === 'error' ? (
          <span className="badge is-error">Failed</span>
        ) : null}
      </div>
      <div className="tool-card-body">
        {step.detail?.command ? (
          <pre className="tool-command">
            <span className="tool-prompt">$</span> {step.detail.command}
          </pre>
        ) : null}
        {shown ? <pre className="tool-output">{shown}</pre> : null}
        {clamped || (step.detail?.truncated && !showAll) ? (
          <button
            type="button"
            className="show-more"
            onClick={() => setShowAll(true)}
          >
            Show more
          </button>
        ) : null}
        {step.detail?.truncated && showAll ? (
          <p className="tool-note">Output truncated by the server.</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A file write or edit.
 *
 * The card stays open while the write is in flight, which is how the
 * desktop app shows one landing, and folds to its row once the result
 * arrives -- unless the reader has opened it themselves since.
 */
function FileStep({
  step,
  file,
  expandSignal,
}: {
  step: WorkStep;
  file: FileEdit;
  expandSignal: { value: boolean; n: number };
}) {
  const writing = step.status === 'pending';
  const [pinned, setPinned] = useState<boolean | null>(null);
  useEffect(() => {
    if (expandSignal.n > 0) setPinned(expandSignal.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandSignal.n]);
  const shown = pinned ?? writing;
  // In flight the row names what is happening; afterwards the built label
  // ("Wrote …", "Edited …") already reads correctly.
  const label = writing
    ? `${file.mode === 'write' ? 'Writing' : 'Editing'} ${file.name}`
    : step.label;

  return (
    <div className={`step ${shown ? 'is-open' : ''}`}>
      <button
        type="button"
        className={`step-row is-expandable ${writing ? 'is-pending' : ''}`}
        aria-expanded={shown}
        onClick={() => setPinned(!shown)}
      >
        <span className="step-icon">
          {writing ? <Spinner size={13} /> : <StepGlyph icon={step.icon} size={13} />}
        </span>
        <span className="step-label">{label}</span>
        {step.diffstat ? <Diffstat {...step.diffstat} /> : null}
        <span className="step-chevron">
          <ChevronRight size={13} />
        </span>
      </button>
      {shown ? <FileCard file={file} /> : null}
    </div>
  );
}

function StepRow({
  step,
  expandSignal,
}: {
  step: WorkStep;
  expandSignal: { value: boolean; n: number };
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(step.detail?.command || step.detail?.output);
  useEffect(() => {
    if (expandSignal.n > 0 && expandable) setOpen(expandSignal.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandSignal.n]);

  return (
    <div className={`step ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className={`step-row ${expandable ? 'is-expandable' : ''} is-${step.status}`}
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen((prev) => !prev)}
      >
        <span className="step-icon">
          {step.status === 'pending' ? (
            <Spinner size={13} />
          ) : (
            <StepGlyph icon={step.icon} size={13} />
          )}
        </span>
        <span className="step-label">{step.label}</span>
        {step.diffstat ? <Diffstat {...step.diffstat} /> : null}
        {/*
          The chevron slot is always present, even on a row that cannot
          open. Rendering it only when expandable left the right edge of
          the timeline ragged -- some rows ending at the label, some 20px
          short of it -- which reads as a layout accident rather than as a
          distinction. It is drawn only when it means something; the space
          is reserved either way, so the column is straight.
        */}
        <span className="step-chevron" aria-hidden={!expandable}>
          {expandable ? <ChevronRight size={13} /> : null}
        </span>
      </button>

      {step.images.length || step.imagesDropped ? (
        <div className="step-shots">
          {step.images.map((src, index) => (
            <button
              key={index}
              type="button"
              className="md-image-button"
              aria-label="View image"
              onClick={() => openImage({ src })}
            >
              <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
            </button>
          ))}
          {/* The server caps inline images; saying so beats quietly showing
              fewer than the tool produced. */}
          {step.imagesDropped ? (
            <p className="step-shots-note">
              {step.imagesDropped} more image
              {step.imagesDropped === 1 ? '' : 's'} not shown
            </p>
          ) : null}
        </div>
      ) : null}

      {open ? <ToolDetail step={step} /> : null}
    </div>
  );
}


/**
 * The steps of one contiguous run, revealed under its summary.
 *
 * Steps only. Prose used to render in here too, which is how a collapsed
 * fold managed to swallow the agent's own commentary -- the fold is meant
 * to hide the PROCESS, and the writing is not process.
 */
function Timeline({
  steps,
  subagentSteps,
  onInspectSubagent,
}: {
  steps: WorkStep[];
  subagentSteps: Record<string, ChildSteps>;
  onInspectSubagent: (childId: string, title: string) => void;
}) {
  /*
   * Expand / collapse all, for runs long enough that opening rows one
   * by one is a chore (the uimaxx "history expansion" instinct,
   * restrained to a single toggle). The count in the label doubles as
   * the tool-count summary: "Expand all - 8" says how much work this
   * run was before a single row opens. Rows that cannot open (no
   * detail, no file) are not counted -- offering to expand something
   * that cannot expand would be a lie in a button.
   */
  const expandable = steps.filter((item) =>
    item.subagent
      ? false
      : item.file
        ? true
        : Boolean(item.detail?.command || item.detail?.output),
  ).length;
  const [expandSignal, setExpandSignal] = useState({ value: false, n: 0 });
  const allOut = expandSignal.n > 0 && expandSignal.value;

  return (
    <div className="timeline" data-content-surface="activity-details">
      {expandable > 1 ? (
        <button
          type="button"
          className="timeline-toggle"
          onClick={() => {
            haptic('light');
            setExpandSignal((prev) => ({
              value: !(prev.n > 0 && prev.value),
              n: prev.n + 1,
            }));
          }}
        >
          {allOut ? 'Collapse all' : 'Expand all \u00b7 ' + expandable}
        </button>
      ) : null}
      {steps.map((item) => {
        if (item.subagent) {
          return (
            <SubagentCard
              key={item.id}
              spawn={item.subagent}
              steps={
                item.subagent.child
                  ? subagentSteps[item.subagent.child.id]
                  : undefined
              }
              onInspect={onInspectSubagent}
            />
          );
        }
        if (item.file) {
          return (
            <FileStep
              key={item.id}
              step={item}
              file={item.file}
              expandSignal={expandSignal}
            />
          );
        }
        return (
          <StepRow key={item.id} step={item} expandSignal={expandSignal} />
        );
      })}
    </div>
  );
}

/**
 * One run of tool calls, said in a line, openable into its detail.
 *
 * `pinKey` is the block id plus this run's index rather than the block id
 * alone. Runs are separate objects now and each remembers its own state;
 * keying them together would mean opening one opened all of them.
 */
function StepRun({
  steps,
  pinKey,
  running,
  answering = false,
  activity,
  subagentSteps,
  onInspectSubagent,
}: {
  steps: WorkStep[];
  pinKey: string;
  running: boolean;
  /**
   * The answer has started streaming while this turn still runs.
   * The row renders its settled form early -- summary sentence plus the
   * quiet measurements -- instead of the live orb and shimmer.
   */
  answering?: boolean;
  /** Set only on the run that is actually in flight. */
  activity?: LiveActivity | null;
  subagentSteps: Record<string, ChildSteps>;
  onInspectSubagent: (childId: string, title: string) => void;
}) {
  const headingId = useId();
  const [, bump] = useState(0);
  const pinned = FOLD_PINS.has(pinKey)
    ? (FOLD_PINS.get(pinKey) as boolean)
    : null;
  const setPinned = (next: boolean) => {
    FOLD_PINS.set(pinKey, next);
    bump((n) => n + 1);
  };

  const open = pinned ?? false;
  const summary = summarizeSteps(steps);
  if (!summary) return null;

  /*
   * One live heading. It names the concrete work whenever that is known,
   * and falls back to the paced verb only when it is not -- the mode the
   * agent happens to be in at this instant does not get a vote, because
   * letting it have one is what made this line flicker. Once settled, the
   * ordinary tally becomes useful again.
   */
  const live = !answering && running && activity?.label ? activity : null;
  /* Answering keeps the measurements: the turn is still active, so the
     clock and tokens are live information, not trivia. Only the live
     heading treatment -- orb, shimmer -- stands down. */
  const measured = live ?? (answering ? activity : null);
  const elapsed = useActivityElapsed(
    measured?.startedAt ?? null,
    Boolean(measured),
  );
  /* Paced while live, immediate once settled: the final tally is the
     answer to "is it done", and delaying that by a beat reads as a hang. */
  const heading = useSteadyText(
    live
      ? activityHeading(live.work, live.label, elapsed, live.seed, live.detail)
      : summary.text,
    Boolean(live),
  );

  return (
    <div
      className={`fold ${open ? 'is-open' : ''} ${running ? 'is-running' : ''} ${answering ? 'is-answering' : ''} ${live ? `is-${live.work}` : ''}`}
      data-content-surface="activity-fold"
      data-activity-state={answering ? 'answering' : running ? 'running' : 'settled'}
    >
      <button
        type="button"
        className={`fold-row ${running && !answering ? 'is-running' : ''}`}
        data-activity-role="heading"
        aria-expanded={open}
        aria-label={
          live
            ? `${open ? 'Hide' : 'Show'} work details`
            : `${heading}. ${open ? 'Hide' : 'Show'} details.`
        }
        aria-describedby={live ? headingId : undefined}
        onClick={() => {
          haptic('light');
          setPinned(!open);
        }}
      >
        {/* Settled rows remain text-only. The state-specific orb appears
            only while this is the single control for current activity. */}
        {live ? (
          <>
            <span className="activity-mark" aria-hidden="true">
              <ActivityOrb work={live.work} />
            </span>
            {/* One live phrase: an authored purpose while a tool is out,
                otherwise the paced verb for the current mode. */}
            <span
              id={headingId}
              className="fold-label"
              role="status"
              aria-live="polite"
            >
              {heading}
            </span>
          </>
        ) : (
          <span className="fold-label">
            {summary.segments.map((seg, i) => (
              <span key={i}>
                {/*
                  A real space, not a margin. Spacing these with
                  `margin-left` looked identical and read as "Read27
                  files" to anything consuming the text -- a screen
                  reader, find-in-page, or a copy. Layout must not be the
                  only thing holding a sentence apart.

                  Not before punctuation, though: pulling `(2 failed)` out
                  into its own segment left the comma after it starting
                  the next one, and a blind space produced "(2 failed) ,
                  +1 more".
                */}
                {i > 0 && !/^[,.;:)]/.test(seg.text) ? ' ' : ''}
                <span className={`fold-seg is-${seg.tone}`}>{seg.text}</span>
              </span>
            ))}
          </span>
        )}
        {/*
          One chevron that rotates, not two that swap.

          Swapping `ChevronRight` for `ChevronDown` re-mounts an SVG on
          every toggle, so the arrow cut instantly from one pose to the
          other while the panel beneath it was still opening -- two
          different speeds for one gesture. Rotating a single glyph lets
          the affordance travel with the thing it controls.
        */}
        <span className="fold-chevron" aria-hidden="true">
          <ChevronRight size={14} />
        </span>
      </button>

      {/* Measurements stay attached to the heading when details open. */}
      {measured ? (
        <ActivityMeta elapsedMs={elapsed} tokens={measured.tokens} />
      ) : null}

      {open ? (
        <Timeline
          steps={steps}
          subagentSteps={subagentSteps}
          onInspectSubagent={onInspectSubagent}
        />
      ) : null}
    </div>
  );
}

/**
 * A turn's work, as alternating prose and runs of tool calls.
 *
 * The old shape was one fold around the whole block, and it had two faults
 * that only became obvious once the summary line made folding the default.
 *
 * The first is that it hid the answer. Commentary the agent writes
 * mid-turn lives in the same block as its steps, so collapsing the block
 * collapsed the writing with it -- leaving a row of summaries and no
 * output at all. Prose renders unconditionally now; only step runs fold.
 * The fold exists to hide process, and the writing is not process.
 *
 * The second is that one fold around everything forced one summary for
 * everything, so a turn that read a file, explained itself, then ran a
 * build got a single line covering both halves. Splitting on prose gives
 * each run its own sentence where it happened, which is what the
 * reference does and reads as a narrative rather than a manifest.
 */
type Run =
  | { kind: 'steps'; steps: WorkStep[]; key: string }
  | { kind: 'text'; item: WorkText };

/** Group consecutive steps while keeping authored prose in place. */
function runsFor(block: WorkBlock): Run[] {
  const runs: Run[] = [];
  for (const item of block.items) {
    if (item.kind === 'step') {
      const last = runs[runs.length - 1];
      if (last && last.kind === 'steps') last.steps.push(item);
      else {
        runs.push({
          kind: 'steps',
          steps: [item],
          key: `${block.id}:${item.id}`,
        });
      }
    } else {
      runs.push({ kind: 'text', item });
    }
  }
  return runs;
}

export function WorkFold(props: WorkFoldProps) {
  const {
    block,
    sessionId,
    subagentSteps,
    onInspectSubagent,
    sources,
    onOpenCitation,
    activity,
    detachLiveRun = false,
  } = props;

  const runs = runsFor(block);
  const lastStepRun = runs.map((r) => r.kind).lastIndexOf('steps');
  const hasVisibleRun = runs.some(
    (run, index) =>
      !(detachLiveRun && block.running && index === lastStepRun) &&
      (run.kind === 'text' || run.steps.length > 0),
  );
  if (!hasVisibleRun) return null;

  return (
    <div
      className={`work ${block.running ? 'is-running' : ''}`}
      data-content-surface="activity-group"
      data-activity-state={block.running ? 'running' : 'settled'}
    >
      {runs.map((run, index) =>
        detachLiveRun && block.running && index === lastStepRun ? null :
        run.kind === 'text' ? (
          <div key={run.item.id} className="work-text">
            <Markdown
              text={run.item.text}
              sources={sources}
              sessionId={sessionId}
              onOpenCitation={onOpenCitation}
            />
          </div>
        ) : (
          <StepRun
            key={run.key}
            pinKey={run.key}
            steps={run.steps}
            running={block.running && index === lastStepRun}
            /* Only the last run of a running block is in flight, so it is
               the only one that can be the live row. */
            activity={
              block.running && index === lastStepRun ? activity : null
            }
            subagentSteps={subagentSteps}
            onInspectSubagent={onInspectSubagent}
          />
        ),
      )}
    </div>
  );
}


/**
 * The current run, detached from its historical slot and mounted after
 * every visible transcript item.
 *
 * Only the live run moves. Earlier summaries and authored commentary stay
 * in chronological order, while the control for what is happening now
 * remains at the bottom as streamed answer text grows above it.
 *
 * Once the answer starts, the tail settles early (`answering`): the same
 * collapsed summary-plus-measurements row the turn will keep, instead of
 * the live orb and shimmer underneath an answer that has begun.
 */
export function LiveWorkTail({
  block,
  activity,
  answering = false,
  subagentSteps,
  onInspectSubagent,
  onLayoutChange,
}: {
  block: WorkBlock;
  activity: LiveActivity;
  answering?: boolean;
  subagentSteps: Record<string, ChildSteps>;
  onInspectSubagent: (childId: string, title: string) => void;
  onLayoutChange?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const runs = runsFor(block);
  const index = runs.map((run) => run.kind).lastIndexOf('steps');
  const run = index >= 0 ? runs[index] : null;
  useLayoutEffect(() => {
    onLayoutChange?.();
    const element = root.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => onLayoutChange?.());
    observer.observe(element);
    return () => observer.disconnect();
  }, [onLayoutChange]);

  if (!run || run.kind !== 'steps') return null;

  return (
    <div
      ref={root}
      className={`work is-running is-live-tail${answering ? ' is-answering' : ''}`}
      data-content-surface="activity-group"
      data-activity-state={answering ? 'answering' : 'running'}
    >
      <StepRun
        steps={run.steps}
        pinKey={run.key}
        running
        answering={answering}
        activity={activity}
        subagentSteps={subagentSteps}
        onInspectSubagent={onInspectSubagent}
      />
    </div>
  );
}

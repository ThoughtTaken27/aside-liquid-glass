import { requestActivityReveal } from '../utils/activityReveal';
import { Collapse } from './Collapse';
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
import {
  BookOpen,
  Brain,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  MessagesSquare,
  Search,
  SquareTerminal,
  Users,
} from 'lucide-react';
import { turnDuration } from '../utils/time';
import { ActivityOrb } from './ActivityOrb';
import {
  ActivityMeta,
  type ActivityMetaProps,
  useActivityElapsed,
} from './ActivityMeta';
import { Markdown } from './MarkdownAsync';
import { FileCard } from './FileCard';
import { SubagentLanes } from './SubagentCard';
import { haptic } from '../telegram';
import type { CitationMark } from '../utils/citations';
import { openImage } from './ImageLightbox';
import { DoneCheck, RaySpinner, RollText } from './Affect';
import { monogram, sourcesFor, type StepSource } from '../utils/stepSources';
import { openUrl } from '../utils/openUrl';

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

/**
 * Every work item this page has already drawn, by item id.
 *
 * A run's entrance is for work arriving in front of the reader. A resync,
 * a turn split, or a regroup can hand an existing fold runs under keys it
 * has not seen, and each one used to replay its rise-in at once: a burst of
 * rows blinking out and back. Items already drawn anywhere stay still.
 */
const SEEN_WORK_ITEMS = new Set<string>();
/** More arrivals than this in one update is a resync, not live work. */
const MAX_LIVE_ARRIVALS = 2;

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
  /** When the running turn began, for the ticking `Working for` row. */
  turnStartedAt?: number | null;
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
      <Collapse open={shown}><FileCard file={file} /></Collapse>
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
            <Spinner size={14} />
          ) : (
            <StepIconFor step={step} size={14} />
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

      <Collapse open={open}><ToolDetail step={step} /></Collapse>
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
}: {
  steps: WorkStep[];
  /* Subagents are drawn as lanes outside the details; these stay in the
     signature so callers need not change. */
  subagentSteps?: Record<string, ChildSteps>;
  onInspectSubagent?: (childId: string, title: string) => void;
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
          onClick={(event) => {
            haptic('light');
            requestActivityReveal(event.currentTarget, !allOut);
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
        // Subagents are drawn as lanes under the run, always in view;
        // repeating them inside its details would say it twice.
        if (item.subagent) return null;
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
 * The glyph a run of steps is led by, as on the desktop.
 *
 * The desktop picks one representative step per group and draws its
 * tool's icon in a 24px column at the start of the row. The first step
 * leads here for the same reason the summary sentence starts with it: the
 * icon and the first clause should name the same thing.
 */
/** The subagents a run spawned, in spawn order. */
function spawnsOf(steps: WorkStep[]) {
  return steps.flatMap((step) => (step.subagent ? [step.subagent] : []));
}

function glyphFor(step: WorkStep) {
  const tool = step.tool;
  if (step.subagent || tool === 'subagent' || tool === 'subagent_wait') return Users;
  if (tool === 'message_agent') return MessagesSquare;
  if (tool === 'read_file' && /\bskill\b/i.test(step.label)) return BookOpen;
  if (tool === 'edit_file' || tool === 'write_file') return FilePen;
  if (tool === 'read_file') return FileText;
  if (tool === 'bash') return SquareTerminal;
  if (tool === 'websearch') return Search;
  if (tool === 'memory_search') return Brain;
  if (tool === 'webfetch' || tool === 'openTab' || tool === 'repl') return Globe;
  if (tool === 'write_todos') return ListTodo;
  return null;
}

/** One icon vocabulary for a group row and the steps inside it. */
function StepIconFor({ step, size }: { step: WorkStep; size: number }) {
  const Glyph = glyphFor(step);
  return Glyph ? <Glyph size={size} strokeWidth={1.75} aria-hidden /> : <StepGlyph icon={step.icon} size={size} />;
}

function RunGlyph({ steps }: { steps: WorkStep[] }) {
  const lead = steps[0];
  const Glyph = lead ? glyphFor(lead) : null;
  return (
    <span className="run-glyph" aria-hidden="true">
      {Glyph ? (
        <Glyph size={16} strokeWidth={1.75} />
      ) : lead ? (
        <StepGlyph icon={lead.icon} size={16} />
      ) : null}
    </span>
  );
}

/** A run's edits summed, so "Edited 2 files" can carry its +/- like the desktop. */
function runDiffstat(steps: WorkStep[]): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  for (const step of steps) {
    if (!step.diffstat) continue;
    added += step.diffstat.added;
    removed += step.diffstat.removed;
  }
  return added || removed ? { added, removed } : null;
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
  fallbackPinKey,
  running,
  answering = false,
  activity,
  clockAbove = false,
  inTimeline = false,
  showSources = false,
  fresh = false,
  liveLabel = null,
  active = false,
  subagentSteps,
  onInspectSubagent,
}: {
  steps: WorkStep[];
  pinKey: string;
  fallbackPinKey?: string;
  running: boolean;
  /** Drawn as a node of the turn's timeline: the node carries the glyph. */
  inTimeline?: boolean;
  /** Draw the sites this run read as chips under its row. */
  showSources?: boolean;
  /** Arrived while the reader watched; its source chips pop in. */
  fresh?: boolean;
  /** The step in flight, said on the run's own row while the turn works. */
  liveLabel?: string | null;
  /** The newest node of a live turn: says its latest step, glowing. */
  active?: boolean;
  /**
   * The answer has started streaming while this turn still runs.
   * The row renders its settled form early -- summary sentence plus the
   * quiet measurements -- instead of the live orb and shimmer.
   */
  answering?: boolean;
  /** Set only on the run that is actually in flight. */
  activity?: LiveActivity | null;
  /** The turn's `Working for` row is on screen with the clock in it. */
  clockAbove?: boolean;
  subagentSteps: Record<string, ChildSteps>;
  onInspectSubagent: (childId: string, title: string) => void;
}) {
  const headingId = useId();
  const [, bump] = useState(0);
  const pinned = FOLD_PINS.has(pinKey)
    ? (FOLD_PINS.get(pinKey) as boolean)
    : fallbackPinKey && FOLD_PINS.has(fallbackPinKey) ? FOLD_PINS.get(fallbackPinKey)! : null;
  const setPinned = (next: boolean) => {
    FOLD_PINS.set(pinKey, next);
    bump((n) => n + 1);
  };

  const open = pinned ?? false;
  const summary = summarizeSteps(steps);
  const diff = runDiffstat(steps);
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
  /* In the timeline the row's words always pass through one roll: the
     latest step while this is the active node (paced, so steps landing
     fast cannot strobe), then once, the summary. */
  const latestStep =
    [...steps].reverse().find((step) => step.status === 'pending') ?? steps[steps.length - 1];
  const timelineLabel = useSteadyText(active ? latestStep.label : summary.text, active);
  const plainSummary = !summary.segments.some((seg) => seg.tone === 'warn');

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
        onClick={(event) => {
          haptic('light');
          requestActivityReveal(event.currentTarget, !open);
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
              <RollText text={heading} shine />
            </span>
          </>
        ) : (
          liveLabel ? (
            <span className="fold-label is-live-label" role="status" aria-live="polite">
              <RollText text={liveLabel} shine />
            </span>
          ) : inTimeline && (active || plainSummary) ? (
            <>
              <span className="fold-label tl-label" role={active ? 'status' : undefined}>
                <RollText text={timelineLabel} shine={active} />
              </span>
              {!active && diff ? <Diffstat {...diff} /> : null}
            </>
          ) : (
          <>
          {inTimeline ? null : <RunGlyph steps={steps} />}
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
          {diff ? <Diffstat {...diff} /> : null}
          </>
          )
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
      {/* Under a `Working for` row the clock is already said; a token count
          alone on its own line is noise, so the bar stays one line. */}
      {measured && !clockAbove ? (
        <ActivityMeta elapsedMs={elapsed} tokens={measured.tokens} />
      ) : null}

      {(inTimeline || showSources) && !live ? <SourceChips steps={steps} fresh={fresh} /> : null}

      <Collapse open={open}>
        <Timeline
          steps={steps}
          subagentSteps={subagentSteps}
          onInspectSubagent={onInspectSubagent}
        />
      </Collapse>
    </div>
  );
}

/**
 * The sites a run read, as chips under its row (Thinking State's
 * "Searched" list). Four at most before a `+N more` that opens the rest in
 * place. A letter tile stands in for the favicon: nothing is requested to
 * draw one, so no third party learns what was read.
 */
const SOURCE_PINS = new Map<string, boolean>();
function SourceChips({ steps, fresh }: { steps: WorkStep[]; fresh: boolean }) {
  const sources = sourcesFor(steps);
  const key = steps[0]?.id ?? '';
  const [, bump] = useState(0);
  // Chips that land after this row is on screen pop in on their own; the
  // ones it mounted with only do so when the whole row is new.
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null) initial.current = new Set(sources.map((x) => x.host));
  if (!sources.length) return null;
  const all = SOURCE_PINS.get(key) ?? false;
  const shown: StepSource[] = all || sources.length <= 4 ? sources : sources.slice(0, 3);
  const hidden = sources.length - shown.length;
  return (
    <div className={`tl-sources ${fresh ? 'is-fresh' : ''}`} role="list" aria-label="Sources">
      {shown.map((source, i) => (
        <a
          key={source.host}
          role="listitem"
          className={`tl-source${initial.current!.has(source.host) ? '' : ' is-new'}`}
          href={source.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ ['--i' as string]: i }}
          onClick={(event) => {
            event.preventDefault();
            haptic('light');
            void openUrl(source.url);
          }}
        >
          <span className="tl-favicon" aria-hidden="true">{monogram(source.host)}</span>
          <span className="tl-source-label">{source.host}</span>
        </a>
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          className="tl-source tl-more"
          style={{ ['--i' as string]: shown.length }}
          onClick={() => {
            haptic('light');
            SOURCE_PINS.set(key, true);
            bump((n) => n + 1);
          }}
        >
          +{hidden} more
        </button>
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
  | { kind: 'steps'; steps: WorkStep[]; key: string; fallbackPinKey: string }
  | { kind: 'text'; item: WorkText };

/** Group consecutive steps while keeping authored prose in place. */
function runsFor(block: WorkBlock): Run[] {
  const runs: Run[] = [];
  let legacyGroupKey = '';
  for (const item of block.items) {
    if (item.kind === 'step') {
      const last = runs[runs.length - 1];
      if (!last || last.kind !== 'steps') legacyGroupKey = `${block.id}:${item.id}`;
      // Agent cards are chronological events, not a footer for the run.
      if (last?.kind === 'steps' && Boolean(last.steps[0].subagent) === Boolean(item.subagent)) last.steps.push(item);
      else {
        runs.push({
          kind: 'steps',
          steps: [item],
          key: `${block.id}:${item.id}`,
          fallbackPinKey: legacyGroupKey,
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
    live,
    subagentSteps,
    onInspectSubagent,
    sources,
    onOpenCitation,
    turnStartedAt = null,
  } = props;

  const runs = runsFor(block);
  const lastStepRun = runs.map((r) => r.kind).lastIndexOf('steps');
  const hasSteps = lastStepRun >= 0;

  /*
   * The desktop's turn fold, rebuilt from its shipped code.
   *
   * A turn splits at its LAST group of steps: everything up to and
   * including it is the work, and folds away under one `Worked for 39m 0s`
   * row; whatever the agent wrote after it stays in view. While the turn is
   * still working and its answer has not begun, the fold is open and the
   * row reads `Working for`, ticking. The moment the answer starts, or once
   * the turn is over, it closes. A reader's own tap wins over both.
   *
   * A block with no steps has nothing to fold: its prose is all in view.
   */
  const tailFrom = hasSteps && !live ? lastStepRun + 1 : runs.length;
  const folded = hasSteps ? runs.slice(0, tailFrom) : [];
  const visible = hasSteps ? runs.slice(tailFrom) : runs;

  const pinKey = `turn:${block.id}`;
  const [, bump] = useState(0);
  const pinned = FOLD_PINS.has(pinKey) ? (FOLD_PINS.get(pinKey) as boolean) : null;
  /*
   * As the desktop does it: while the turn works there is no summary row
   * and nothing to open -- the timeline is simply on the page, growing,
   * with the run in flight saying what it is doing on its own row. Once
   * the answer starts (or the turn ends) the whole history folds under
   * one `Worked for …` row, closed unless the reader opens it.
   */
  const open = hasSteps && (live || (pinned ?? false));

  const elapsed = useActivityElapsed(turnStartedAt, block.running);
  const duration = block.running ? elapsed : block.durationMs;
  // The desktop hides the row for a turn that took under a second.
  const showRow =
    hasSteps && !live && (block.running || !duration || duration >= 1000);

  // Mounted on first open and kept, so closing can animate.
  const [everOpen, setEverOpen] = useState(open);
  useEffect(() => {
    if (open) setEverOpen(true);
  }, [open]);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (body.current) body.current.inert = !open;
  }, [open]);

  /*
   * Which runs were already here when this turn mounted. Anything that
   * arrives later arrived while the reader watched, and only that gets an
   * entrance: a turn the virtual list remounts on scroll stays still.
   */
  const runId = (run: Run) => (run.kind === 'steps' ? run.steps[0].id : run.item.id);
  const knownRuns = useRef<Set<string> | null>(null);
  const freshRuns = useRef<Set<string>>(new Set());
  if (knownRuns.current === null) knownRuns.current = new Set(runs.map(runId));
  const arrivals = runs.map(runId).filter((id) => !knownRuns.current!.has(id));
  if (arrivals.length) {
    const unseen = arrivals.filter((id) => !SEEN_WORK_ITEMS.has(id));
    if (unseen.length <= MAX_LIVE_ARRIVALS) unseen.forEach((id) => freshRuns.current.add(id));
    arrivals.forEach((id) => knownRuns.current!.add(id));
  }
  useEffect(() => {
    for (const run of runs) SEEN_WORK_ITEMS.add(runId(run));
  });
  const isFresh = (run: Run) => freshRuns.current.has(runId(run));

  /* The header's own words change once, live to settled; that change
     rises out of a blur. Mount does not. */
  const [titleFresh, setTitleFresh] = useState(false);
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current !== live) setTitleFresh(true);
    wasLive.current = live;
  }, [live]);

  /* The turn finishing in front of the reader is the one moment the check
     pops and draws; a finished turn loaded from history shows it still. */
  const wasRunning = useRef(block.running);
  const [finishedNow, setFinishedNow] = useState(false);
  useEffect(() => {
    if (wasRunning.current && !block.running) setFinishedNow(true);
    wasRunning.current = block.running;
  }, [block.running]);

  /*
   * Thinking State's rule: a node, once placed, stays. While the turn works
   * the newest node is the active one -- that is the whole live status --
   * and the active state only ever moves forward as new nodes arrive. No
   * node appears and vanishes between steps, so nothing can flicker.
   */
  const activeIndex = live ? runs.length - 1 : -1;

  const renderNode = (run: Run, index: number) => {
    const fresh = isFresh(run);
    const active = index === activeIndex;
    const cls = `tl-item${fresh ? ' is-fresh' : ''}${active ? ' is-active' : ''}`;
    if (run.kind === 'text') {
      return (
        <li key={run.item.id} className={cls} data-kind="note">
          <span className="tl-node" aria-hidden="true">
            <span className="tl-dot" />
          </span>
          <div className="tl-content work-text">
            <Markdown
              text={run.item.text}
              sources={sources}
              sessionId={sessionId}
              onOpenCitation={onOpenCitation}
            />
          </div>
        </li>
      );
    }
    return (
      <li key={run.key} className={cls} data-kind={run.steps[0].subagent?'agents':'run'}>
        <span className="tl-node" aria-hidden="true">
          <GlyphSwap active={active} steps={run.steps} />
        </span>
        <div className="tl-content">
          {run.steps[0].subagent ? <SubagentLanes
            spawns={spawnsOf(run.steps)}
            subagentSteps={subagentSteps}
            onInspect={onInspectSubagent}
            fresh={fresh}
          /> : <StepRun
            pinKey={run.key}
            fallbackPinKey={run.fallbackPinKey}
            steps={run.steps}
            running={false}
            activity={null}
            inTimeline
            active={active}
            fresh={fresh}
            subagentSteps={subagentSteps}
            onInspectSubagent={onInspectSubagent}
          />}
        </div>
      </li>
    );
  };

  const renderLoose = (run: Run, index: number) =>
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
      renderNode(run, index)
    );

  if (!runs.length) return null;

  const settled = !live && !block.running;

  return (
    <div
      className={`work turn ${block.running ? 'is-running' : ''} ${open ? 'is-open' : ''} ${live ? 'is-live' : ''}`}
      data-content-surface="activity-group"
      data-activity-state={block.running ? 'running' : 'settled'}
    >
      {showRow ? (
        <button
          type="button"
          className="turn-row"
          aria-expanded={open}
          onClick={(event) => {
            haptic('light');
            requestActivityReveal(event.currentTarget, !open);
            FOLD_PINS.set(pinKey, !open);
            bump((n) => n + 1);
          }}
        >
          {/* The chevron sits in the node column, so the header's words
              line up with every step beneath them. */}
          <span className="turn-row-chevron" aria-hidden="true">
            <ChevronRight size={16} />
          </span>
          <span className={`turn-row-label ${titleFresh ? 'is-fresh' : ''}`}>
            Worked for{' '}
            <span className="turn-row-time">
              {duration ? turnDuration(duration) : 'a moment'}
            </span>
          </span>
        </button>
      ) : null}

      {folded.length ? (
        <div
          ref={body}
          className="turn-body"
          data-open={open ? 'true' : 'false'}
          // Opened or closed by the app, not the reader: see affect.css.
          data-auto={pinned === null ? 'true' : undefined}
          aria-hidden={!open}
        >
          <div className="turn-body-inner">
            {everOpen || open ? (
              <ol className="tl" aria-live={live ? 'polite' : undefined}>
                {folded.map((run, i) => renderNode(run, i))}
                {settled ? (
                  <li className={`tl-item ${finishedNow ? 'is-fresh' : ''}`} data-kind="done">
                    <span className="tl-node" aria-hidden="true">
                      <DoneCheck animate={finishedNow} />
                    </span>
                    <span className="tl-content tl-done-label">Done</span>
                  </li>
                ) : null}
              </ol>
            ) : null}
          </div>
        </div>
      ) : null}

      {visible.map((run, i) => renderLoose(run, i + folded.length))}
    </div>
  );
}

/**
 * A run's node glyph: rays while it is the active node, its tool icon
 * otherwise. The swap cross-fades, and only when the state really changes.
 */
function GlyphSwap({ active, steps }: { active: boolean; steps: WorkStep[] }) {
  const first = useRef(active);
  const changed = first.current !== active;
  return (
    <span key={active ? 'live' : 'idle'} className={`tl-glyph-swap${changed ? ' is-changed' : ''}`}>
      {active ? <RaySpinner size={14} /> : <RunGlyph steps={steps} />}
    </span>
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
        /* The tail exists only for a run with steps, so its turn always
           has a `Working for` row above, ticking the same clock. */
        clockAbove
        subagentSteps={subagentSteps}
        onInspectSubagent={onInspectSubagent}
      />
    </div>
  );
}

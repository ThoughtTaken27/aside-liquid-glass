import type { WorkItem, WorkStep } from '../types';

/**
 * A run of tool calls, said in one sentence.
 *
 * The collapsed row used to read `Worked for 39m 8s`, and the open one
 * listed every call: ten rows of icon, label, diffstat and chevron for
 * what the reference says in five words. Duration is the one fact about a
 * finished turn that cannot be acted on -- it is over, and it took as long
 * as it took -- so spending the only always-visible line on it, and then
 * ten more on the detail, gets the priority exactly backwards.
 *
 * `Read a file, ran 2 commands` answers the question a reader actually
 * has, in the width of a phone, with the detail one tap behind it.
 *
 * Three shapes, all taken from the reference:
 *   one step, named target   ->  Read 00-Self
 *   several                  ->  Read a file, ran 2 commands
 *   with failures            ->  Read 4 files (1 failed), ran a command
 */
export interface SummarySegment {
  text: string;
  /**
   * `lead` takes the accent, `mono` a code face, `muted` the quiet ink,
   * `warn` the rust used for a run that lost a step.
   */
  tone: 'lead' | 'muted' | 'mono' | 'warn';
}

export interface StepSummary {
  segments: SummarySegment[];
  /** The whole line as plain text, for aria and for tests. */
  text: string;
  count: number;
  failed: number;
}

interface Bucket {
  /** Index of the first step in this bucket; orders the clauses. */
  seen: number;
  n: number;
  failed: number;
  verb: string;
  one: string;
  many: string;
  /** Phrasing that ignores the count, e.g. "searched the web". */
  fixed?: string;
}

/**
 * Which bucket a step falls in.
 *
 * Keyed on the tool name rather than the icon, because the icon
 * deliberately collapses distinctions this sentence needs: writing a file,
 * editing one and reading one all draw the same page glyph, and "wrote 3
 * files" against "read 3 files" is the whole difference between a turn
 * that changed the machine and one that only looked at it.
 */
function bucketFor(step: WorkStep): Omit<Bucket, 'seen' | 'n' | 'failed'> | null {
  if (step.subagent) return { verb: 'ran', one: 'subagent', many: 'subagents' };
  switch (step.tool) {
    case 'read_file':
      return { verb: 'read', one: 'file', many: 'files' };
    case 'write_file':
      return { verb: 'wrote', one: 'file', many: 'files' };
    case 'edit_file':
      return { verb: 'edited', one: 'file', many: 'files' };
    case 'bash':
      return { verb: 'ran', one: 'command', many: 'commands' };
    case 'repl':
      return { verb: 'ran', one: 'script', many: 'scripts' };
    case 'openTab':
    case 'webfetch':
      return { verb: 'opened', one: 'page', many: 'pages' };
    case 'websearch':
      return {
        verb: 'searched',
        one: 'search',
        many: 'searches',
        fixed: 'searched the web',
      };
    case 'memory_search':
      return {
        verb: 'searched',
        one: 'search',
        many: 'searches',
        fixed: 'searched memory',
      };
    case 'write_todos':
      return {
        verb: 'updated',
        one: 'plan',
        many: 'plans',
        fixed: 'updated the plan',
      };
    case 'subagent':
    case 'subagent_wait':
      return { verb: 'ran', one: 'subagent', many: 'subagents' };
    default:
      return null;
  }
}

/** Tools whose label ends in a filename worth setting in a code face. */
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

/** `1 -> "a command"`, `2 -> "2 commands"`. */
function quantify(n: number, one: string, many: string): string {
  // "a file" rather than "1 file". This is a sentence, not a table, and
  // the reference writes it the way a person would say it.
  return n === 1 ? `a ${one}` : `${n} ${many}`;
}

/**
 * `dropVerb` elides a verb the previous clause already said.
 *
 * Two tools can share one: bash and the REPL are both "ran", so a turn
 * using each produced "Ran 7 commands, ran 2 scripts" -- which is not how
 * anyone says it, and the repetition reads as a bug in the sentence
 * rather than as two kinds of work. English drops the second verb, so
 * this does too.
 */
function clauseOf(b: Bucket, dropVerb = false): string {
  const quantified = b.fixed
    ? b.n === 1
      ? b.fixed
      : `${b.verb} ${b.n} ${b.many}`
    : `${b.verb} ${quantify(b.n, b.one, b.many)}`;
  // A fixed phrasing is a whole clause ("searched the web"); stripping its
  // verb would leave "the web", so only counted clauses can elide.
  const base =
    dropVerb && !b.fixed
      ? quantify(b.n, b.one, b.many)
      : quantified;
  // Failures ride inside the clause they belong to, as the reference does
  // it. A turn that read four files and lost one did not do the same thing
  // as a turn that read four, and the summary is the only place that says
  // so without opening the timeline.
  return b.failed > 0 ? `${base} (${b.failed} failed)` : base;
}

/**
 * Splits a finished line into segments, pulling any `(n failed)` out so it
 * can be inked separately.
 *
 * The failure used to recolour the LEAD verb instead, which was wrong on
 * two counts. It conflated two unrelated facts -- what kind of work this
 * was, and whether it succeeded -- into one word, so the accent stopped
 * meaning "read" and started meaning "read, badly". And it put a signal
 * red into a warm palette, where it reads as breakage rather than as a
 * note. The verb keeps its clay; only the count is tinted.
 */
function segmentise(line: string): SummarySegment[] {
  const { lead, rest } = splitLead(line);
  const segments: SummarySegment[] = [{ text: lead, tone: 'lead' }];
  if (!rest) return segments;

  const pattern = /\((?:\d+ )?failed\)/g;
  let cursor = 0;
  for (const match of rest.matchAll(pattern)) {
    const at = match.index ?? 0;
    const before = rest.slice(cursor, at).trimEnd();
    if (before) segments.push({ text: before, tone: 'muted' });
    segments.push({ text: match[0], tone: 'warn' });
    cursor = at + match[0].length;
  }
  const tail = rest.slice(cursor).replace(/^[ ]+/, '');
  if (tail) segments.push({ text: tail, tone: 'muted' });
  return segments;
}

/*
 * Budgeted by length, not by clause count.
 *
 * A fixed cap of two was the first fix for "Read 27 files, searched
 * memory, 110 more steps (3 failed)" -- a real turn here, which wrapped
 * to three lines and stopped being a summary somewhere in the middle.
 * But a fixed cap also throws away clauses that would have fitted
 * comfortably: "Read a file, edited a file, wrote a file" is 39
 * characters, entirely legible, and strictly more useful than the same
 * line ending in "+1 more".
 *
 * The thing actually being protected is the LINE, so the line is what
 * gets measured. 52 characters is about two comfortable rows at 15px on
 * a 393px screen.
 */
const LINE_BUDGET = 52;

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Splits `"Read 00-Self"` into its verb and the rest. */
function splitLead(text: string): { lead: string; rest: string } {
  const space = text.indexOf(' ');
  if (space === -1) return { lead: text, rest: '' };
  return { lead: text.slice(0, space), rest: text.slice(space + 1) };
}

export function summarizeSteps(items: WorkItem[]): StepSummary | null {
  const steps = items.filter((i): i is WorkStep => i.kind === 'step');
  if (steps.length === 0) return null;

  const failed = steps.filter((s) => s.status === 'error').length;

  /*
   * One step names what it touched.
   *
   * "Read a file" is a worse sentence than "Read 00-Self" and strictly
   * less informative, and the label the server already builds is exactly
   * the second one. Generalising a single concrete action into a category
   * is the kind of summarising that only looks tidy.
   */
  if (steps.length === 1) {
    const only = steps[0];
    const { lead, rest } = splitLead(only.label);
    const segments: SummarySegment[] = [{ text: lead, tone: 'lead' }];
    if (rest) {
      segments.push({
        text: rest,
        tone: FILE_TOOLS.has(only.tool) ? 'mono' : 'muted',
      });
    }
    if (failed > 0) segments.push({ text: '(failed)', tone: 'warn' });
    return {
      segments,
      text: [only.label, failed > 0 ? '(failed)' : ''].filter(Boolean).join(' '),
      count: 1,
      failed,
    };
  }

  const buckets = new Map<string, Bucket>();
  let unknown = 0;
  let unknownFailed = 0;

  steps.forEach((step, index) => {
    const shape = bucketFor(step);
    const isError = step.status === 'error';
    if (!shape) {
      unknown += 1;
      if (isError) unknownFailed += 1;
      return;
    }
    // Keyed by the phrasing, so "wrote a file" and "edited a file" stay
    // separate clauses while two bash calls merge into one.
    const key = shape.fixed || `${shape.verb} ${shape.many}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.n += 1;
      if (isError) existing.failed += 1;
    } else {
      buckets.set(key, { ...shape, seen: index, n: 1, failed: isError ? 1 : 0 });
    }
  });

  /*
   * Ordered by when each kind of work first happened.
   *
   * Sorting by count would read as a ranking and quietly misdescribe the
   * turn -- "ran 5 commands, read a file" when the read came first and
   * caused the rest. First-appearance order tells it in the order it
   * happened, which is the only order that needs no explaining.
   */
  const ordered = [...buckets.values()].sort((a, b) => a.seen - b.seen);

  const clauses: string[] = [];
  let used = 0;
  let dropped = 0;

  let lastVerb = '';

  ordered.forEach((bucket, index) => {
    /*
     * Elide a repeated verb only in front of a count.
     *
     * "Ran 7 commands, 2 scripts" is how the list is said out loud. "Ran
     * a subagent, a command" is grammatical and still reads clipped --
     * the article wants its verb back. The number carries the clause on
     * its own; the article does not.
     */
    const clause = clauseOf(bucket, bucket.verb === lastVerb && bucket.n > 1);
    // The first clause always goes in, however long: a summary with no
    // verb is not a summary.
    const fits = index === 0 || used + clause.length + 2 <= LINE_BUDGET;
    if (fits && dropped === 0) {
      clauses.push(clause);
      used += clause.length + 2;
      lastVerb = bucket.verb;
    } else {
      // Once one clause has been dropped every later one goes into the
      // remainder too, so the sentence never skips a kind of work and
      // then names a later one -- which would imply the skipped work
      // did not happen.
      dropped += bucket.n;
    }
  });

  const remainder = dropped + unknown;
  // The remainder carries no failure count of its own: the lead is
  // already inked red when anything failed, and a second bracketed
  // number in the same line reads as noise rather than as detail.
  if (remainder > 0) clauses.push(`+${remainder} more`);
  void unknownFailed;

  if (clauses.length === 0) {
    clauses.push(`${steps.length} steps`);
  }

  const text = capitalise(clauses.join(', '));

  return {
    segments: segmentise(text),
    text,
    count: steps.length,
    failed,
  };
}

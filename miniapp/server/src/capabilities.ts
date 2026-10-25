/**
 * "How Next stays safe": what each part can read, can do, and never does,
 * and what actually enforces each rule.
 *
 * This is written in code, next to the code it describes, so the phone
 * screen cannot drift from a marketing page. The one rule for editing it:
 * be honest about `how`.
 *
 *  - 'code'        this server refuses it; no model output can change that.
 *  - 'aside'       Aside itself refuses it: per-session rules the daemon
 *                  checks on every tool call, page open, and request.
 *  - 'instruction' only the agent's instructions say so. A model can
 *                  ignore an instruction, which is why the dangerous
 *                  things also have a 'code' or 'aside' rule behind them
 *                  where one exists, and why the rest are labelled plainly.
 */

export type EnforcedHow = 'code' | 'aside' | 'instruction';

export interface Capability {
  id: string;
  name: string;
  model: string;
  reads: string[];
  can: string[];
  never: string[];
  enforcedBy: Array<{ rule: string; how: EnforcedHow }>;
}

const CLAUDE_FAMILY = /claude-(haiku|sonnet|opus|fable)-(\d+)(?:[-.](\d+))?(?![\d])/i;

function claudeName(id: string): string | null {
  const m = CLAUDE_FAMILY.exec(id);
  if (!m) return null;
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  // A trailing date stamp (20251001) is not a minor version.
  const minor = m[3] && m[3].length <= 2 ? `.${m[3]}` : '';
  return `Claude ${family} ${m[2]}${minor}`;
}

/** A model id as he would say it, with who runs it and what they keep. */
export function prettyModel(model: string | null | undefined): string {
  if (!model || !model.trim()) return 'Not set';
  const full = model.trim();
  const slash = full.indexOf('/');
  const provider = slash > 0 ? full.slice(0, slash).toLowerCase() : '';
  const id = slash > 0 ? full.slice(slash + 1) : full;
  const lower = id.toLowerCase();

  const claude = claudeName(id);
  if (claude) {
    if (provider.startsWith('bedrock')) return `${claude} (AWS Bedrock)`;
    if (provider === 'claude-code' || provider === 'anthropic') return `${claude} (your Claude plan)`;
    if (provider) return `${claude} (via ${provider})`;
    return claude;
  }
  if (lower.includes('space-bunny')) return 'Space Bunny (retention not verified)';
  if (lower.includes('jev')) return 'Jev (retention not verified)';
  if (lower.includes('muse-spark')) {
    const v = /muse-spark-(\d+(?:\.\d+)?)/.exec(lower)?.[1];
    return `Muse Spark${v ? ` ${v}` : ''} (free; Meta may train on what it reads)`;
  }
  if (lower.includes('mimo')) return 'MiMo (free; inputs may be used to improve it)';
  if (lower.includes('big-pickle')) return 'Big Pickle (free; inputs may be used to improve it)';
  const last = id.split('/').pop() || id;
  return provider ? `${last} (${provider})` : last;
}

/**
 * The only two things that ever start without a tap. Shown on the phone
 * above the parts list.
 */
export const AUTOMATIC = [
  'Reads your school email on a schedule and sorts it. It has no tools.',
  'Gets locked browsers ready in the background. They wait idle until you tap.',
  'Nothing else starts until you tap.',
];

export function capabilities(cfg: { mailModel: string | null; agentModel: string | null; gateModel?: string | null }): Capability[] {
  const agent = prettyModel(cfg.agentModel);
  const gate: Capability[] = cfg.gateModel
    ? [
        {
          id: 'gate',
          name: 'Email first look',
          model: prettyModel(cfg.gateModel),
          reads: ['School email, one message at a time'],
          can: ['Skip mail with nothing for you', 'Flag text that tries to give orders to an AI'],
          never: ['Write text of any kind', 'Open links, browse, or act'],
          enforcedBy: [
            { rule: 'Can only answer yes/no with a number; it cannot write', how: 'code' },
            { rule: 'Unsure mail still goes to the sorter', how: 'code' },
            { rule: 'If any check fails, the email waits locally for retry', how: 'code' },
          ],
        },
      ]
    : [];
  return [
    ...gate,
    {
      id: 'sorter',
      name: 'Email sorter',
      model: prettyModel(cfg.mailModel),
      reads: ['School email, one message at a time', 'Names, emails, phone numbers and links are removed first'],
      can: ['Label an email as a task, a notice, or nothing', 'Write one short line on what it asks'],
      never: ['Open links or browse', 'Send, reply, delete or save anything', 'Act on anything'],
      enforcedBy: [
        { rule: 'Private mail is skipped before either model; failed safety checks wait', how: 'code' },
        { rule: 'Has no tools at all: it can only return text', how: 'code' },
        { rule: 'Its answer must match a fixed shape or it is thrown away', how: 'code' },
        { rule: 'Anything that looks like a trick or phishing is flagged, not acted on', how: 'code' },
        { rule: 'Email text never reaches a helper, only a link checked against the sender', how: 'code' },
      ],
    },
    {
      id: 'drafter',
      name: 'Reply writer',
      model: prettyModel(cfg.mailModel),
      reads: ['The one email you asked it to answer'],
      can: ['Write a reply for you to edit on your phone'],
      never: ['Send or save anything', 'Browse or open links', 'Write for a flagged email'],
      enforcedBy: [
        { rule: 'Has no tools: it can only return text', how: 'code' },
        { rule: 'You copy and send the reply yourself', how: 'code' },
        { rule: 'Fresh private, flagged, or unchecked emails never reach the writer', how: 'code' },
      ],
    },
    {
      id: 'planner',
      name: 'Planner',
      model: 'No model: plain arithmetic',
      reads: ['Your projects, their steps, deadlines and time estimates'],
      can: ['Order steps backward from each deadline', "Warn when a plan won't fit before the deadline"],
      never: ['Call a model', 'Read email or web pages', "Change a plan you didn't approve"],
      enforcedBy: [
        { rule: 'Plain date math on your saved plan; same input, same answer', how: 'code' },
        { rule: 'Every suggested change waits for your OK', how: 'code' },
      ],
    },
    {
      id: 'inspector',
      name: 'Progress checker',
      model: agent,
      reads: ['Your notes', 'Your Common App and Google Docs, read only'],
      can: ['Say where a project stands', 'Suggest the steps left, for your OK'],
      never: ["Click, type, sign in, or submit", 'Send anything out', 'Change a plan by itself'],
      enforcedBy: [
        { rule: 'Starts only when you tap Check progress', how: 'code' },
        { rule: 'Aside blocks clicks, typing, and page scripts', how: 'aside' },
        { rule: 'Aside keeps it to Common App and Google Docs; nothing goes out', how: 'aside' },
        { rule: 'Runs only in a locked browser; never without those blocks', how: 'code' },
      ],
    },
    {
      id: 'web',
      name: 'Web researcher',
      model: agent,
      reads: ['Public web pages and search results', 'A few eligibility facts you set'],
      can: ['Answer a question or check an opportunity, with sources'],
      never: ["See your files, notes, or logins", "Click, type, sign in, or submit", 'Act on anything'],
      enforcedBy: [
        { rule: 'Starts only when you tap Look into this', how: 'code' },
        { rule: 'Aside blocks the browser, your files, notes, and signed-in fetches', how: 'aside' },
        { rule: 'Aside blocks commands, file changes, and downloads', how: 'aside' },
        { rule: 'Runs only in a locked browser; never without those blocks', how: 'code' },
      ],
    },
    {
      id: 'reader',
      name: 'Page reader',
      model: agent,
      reads: ['One site you are signed in to, like Schoology, read only'],
      can: ['Sum up instructions, rubrics, files, and form questions'],
      never: ["Click, type, sign in, or submit", 'Visit any other site', 'Act on anything'],
      enforcedBy: [
        { rule: 'Starts only when you tap Look into this', how: 'code' },
        { rule: 'Aside blocks clicks, typing, and page scripts', how: 'aside' },
        { rule: 'Aside locks it to one site; nothing goes out', how: 'aside' },
        { rule: 'Runs only in a locked browser; never without those blocks', how: 'code' },
      ],
    },
    {
      id: 'helper',
      name: 'Task helper',
      model: 'Disabled',
      reads: [],
      can: ['Nothing until code-enforced outgoing approval is available'],
      never: ['Start a helper, fill a field, change a document, submit, or send'],
      enforcedBy: [
        { rule: 'Server refuses helper starts; a client or model cannot override it', how: 'code' },
        { rule: 'Existing waiting requests are preserved but never run', how: 'code' },
      ],
    },
  ];
}

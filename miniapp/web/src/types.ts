/** Wire types, mirroring miniapp/server/src/{thread,sessions,catalog}.ts. */

// --- raw transcript entries (live-streaming deltas only) -----------------

export type EntryKind =
  | 'user'
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'subagent';

export interface BaseEntry {
  line: number;
  part: number;
  id: string;
  ts: number | null;
}

export interface UserEntry extends BaseEntry {
  kind: 'user';
  text: string;
}
export interface AssistantTextEntry extends BaseEntry {
  kind: 'assistant_text';
  text: string;
  model?: string;
}
export interface ThinkingEntry extends BaseEntry {
  kind: 'thinking';
  text: string;
}
export interface ToolCallEntry extends BaseEntry {
  kind: 'tool_call';
  toolCallId?: string;
  name: string;
  title: string;
}
export interface ToolResultEntry extends BaseEntry {
  kind: 'tool_result';
  toolCallId?: string;
  name: string;
  isError: boolean;
  preview: string;
}
export interface SubagentEntry extends BaseEntry {
  kind: 'subagent';
  event: 'spawn' | 'wait' | 'result';
  taskId?: string;
  callId?: string;
  desc: string;
  profile?: string;
  background?: boolean;
  text?: string;
  isError?: boolean;
}

export type Entry =
  | UserEntry
  | AssistantTextEntry
  | ThinkingEntry
  | ToolCallEntry
  | ToolResultEntry
  | SubagentEntry;

// --- the thread, as the sidepanel draws it -------------------------------

export type StepIcon =
  | 'terminal'
  | 'globe'
  | 'file'
  | 'search'
  | 'list'
  | 'agent'
  | 'clock'
  | 'bell'
  | 'shield'
  | 'dot';

export interface StepDetail {
  command?: string;
  output?: string;
  truncated?: boolean;
}

/** A subagent session, joined to its spawn by `toolCallId`. */
export interface ChildSession {
  id: string;
  title: string;
  status: string;
  toolCallId: string;
  modelLabel: string | null;
  /** Provider id behind `modelLabel`, for the card's brand mark. */
  provider?: string | null;
  effort?: string | null;
  fastMode?: boolean;
  running: boolean;
  /** Daemon timestamps for honest per-agent elapsed time. */
  createdAt?: number;
  updatedAt?: number;
  /** Same palette slot as the spawn row that created it. */
  hue?: number;
}

export interface SubagentSpawn {
  callId: string;
  description: string;
  prompt: string;
  /** Palette slot for the creature, handed out server-side in spawn order. */
  hue: number;
  child?: ChildSession;
}

export interface FileEditLine {
  n: number | null;
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

export interface FileEdit {
  mode: 'write' | 'edit';
  path: string;
  name: string;
  lines: FileEditLine[];
  truncated: boolean;
}

export interface WorkStep {
  kind: 'step';
  id: string;
  icon: StepIcon;
  label: string;
  tool: string;
  status: 'success' | 'error' | 'pending';
  diffstat: { added: number; removed: number } | null;
  detail: StepDetail | null;
  images: string[];
  /** Images the server's inline caps left out; the card says so. */
  imagesDropped?: number;
  /** Set on `subagent` spawns: draw a nested agent card. */
  subagent?: SubagentSpawn;
  /** Set on file writes and edits: draw a diff card. */
  file?: FileEdit;
}

/** A subagent's own timeline, pushed as it works. */
export interface ChildSteps {
  childId: string;
  steps: WorkStep[];
  /** Total steps taken, including any older than the ones sent. */
  total: number;
  /** Actual child turn usage, never estimated by the view. */
  tokens?: number;
  /** A bounded final-answer preview for the tree's result surface. */
  summary?: string;
  /** Spawn ownership is retained independently of the sliding step tail. */
  spawns?: SubagentSpawn[];
}

export interface WorkText {
  kind: 'text';
  id: string;
  text: string;
}

export type WorkItem = WorkStep | WorkText;

export interface Attachment {
  name: string;
  mimeType?: string;
}

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  ts: number | null;
  attachments?: Attachment[];
  /** Client-only: shown immediately on send, before the transcript has it. */
  pending?: boolean;
}

export interface WorkBlock {
  kind: 'work';
  id: string;
  items: WorkItem[];
  durationMs: number;
  running: boolean;
}

export interface AnswerItem {
  kind: 'answer';
  id: string;
  text: string;
  model?: string;
  provider?: string;
  ts: number | null;
}

/** A classified failure, as `server/src/errors.ts` produces it. */
export interface ErrorAlert {
  title: string;
  description: string;
  /** The raw provider message, shown behind the card's Details button. */
  detail: string;
  tone: 'muted' | 'destructive';
}

export interface ErrorItem {
  kind: 'error';
  id: string;
  text: string;
  alert: ErrorAlert;
  ts: number | null;
}

// --- questions -----------------------------------------------------------

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionBlock {
  header: string;
  question: string;
  options: QuestionOption[];
  /** Select more than one option before advancing. */
  multiple?: boolean;
  /** Optional custom-answer row; defaults to available. */
  allowOther?: boolean;
  otherLabel?: string;
}

export interface QuestionArtifact {
  type: string;
  summary: Array<{ label: string; value: string }>;
}

/**
 * A question the agent has put to the user.
 *
 * `answerable` is the field that matters: a NATIVE pending tool
 * (`source: 'tool'`) can only be answered from the desktop sidepanel, so
 * the card renders read-only with a notice. A soft-marker question
 * (`source: 'marker'`) is answered by sending an ordinary message.
 */
export interface QuestionItem {
  kind: 'question';
  id: string;
  variant: 'ask' | 'confirm';
  source: 'tool' | 'marker';
  questions: QuestionBlock[];
  artifact?: QuestionArtifact;
  status: 'pending' | 'answered';
  answer?: string;
  answerable: boolean;
}

// --- todos ---------------------------------------------------------------

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

/**
 * The answer as it is being generated, straight off the CLI's stdout.
 *
 * Provisional: it is replaced by a real `answer` item the moment that
 * message's transcript line is written, and is never persisted.
 */
export interface StreamingItem {
  kind: 'streaming';
  id: string;
  text: string;
}

export type ThreadItem =
  | UserItem
  | WorkBlock
  | AnswerItem
  | ErrorItem
  | QuestionItem
  | StreamingItem;

/** The session's own model, as the daemon has it pinned. */
export interface ThreadModel {
  provider: string;
  modelId: string;
  label: string;
  effort: string | null;
  effortLabel: string | null;
}

/** A web source an answer's citations can point at. */
export interface CitationSource {
  id: string;
  url: string;
  title: string;
  domain: string;
  excerpt: string;
}

/** Token counters behind the context ring and the streaming footer. */
export interface ThreadStats {
  /** Newest `usage.totalTokens` -- how full the context window is. */
  totalTokens: number;
  /** Output tokens produced since the last user message. */
  turnTokens: number;
  turnStartedAt: number | null;
}

export interface ThreadResponse {
  sessionId: string;
  /**
   * Identity of these exact items on the server. The socket's first
   * subscribe sends it back so the server can tell whether the thread
   * changed between this read and the subscribe (and send it all if so).
   */
  rev?: string | null;
  title: string;
  status: string;
  /**
   * Blocked on a native question tool the desktop app alone can answer.
   * The composer disables itself on this rather than queuing a turn that
   * would hang. See `server/src/questions.ts`.
   */
  suspended: boolean;
  /**
   * Whether `suspended` has an actual question behind it that "Continue
   * in a new session" can seed from. `suspended` can be true with this
   * false: the driver that hit the native tool was reaped before the
   * write that would have produced a clean question item landed. The
   * composer's recover button uses this to know in advance rather than
   * finding out from a 409.
   */
  hasRecoverableQuestion?: boolean;
  items: ThreadItem[];
  /** The agent's task list, replayed from its `write_todos` calls. */
  todos: Todo[];
  stats: ThreadStats;
  sources: Record<string, CitationSource>;
  subagents: ChildSession[];
  subagentSteps: ChildSteps[];
  /** Set when this session is itself a subagent of another. */
  parentId: string | null;
  /** Denominator of the context ring, in tokens. */
  contextWindow: number;
  busy: boolean;
  /** True only when this mobile server owns the process and can cancel it. */
  stoppable?: boolean;
  queued: number;
  /** Messages waiting behind the running turn. Absent on older servers. */
  queue?: QueuedMessage[];
  /** Real permission mode; null means unreadable, so show nothing. */
  permission: string | null;
  /** The raw enum (`guard`, `full-access`, …) the picker checkmarks. */
  permissionMode: string | null;
  /** Whether this session is currently muted from push notifications. */
  muted: boolean;
  /**
   * What the confirm-before-acting switch shows.
   *
   * On a session driven from a phone that is this app's SOFT flag, not
   * the daemon's `runtimeConfig.finalConfirm` -- which is held at false
   * there on purpose, because it mandates the one tool that bricks a
   * mobile session. Null means unreadable.
   */
  finalConfirm: boolean | null;
  /** True when the confirm toggle means the soft protocol, not the daemon's. */
  softConfirm?: boolean;
  /** Per-session model; null means fall back to the account default. */
  model: ThreadModel | null;
}

/** A file uploaded from the phone, as the server stored it. */
export interface UploadedFile {
  /** Absolute path on the machine; passed back verbatim on send. */
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

/** A composer chip: an upload in flight, done, or failed. */
export interface ComposerAttachment {
  /** Client-side id, stable for the chip's lifetime. */
  key: string;
  name: string;
  mimeType: string;
  /** Object URL for image previews; revoked when the chip goes away. */
  previewUrl?: string;
  status: 'uploading' | 'ready' | 'failed';
  /** Set once the server has it. */
  path?: string;
  error?: string;
  /** Bytes, from the picked file. */
  size?: number;
  /** A failure another attempt could fix (network/server), not a size cap. */
  retryable?: boolean;
}

// --- session list --------------------------------------------------------

/**
 * Note what is absent: no visible id, no cost, no token count, no turn
 * count. The sidepanel shows none of those.
 */
export interface SessionRow {
  id: string;
  title: string;
  preview: string;
  status: 'running' | 'idle' | 'errored' | string;
  updatedAt: number;
  createdAt: number;
  unread: boolean;
  trigger?: string;
  /** Suspended on a native question or sitting on an unanswered soft-marker question. */
  waiting?: boolean;
}

/** A full-text hit inside a transcript body, returned by `/api/search`. */
export interface SearchHit {
  sessionId: string;
  title: string;
  /** The matching text, trimmed around the hit so it reads like a preview. */
  snippet: string;
  ts?: number;
}

// --- status / catalog ----------------------------------------------------

export interface CatalogModel {
  id: string;
  label: string;
  /** Context window in tokens -- the ring's denominator. */
  contextWindow: number;
}

export interface CatalogProvider {
  id: string;
  label: string;
  models: CatalogModel[];
  connected: boolean;
}

export interface StatusResponse {
  uptimeMs: number;
  inFlight: Array<{
    sessionId: string;
    model: string;
    effort: string;
    startedAt: number;
    pending?: boolean;
  }>;
  queued: Record<string, number>;
  catalog: CatalogProvider[];
  efforts: string[];
  effortMenu: Array<{ id: string; label: string }>;
  permissionMenu: Array<{ id: string; label: string }>;
  uploads: { maxFiles: number; maxBytes: number };
  defaults: {
    provider: string;
    modelId: string;
    modelLabel: string;
    effort: string;
    effortLabel: string;
  };
  permission: string;
  /** Connection facts for the settings screen. Nothing sensitive here. */
  service: {
    version: string;
    tunnel: 'cloudflared' | 'none';
    tunnelUrl: string | null;
    port: number;
    asideReachable: boolean;
    bridgeConfigured: boolean;
  };
}

/** Defaults for sessions this app creates. See `server/src/settings.ts`. */
export interface MiniappSettings {
  defaultProvider: string;
  defaultModelId: string;
  defaultEffort: string;
  defaultPermissionMode: string | null;
  defaultFinalConfirm: boolean | null;
}

export interface MessagesResponse {
  sessionId: string;
  entries: Entry[];
  truncated: boolean;
  lastLine: number;
  busy: boolean;
  queued: number;
}

// --- session files -------------------------------------------------------

export type ArtifactGroup = 'artifacts' | 'attachments';
export type ArtifactKind = 'markdown' | 'image' | 'code' | 'text' | 'binary';

export interface ArtifactFile {
  /** Relative to the group directory; the id sent back to fetch it. */
  path: string;
  name: string;
  size: number;
  mtime: number;
  kind: ArtifactKind;
}

export interface ArtifactsResponse {
  sessionId: string;
  groups: Array<{ id: ArtifactGroup; files: ArtifactFile[] }>;
}

export interface AuthResponse {
  token: string;
  user: { id: number; firstName?: string; username?: string };
  expiresIn: number;
}

// --- memory browser (8.1) -----------------------------------------------

/** One node in this account's memory tree. Mirrors `server/src/memorybrowser.ts`. */
export interface MemoryNode {
  name: string;
  /** Relative to the memory root -- what the client sends back to read it. */
  relPath: string;
  type: 'file' | 'dir';
  children?: MemoryNode[];
}

// --- browser surfaces (Day 3) ---------------------------------------------

/** One open tab on the Mac. Mirrors `server/src/browser.ts`. */
export interface BrowserTab {
  id: string;
  targetId: string;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  /** Same-origin icon URL (proxied by the Mac) or a small data: URL. */
  faviconUrl?: string;
  /** Set when an Aside chat is using this tab. */
  agent?: { sessionId: string; title: string; running: boolean };
}

export interface TabCapture {
  dataUrl: string;
  url: string;
  capturedAt: number;
}

// --- routines (8.2) ------------------------------------------------------

/**
 * The facade returns `unknown[]` from `aside.routines.list()`; the shape
 * is whatever the daemon gives back on this account. We type it loosely
 * here so the renderer can reach for fields without a compile-time lie.
 */
export interface RoutineRow {
  [key: string]: unknown;
}

/*
 * Web search results, produced by the Mac's own browser rather than by a
 * search API. `tookMs` is surfaced because a real browser round trip is
 * seconds rather than milliseconds, and showing the cost is friendlier than
 * an unexplained wait.
 */
export type SearchVertical = 'web' | 'images' | 'videos' | 'news';

export interface WebSearchResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  /** Present on video and news results. */
  thumbnail?: string;
  /** A duration like "12:04", or an age like "8 hours ago". */
  meta?: string;
}

export interface WebImageResult {
  thumbnail: string;
  pageUrl: string;
  alt: string;
  domain: string;
}

export interface WebSearchAnswer {
  text: string;
  source?: string;
}

export interface WebSearchResponse {
  query: string;
  vertical: SearchVertical;
  results: WebSearchResult[];
  images: WebImageResult[];
  answer?: WebSearchAnswer;
  /** "People also ask" questions. */
  questions: string[];
  related: string[];
  tookMs: number;
  cached?: boolean;
}

/*
 * A row from the Aside browser's own Chromium history database. This is
 * the desktop profile's real history, not a log kept by the bridge, which
 * is why it can be trusted to match what the Mac shows.
 */
export interface BrowserHistoryEntry {
  url: string;
  title: string;
  domain: string;
  visitCount: number;
  /** Unix milliseconds; 0 when the source row had no usable timestamp. */
  lastVisit: number;
}

export interface BrowserHistoryResponse {
  entries: BrowserHistoryEntry[];
  query: string;
}

/*
 * One row under the address bar.
 *
 * Three shapes because a browser's typeahead answers three different
 * questions at once: go here, go back to where you were, or search for
 * this. They are drawn differently and they do different things on tap,
 * so they are separate variants rather than one row with optional fields.
 */
export type OmniboxItem =
  | { kind: 'url'; url: string; text: string }
  | {
      kind: 'page';
      title: string;
      url: string;
      domain: string;
      lastVisit: number;
      /** Which device this was visited on. */
      source: 'mac' | 'phone';
    }
  | {
      kind: 'search';
      text: string;
      /** `history` is a query typed on this phone before. */
      source: 'suggest' | 'history';
    };

export interface OmniboxResponse {
  query: string;
  items: OmniboxItem[];
}

export interface BrowseRecentResponse {
  items: OmniboxItem[];
  query: string;
}

// --- next -----------------------------------------------------------------

export type NextLane = 'you' | 'prep' | 'aside';
export type NextStatus = 'open' | 'done' | 'snoozed' | 'dismissed' | 'handed-off';

/** One task on the Next surface. Mirrors `server/src/next.ts`. */
/** School and personal never mix. Every item, notice, source, and project lives in one. */
export type NextSpace = 'school' | 'personal';

export interface NextItem {
  evidence?: import('./contextTypes').TaskEvidence;
  id: string;
  source: 'schoology' | 'school-mail' | 'mail' | 'calendar' | 'manual' | 'project';
  space: NextSpace;
  title: string;
  context: string;
  dueISO: string | null;
  estMinutes: number | null;
  lane: NextLane;
  why: string;
  url: string | null;
  steps: string[];
  confidence: number;
  score: number;
  overdue: boolean;
  /** Past due and the source confirmed it was not turned in. */
  lateConfirmed: boolean;
  status: NextStatus;
  closedBy: 'you' | 'source' | null;
  closedAt: string | null;
  snoozedUntil: string | null;
  sessionId: string | null;
  kind: 'coursework' | 'reply' | 'form' | 'schedule' | 'event' | 'notice' | 'errand' | 'opportunity';
  /** What Aside will and will not do. Written by server code, not a model. */
  brief: NextBrief;
  /** Where this is already being worked on. */
  trail: NextTrail | null;
  taint: 'email' | null;
  flag: 'suspicious' | null;
  flagReason?: string | null;
  /** An email's main link, checked by server code against the sender. */
  link?: NextLink | null;
  sender?: NextSender | null;
  ask?: string | null;
  /** A reply draft was saved to Gmail. */
  draftedAt?: string | null;
  /** For items with Aside: what the agent is doing now. */
  live?: NextLive | null;
  /** Latest research on this item, if any. */
  research?: { id: string; state: ResearchState; verdictLabel: string | null } | null;
  /** He tapped Start and it is waiting for a locked helper to be ready. */
  handoff?: { state: 'waiting'; readyInMin: number | null } | null;
  /** Personal Gmail still on trial. */
  doneHint?: { subject: string; at: string; p: number; via?: 'email' | 'screen' } | null;
  alsoFrom?: Array<{ id: string; source: NextItem['source']; title: string }>;
  estBy?: 'source' | 'jev';
  trial?: boolean;
}

export interface NextLink {
  url: string;
  host: string;
  verified: boolean;
  reason: string;
}

export interface NextSender {
  name: string;
  host: string;
  school: boolean;
  /** district = staff domain and Gmail's DMARC check passed. */
  tier?: 'district' | 'student' | 'outside';
}

export interface NextBrief {
  mode: 'agent' | 'draft' | 'none';
  headline: string;
  will: string[];
  wont: string[];
  stopsAt: string;
  trust: 'source' | 'email';
  note: string | null;
  /** Whether "Look into this" is offered, and how it would read. */
  research?: { kind: 'web' | 'reader'; host: string | null } | null;
}

export interface NextTrail {
  title: string;
  kind: string;
  url: string;
  lastAt: string;
  minutes: number;
}

export interface NextLive {
  busy: boolean;
  step: string | null;
  startedAt: string | null;
  tab: { targetId: string; url: string } | null;
  /** The helper's last reply once it stops (Sep 27), shown on the task. */
  result?: string | null;
}

export interface NextNotice {
  id: string;
  source: NextItem['source'];
  space: NextSpace;
  title: string;
  context: string;
  why: string;
  url: string | null;
  at: string | null;
  flag: 'suspicious' | null;
  flagReason?: string | null;
  sender?: NextSender | null;
}

export interface NextPlan {
  context?: import('./contextTypes').ContextEnvelope;
  generatedAt: string;
  now: NextItem | null;
  next: NextItem[];
  withAside: NextItem[];
  unsure: NextItem[];
  later: NextItem[];
  doneToday: NextItem[];
  notices: NextNotice[];
  pickUp: NextTrail | null;
  dayLine: string;
  queuedMinutes: number;
  sources: Array<{ id: string; space?: NextSpace; label: string; updatedAt: string | null; count: number; ok: boolean }>;
  refreshPrompt: string | null;
  control?: NextControl;
  projects?: NextProjectBrief[];
  /** Personal Gmail on trial, apart from Today. */
  review?: NextItem[];
  /** Counts of private and flagged personal mail. No content. */
  personalNote?: string | null;
}

export type NextAction =
  | { type: 'done' | 'dismiss' | 'keep' | 'reopen' }
  | { type: 'snooze'; until: string }
  | { type: 'handoff'; sessionId: string };


// --------------------------------------------------------------------------
// Next: projects, activity, safety.

export interface NextControl {
  paused: boolean;
  pausedAt: string | null;
  reason: string | null;
}

export type ProjectHealth = 'on-track' | 'tight' | 'at-risk' | 'done' | 'empty';

export interface NextProjectBrief {
  id: string;
  space: NextSpace;
  title: string;
  health: ProjectHealth | string;
  line: string;
  deadlineISO: string;
  done: number;
  total: number;
  todayMin: number;
}

export interface NextMilestone {
  id: string;
  title: string;
  detail: string;
  estMinutes: number;
  dependsOn: string[];
  status: 'todo' | 'doing' | 'done' | 'blocked';
  owner: 'you' | 'wait';
  fixedDueISO: string | null;
  evidence: string;
  url: string | null;
  origin: 'you' | 'inspector';
  doneAt: string | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  latestFinish: string | null;
  slackDays: number | null;
  critical: boolean;
  atRisk: boolean;
  ready: boolean;
  remainingMin: number;
}

export interface NextDayPlan {
  day: string;
  capacity: number;
  minutes: number;
  items: Array<{ id: string; title: string; minutes: number; critical: boolean }>;
}

export interface NextProposal {
  id: string;
  createdAt: string;
  sessionId: string | null;
  summary: string;
  findings: Array<{ text: string; source: string }>;
  milestones: NextMilestone[];
  diff: {
    added: Array<{ id: string; title: string }>;
    removed: Array<{ id: string; title: string }>;
    changed: Array<{ id: string; title: string; what: string[] }>;
    kept: number;
  };
  preview: { health: ProjectHealth; line: string; projectedFinish: string | null; remainingMin: number; pastDeadline: string[] };
}

export interface NextProject {
  id: string;
  space: NextSpace;
  title: string;
  goal: string;
  deadlineISO: string;
  status: 'active' | 'done' | 'archived';
  health: ProjectHealth;
  line: string;
  daysLeft: number;
  bufferDays: number;
  targetFinish: string;
  projectedFinish: string | null;
  remainingMin: number;
  capacityMin: number;
  shortMin: number;
  done: number;
  total: number;
  capacity: { weekdayMin: number; weekendMin: number };
  today: NextDayPlan | null;
  days: NextDayPlan[];
  milestones: NextMilestone[];
  waiting: NextMilestone[];
  inspect: {
    state: 'idle' | 'running' | 'failed';
    sessionId: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  };
  proposal: NextProposal | null;
  updatedAt: string;
}

export type LedgerActor = 'you' | 'sorter' | 'drafter' | 'planner' | 'inspector' | 'agent' | 'system';

export interface LedgerEntry {
  seq: number;
  at: string;
  actor: LedgerActor;
  kind: string;
  summary: string;
  itemId?: string;
  projectId?: string;
  sessionId?: string;
  detail?: Record<string, string | number | boolean | null>;
  risk?: 'none' | 'low' | 'high';
}

export interface NextCapability {
  id: string;
  name: string;
  model: string;
  reads: string[];
  can: string[];
  never: string[];
  enforcedBy: Array<{ rule: string; how: 'code' | 'aside' | 'instruction' }>;
}

export interface NextSafety {
  control: NextControl;
  ledger: { ok: boolean; count: number; brokenAt: number | null; checkedAt: string };
  parts: NextCapability[];
  running: Array<{ kind: 'agent' | 'inspector'; title: string; sessionId: string | null }>;
}


export type ResearchState = 'preparing' | 'running' | 'ready' | 'failed' | 'dismissed';
export interface ResearchReport {
  title: string;
  verdict: 'yes' | 'no' | 'unclear' | null;
  verdictLabel: string | null;
  summary: string;
  points: Array<{ text: string; cites: number[] }>;
  sources: Array<{ n: number; title: string; url: string; host: string }>;
  open: string[];
  confidence: 'high' | 'medium' | 'low';
}
export interface ResearchBrief {
  id: string;
  question: string;
  title: string;
  kind: 'web' | 'reader' | 'inspector';
  host: string | null;
  itemId: string | null;
  projectId: string | null;
  state: ResearchState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sessionId: string | null;
  hardLimits: boolean;
  limits: string;
  readyInMin: number | null;
  report: ResearchReport | null;
  error: string | null;
  tokens: number;
  blocked: number;
  sourcesRead: number;
  /** Code + Jev second look at the pages and the brief. */
  audit?: {
    at: string;
    calls: number;
    skipped: string | null;
    sources: Array<{ n: number; fetched: boolean; bait: boolean; why: string | null }>;
    points: Array<number | null>;
    pushy: number | null;
    bait: number | null;
  } | null;
}

/**
 * A message sent while a turn was running, waiting for it to end.
 *
 * Drawn as a card above the composer with Send now, Edit and Remove, as
 * the desktop sidepanel does. `local` marks the optimistic copy shown
 * between the tap and the server's acknowledgement.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: string[];
  at: number;
  local?: boolean;
}


import { Shine } from './Affect';
/**
 * Today: the one thing to do now, then everything else grouped by when.
 *
 * Layout follows Things' Today (one list, quiet sections, finished work
 * tucked into a collapsed "Done today") and Todoist (the tab title is the
 * biggest type; the date sits under it). The Now card is the only serif
 * line on the screen. Clay appears only on a real deadline that is today
 * or already past (Things: "when" is never red, a deadline is).
 *
 * Every row does one thing on tap: open its detail sheet, where every
 * action lives. The circle marks it done. Swipes are shortcuts only
 * (right = done, left = later) and always have a button twin in the sheet.
 */
import { estLabel } from '../utils/jevMarks';
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { CircleHelp, Clock3, Ellipsis, EyeOff, Lock, Mail, Search, X } from 'lucide-react';
import { ArrowUpRight, ChevronDown, Spinner } from './Icons';
import type { NextItem, NextNotice, NextPlan, NextSpace } from '../types';
import { formatDue, formatMinutes, senderLine, stamp } from '../utils/nextFormat';
import { skipLabel } from '../utils/nextFormat';
import { HEALTH_WORD, hm } from '../utils/nextPlanFormat';

export type DueTone = 'late' | 'today' | 'soon' | 'none';

/** Project steps carry a planned day, not a deadline, so they never get clay. */
export function isPlanned(item: Pick<NextItem, 'source'>): boolean {
  return item.source === 'project';
}

export function dueTone(item: Pick<NextItem, 'dueISO' | 'overdue' | 'source'>, now: Date): DueTone {
  if (!item.dueISO || isPlanned(item)) return 'none';
  if (item.overdue) return 'late';
  const due = new Date(item.dueISO);
  const sameDay = due.toDateString() === now.toDateString();
  if (sameDay) return 'today';
  return due.getTime() - now.getTime() < 3 * 86_400_000 ? 'soon' : 'none';
}

/** "Planned for today" for project steps; "Due tonight at 11:59 PM" for real deadlines. */
function plannedText(iso: string, now: Date): string {
  const d = new Date(iso);
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return 'planned for today';
  if (days === 1) return 'planned for tomorrow';
  return `planned for ${d.toLocaleDateString([], days < 7 ? { weekday: 'long' } : { month: 'short', day: 'numeric' })}`;
}

export function whenText(item: Pick<NextItem, 'dueISO' | 'source'>, now: Date): string {
  if (!item.dueISO) return '';
  return isPlanned(item) ? plannedText(item.dueISO, now) : formatDue(item.dueISO, now);
}

function dueText(item: NextItem, now: Date): string {
  const s = whenText(item, now);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function longDate(now: Date): string {
  return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// --------------------------------------------------------------------------
// Check circle: fill 150ms, then the tick draws (Super Productivity
// done-toggle), the row holds a beat and folds away.

export function CheckCircle({ done, size = 22 }: { done: boolean; size?: number }) {
  return (
    <svg className={`n3-check-svg${done ? ' is-done' : ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" className="n3-check-ring" />
      <path d="M7.5 12.4 10.6 15.4 16.6 9" className="n3-check-tick" />
    </svg>
  );
}

// --------------------------------------------------------------------------

export function TodayView({
  plan,
  onOpenItem,
  onAdd,
  onDone,
  onLater,
  onOpenUrl,
  onOpenProject,
  onOpenThread,
  onClearNotice,
  onKeep,
  onSkip,
  onCheckMail,
  checking,
  space,
}: {
  space: NextSpace;
  plan: NextPlan;
  onOpenItem: (item: NextItem) => void;
  onAdd: () => void;
  onDone: (item: NextItem) => void;
  onLater: (item: NextItem) => void;
  /** Focus timer now lives in the task sheet. */
  onFocus?: (item: NextItem) => void;
  onOpenUrl: (url: string) => void;
  onOpenProject: (id: string) => void;
  onOpenThread: (sessionId: string) => void;
  onClearNotice: (n: NextNotice) => void;
  onKeep: (item: NextItem) => void;
  onSkip: (item: NextItem) => void;
  onCheckMail: (() => void) | null;
  checking: boolean;
}) {
  const now = new Date();
  const [doneOpen, setDoneOpen] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchable = [...new Map([plan.now, ...plan.next, ...plan.later, ...plan.unsure, ...plan.withAside, ...(plan.review ?? [])].filter((it): it is NextItem => !!it).map(it => [it.id, it])).values()];
  const matches = searchable.filter(it => `${it.title} ${it.context} ${it.why}`.toLowerCase().includes(query.trim().toLowerCase()));
  const hero = plan.now;
  const upNext = plan.next;
  // A real deadline today never hides under "This week".
  const dueToday = plan.later.filter((it) => it.dueISO && !isPlanned(it) && new Date(it.dueISO).toDateString() === now.toDateString());
  const thisWeek = plan.later.filter((it) => !dueToday.includes(it) && it.dueISO && new Date(it.dueISO).getTime() - now.getTime() < 7 * 86_400_000);
  const later = plan.later.filter((it) => !dueToday.includes(it) && !thisWeek.includes(it));
  const upNextMin = upNext.reduce((s, it) => s + (it.estMinutes ?? 0), 0);

  return (
    <div className="n3-today">
      <div className={`n3-stage${hero ? '' : ' is-clear'}`}>
        <header className="n3-title-block">
          <p className="n3-date">{longDate(now)}</p>
          <div className="n3-title-row"><h1 className="n3-title">Today</h1><button type="button" className="n3-find" aria-label={searchOpen ? 'Close task search' : 'Find a task'} aria-expanded={searchOpen} aria-controls="n3-task-search" onClick={() => { setSearchOpen(v => !v); setQuery(''); }}>{searchOpen ? <X size={20} aria-hidden /> : <Search size={20} aria-hidden />}</button></div>
        </header>

        {searchOpen ? <div className="n3-search" id="n3-task-search"><Search size={18} aria-hidden /><input id="n3-find-input" type="search" enterKeyHint="search" aria-label={`Find a task in ${space === 'school' ? 'School' : 'Personal'}`} placeholder={`Find a task in ${space === 'school' ? 'School' : 'Personal'}`} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setSearchOpen(false); setQuery(''); } }} autoFocus />{query ? <button type="button" className="n3-search-clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} aria-hidden /></button> : null}</div> : null}
        {!searchOpen && (hero ? (
          <NowCard item={hero} now={now} onOpen={() => onOpenItem(hero)} onDone={() => onDone(hero)} onLater={() => onLater(hero)} onSkip={() => onSkip(hero)} onOpenUrl={onOpenUrl} />
        ) : (
          <section className="n3-clear">
            <p className="n3-clear-title">{space === 'school' ? 'Nothing due for school right now.' : 'Nothing personal needs you right now.'}</p>
            <p className="n3-clear-line">
              {space === 'school'
                ? 'New work shows up here as soon as Schoology or your school email has it.'
                : 'Tasks you add, your personal projects, and Gmail you keep show up here.'}
            </p>
            <button type="button" className="n3-clear-add" onClick={onAdd}>Add a task</button>
          </section>
        ))}
      </div>

      {searchOpen ? <Group title={query.trim() ? 'Search results' : 'All tasks'} count={matches.length}>{matches.length ? matches.map(it => <TaskRow key={it.id} item={it} now={now} onOpen={onOpenItem} onDone={onDone} onLater={onLater} onSkip={onSkip} />) : <p className="n3-search-empty">No matching tasks. Try a different word.</p>}</Group> : <>
      {upNext.length ? (
        <Group title="Up next" count={upNext.length} aside={upNextMin ? `about ${hm(upNextMin)}` : undefined}>
          {upNext.map((it) => (
            <TaskRow key={it.id} item={it} now={now} onOpen={onOpenItem} onDone={onDone} onLater={onLater} onSkip={onSkip} />
          ))}
        </Group>
      ) : null}

      {dueToday.length ? (
        <Group title="Also due today" count={dueToday.length}>
          {dueToday.map((it) => (
            <TaskRow key={it.id} item={it} now={now} onOpen={onOpenItem} onDone={onDone} onLater={onLater} onSkip={onSkip} />
          ))}
        </Group>
      ) : null}

      {plan.pickUp ? (
        <button type="button" className="n3-pickup" onClick={() => onOpenUrl(plan.pickUp!.url)}>
          <span className="n3-pickup-label">Continue where you left off</span>
          <span className="n3-pickup-title">{plan.pickUp.title}</span>
          <span className="n3-pickup-meta">
            {plan.pickUp.kind}, {stamp(new Date(plan.pickUp.lastAt), now)}
          </span>
          <ArrowUpRight size={16} strokeWidth={1.75} />
        </button>
      ) : null}

      {plan.projects?.length ? (
        <Group title="Projects" count={plan.projects.length}>
          {plan.projects.map((p) => (
            <button key={p.id} type="button" className={`n3-row n3-proj-row is-${p.health}`} onClick={() => onOpenProject(p.id)}>
              <ProgressRing done={p.done} total={p.total} health={p.health} />
              <span className="n3-row-body">
                <span className="n3-row-title">{p.title}</span>
                <span className="n3-row-meta">
                  {HEALTH_WORD[p.health] ?? p.health}
                  {p.todayMin ? `, ${hm(p.todayMin)} planned today` : ''}
                </span>
              </span>
              <span className="n3-row-end">
                {p.done}/{p.total}
              </span>
            </button>
          ))}
        </Group>
      ) : null}

      {plan.withAside.length ? (
        // AI SDK Agents' Task tray: lead with what needs you, then what is
        // running. A running helper shows the eight-ray loader with its real
        // step; a finished one waits behind a check for you to look at it.
        <Group
          title="Next is working on"
          count={plan.withAside.length}
          aside={(() => {
            const ready = plan.withAside.filter((it) => !it.live?.busy).length;
            return ready ? `${ready} ready for you` : undefined;
          })()}
        >
          {[...plan.withAside].sort((a, b) => Number(!!a.live?.busy) - Number(!!b.live?.busy)).map((it) => (
            <button key={it.id} type="button" className={`n3-row n3-tray-row${it.live?.busy ? ' is-busy' : ' is-ready'}`} onClick={() => it.sessionId && onOpenThread(it.sessionId)}>
              <span className="n3-tray-mark" aria-hidden>
                {it.live?.busy ? <Spinner size={14} /> : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" className="n3-tray-ring" /><path d="M5 8.2l2 2 4-4.4" className="n3-tray-tick" /></svg>
                )}
              </span>
              <span className="n3-row-body">
                <span className="n3-row-title">{it.title}</span>
                <span className="n3-row-meta"><Shine active={!!it.live?.busy} text={it.live?.busy ? it.live.step || 'Working on it' : 'Ready for you to check'} /></span>
              </span>
              <ArrowUpRight size={16} strokeWidth={1.75} className="n3-row-chev" />
            </button>
          ))}
        </Group>
      ) : null}

      {thisWeek.length ? (
        <Group title="This week" count={thisWeek.length}>
          {thisWeek.map((it) => (
            <TaskRow key={it.id} item={it} now={now} onOpen={onOpenItem} onDone={onDone} onLater={onLater} onSkip={onSkip} />
          ))}
        </Group>
      ) : null}

      {plan.notices.length ? (
        <Group title={space === 'school' ? 'From school' : 'From your Gmail'} count={plan.notices.length}>
          {plan.notices.map((n) => (
            <div key={n.id} className={`n3-row n3-notice${n.flag ? ' is-flagged' : ''}`}>
              <span className="n3-lead" aria-hidden>
                <Mail size={17} strokeWidth={1.6} />
              </span>
              <button type="button" className="n3-row-body" onClick={() => n.url && onOpenUrl(n.url)} disabled={!n.url}>
                <span className="n3-row-title">{n.title}</span>
                <span className="n3-row-meta">
                  <span className="n3-clamp-2">{n.flag ? `Looks suspicious: ${n.flagReason ?? 'check it in Gmail yourself'}` : n.why || senderLine(n.sender)}</span>
                </span>
              </button>
              <button type="button" className="n3-x-btn" onClick={() => onClearNotice(n)} aria-label={`Clear ${n.title}`}>
                <X size={16} strokeWidth={2} />
              </button>
            </div>
          ))}
        </Group>
      ) : null}

      {plan.unsure.length ? (
        <Group title="Is this yours?" count={plan.unsure.length} note="Next is not sure these are for you.">
          {plan.unsure.map((it) => (
            <div key={it.id} className="n3-row">
              <span className="n3-lead" aria-hidden>
                <CircleHelp size={17} strokeWidth={1.6} />
              </span>
              <button type="button" className="n3-row-body" onClick={() => onOpenItem(it)}>
                <span className="n3-row-title">{it.title}</span>
                <span className="n3-row-meta">{it.context || it.why}</span>
              </button>
              <span className="n3-row-acts">
                <button type="button" className="n3-x-btn" onClick={() => onSkip(it)} aria-label={`Skip ${it.title}`}>
                  <X size={16} strokeWidth={2} />
                </button>
                <button type="button" className="n3-pill-btn" onClick={() => onKeep(it)} aria-label={`Keep ${it.title}`}>
                  Keep
                </button>
              </span>
            </div>
          ))}
        </Group>
      ) : null}

      {plan.review?.length || plan.personalNote ? (
        <Group title="Might need you" count={plan.review?.length || undefined} aside="from Gmail, trial" note="Keep puts it on your list. Next only lists these; it never replies or acts on them.">
          {(plan.review ?? []).map((it) => (
            <div key={it.id} className="n3-row">
              <span className="n3-lead" aria-hidden>
                <Mail size={17} strokeWidth={1.6} />
              </span>
              <button type="button" className="n3-row-body" onClick={() => onOpenItem(it)}>
                <span className="n3-row-title">{it.title}</span>
                <span className="n3-row-meta">
                  <span className="n3-ellipsis">{[cap(whenText(it, now)), it.context].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
              <span className="n3-row-acts">
                <button type="button" className="n3-x-btn" onClick={() => onSkip(it)} aria-label={`Skip ${it.title}`}>
                  <X size={16} strokeWidth={2} />
                </button>
                <button type="button" className="n3-pill-btn" onClick={() => onKeep(it)} aria-label={`Keep ${it.title}`}>
                  Keep
                </button>
              </span>
            </div>
          ))}
          {plan.personalNote ? (
            <div className="n3-row n3-private-row">
              <span className="n3-lead" aria-hidden>
                <Lock size={16} strokeWidth={1.6} />
              </span>
              <span className="n3-row-body is-static">
                <span className="n3-row-meta n3-private-line">{plan.personalNote}</span>
              </span>
            </div>
          ) : null}
        </Group>
      ) : null}

      {later.length ? (
        <section className="n3-group">
          <button type="button" className="n3-disclosure" aria-expanded={laterOpen} onClick={() => setLaterOpen((v) => !v)}>
            <span>Later</span>
            <span className="n3-group-count">{later.length}</span>
            <ChevronDown size={16} strokeWidth={1.75} className={laterOpen ? 'is-open' : ''} />
          </button>
          {laterOpen ? (
            <div className="n3-rows">
              {later.map((it) => (
                <TaskRow key={it.id} item={it} now={now} onOpen={onOpenItem} onDone={onDone} onLater={onLater} onSkip={onSkip} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {plan.doneToday.length ? (
        <section className="n3-group">
          <button type="button" className="n3-disclosure" aria-expanded={doneOpen} onClick={() => setDoneOpen((v) => !v)}>
            <span>Done today</span>
            <span className="n3-group-count">{plan.doneToday.length}</span>
            <ChevronDown size={16} strokeWidth={1.75} className={doneOpen ? 'is-open' : ''} />
          </button>
          {doneOpen ? (
            <div className="n3-rows">
              {plan.doneToday.map((it) => (
                <div key={it.id} className="n3-row is-done">
                  <span className="n3-check" aria-hidden>
                    <CheckCircle done />
                  </span>
                  <span className="n3-row-body is-static">
                    <span className="n3-row-title">{it.title}</span>
                    <span className="n3-row-meta">{it.closedBy === 'source' ? 'Marked done by ' + (it.source === 'schoology' ? 'Schoology' : 'the source') : 'Marked done by you'}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      </>}
      <footer className="n3-foot">
        {plan.sources.length ? (
          <p>
            {plan.sources
              .map((s) => (s.updatedAt ? `${s.label} checked ${stamp(new Date(s.updatedAt), now)}` : s.ok ? `${s.label} connected` : `${s.label} not available`))
              .join('. ')}
            .
          </p>
        ) : null}
        {onCheckMail ? (
          <button type="button" className="n3-text-btn" onClick={onCheckMail} disabled={checking}>
            {checking ? <Spinner size={13} /> : null}
            {space === 'school' ? (checking ? 'Checking school email' : 'Check school email now') : checking ? 'Checking Gmail' : 'Check Gmail now'}
          </button>
        ) : null}
      </footer>
    </div>
  );
}

// --------------------------------------------------------------------------

/**
 * The line beside "Your next move". Dropped when the title already says it
 * ("Apply for the Stan & Thelma Plumlee Trade School Scholarship" next to
 * "Stan & Thelma Plumlee Scholarship"): the same words twice, a line apart.
 */
export function nowContext(item: Pick<NextItem, 'title' | 'context' | 'taint' | 'sender'>): string {
  const raw = item.context || (item.taint === 'email' ? senderLine(item.sender) : '');
  if (!raw) return '';
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const title = new Set(words(item.title));
  const own = words(raw).filter((w) => w.length > 2);
  if (own.length && own.filter((w) => title.has(w)).length / own.length >= 0.75) return '';
  return raw;
}

function NowCard({
  item,
  now,
  onOpen,
  onDone,
  onLater,
  onSkip,
  onOpenUrl,
}: {
  item: NextItem;
  now: Date;
  onOpen: () => void;
  onDone: () => void;
  onLater: () => void;
  onSkip: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const tone = dueTone(item, now);
  const est = formatMinutes(item.estMinutes);
  const context = nowContext(item);
  return (
    <section className="n3-now" aria-label="Do this now">
      <button type="button" className="n3-now-main" onClick={onOpen} aria-label={`${item.title}. Open details`}>
        <span className="n3-now-top">
          <span className="n3-now-label">Your next move</span>
          {context ? <span className="n3-now-context">{context}</span> : null}
        </span>
        <span className="n3-now-title">{item.title}</span>
        <span className="n3-now-facts">
          {item.dueISO ? (
            <span className={`n3-due is-${tone}`}>
              {tone === 'late' || tone === 'today' ? <span className="n3-due-mark" aria-hidden /> : null}
              {dueText(item, now)}
            </span>
          ) : null}
          {est ? <span className="n3-now-est">{estLabel(item, est)}</span> : null}
          {item.doneHint ? <span className="n3-row-tag">Looks done?</span> : null}
        </span>
        {item.why ? <span className="n3-now-why">{item.why}</span> : null}
        {item.trail ? (
          <span className="n3-now-trail">
            You were in {item.trail.kind} {stamp(new Date(item.trail.lastAt), now)} for {item.trail.minutes} min
          </span>
        ) : null}
      </button>
      <div className="n3-now-actions">
        {item.url ? (
          <button type="button" className="n3-btn is-primary" onClick={() => onOpenUrl(item.url!)}>
            {item.taint === 'email' ? 'Open email' : 'Open'}
            <ArrowUpRight size={16} strokeWidth={2} />
          </button>
        ) : null}
        <button type="button" className={`n3-btn ${item.url ? 'is-secondary' : 'is-primary'}`} onClick={onDone}>
          Done
        </button>
      </div>
      <div className="n3-now-more" role="group" aria-label="Change this task">
        <button type="button" onClick={onLater}>
          <Clock3 size={17} strokeWidth={1.9} aria-hidden />
          Later
        </button>
        <button type="button" onClick={onSkip}>
          <EyeOff size={17} strokeWidth={1.9} aria-hidden />
          {skipLabel(item)}
        </button>
        <button type="button" onClick={onOpen}>
          <Ellipsis size={17} strokeWidth={1.9} aria-hidden />
          Details
        </button>
      </div>
    </section>
  );
}

// --------------------------------------------------------------------------
// Row with swipe shortcuts. Horizontal intent is decided after 8px of
// travel (1.5x more sideways than down); past 72px it arms; release acts.

const ARM = 72;

export function TaskRow({
  item,
  now,
  onOpen,
  onDone,
  onLater,
  onSkip,
}: {
  item: NextItem;
  now: Date;
  onOpen: (item: NextItem) => void;
  onDone: (item: NextItem) => void;
  onLater: (item: NextItem) => void;
  onSkip?: (item: NextItem) => void;
}) {
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState<null | 'done' | 'later'>(null);
  const [checked, setChecked] = useState(false);
  const drag = useRef<{ x: number; y: number; id: number; horiz: boolean | null } | null>(null);
  const tone = dueTone(item, now);
  const est = formatMinutes(item.estMinutes);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const finish = (kind: 'done' | 'later') => {
    if (kind === 'done') setChecked(true);
    setLeaving(kind);
    window.setTimeout(() => (kind === 'done' ? onDone(item) : onLater(item)), reduce ? 0 : 380);
  };

  const down = (e: RPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horiz: null };
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (d.horiz === null && Math.hypot(mx, my) > 8) {
      d.horiz = Math.abs(mx) > Math.abs(my) * 1.5;
      if (d.horiz) {
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
      }
    }
    if (d.horiz) setDx(Math.max(-140, Math.min(140, mx)));
  };
  const up = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || !d.horiz) {
      setDx(0);
      return;
    }
    if (dx >= ARM) finish('done');
    else if (dx <= -ARM) finish('later');
    setDx(0);
  };

  const armed = dx >= ARM ? 'done' : dx <= -ARM ? 'later' : null;
  return (
    <div className={`n3-swipe${leaving ? ` is-leaving is-${leaving}` : ''}`}>
      {dx ? (
        <div className={`n3-swipe-under${dx > 0 ? ' is-right' : ' is-left'}${armed ? ' is-armed' : ''}`} aria-hidden>
          <span>{dx > 0 ? 'Done' : 'Later'}</span>
        </div>
      ) : null}
      <div
        className={`n3-row${tone === 'late' || tone === 'today' ? ` is-${tone}` : ''}`}
        style={dx ? { transform: `translate3d(${dx}px,0,0)`, transition: 'none' } : undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => { drag.current = null; setDx(0); }}
      >
        <button type="button" className="n3-check" onClick={() => !leaving && finish('done')} aria-label={`Mark ${item.title} done`}>
          <CheckCircle done={checked} />
        </button>
        <button type="button" className="n3-row-body" onClick={() => !dx && onOpen(item)}>
          <span className={`n3-row-title${checked ? ' is-struck' : ''}`}>{item.title}</span>
          <span className="n3-row-meta">
            {tone === 'late' || tone === 'today' ? <span className={`n3-due-mark is-${tone}`} aria-hidden /> : null}
            {item.doneHint ? <span className="n3-row-tag">Looks done?</span> : null}
            {rowWhen(item, now) ? <span className="n3-row-when">{cap(rowWhen(item, now))}</span> : null}
            {item.context ? <span className="n3-row-context">{item.context}</span> : null}
          </span>
        </button>
        {est ? <span className="n3-row-end">{est}</span> : null}
      </div>
      {onSkip && !dx ? (
        <div className="n3-row-triage" role="group" aria-label={`Actions for ${item.title}`}>
          <button type="button" disabled={!!leaving} onClick={() => finish('later')} aria-label={`Later: move ${item.title} to tomorrow`}>
            <Clock3 size={14} strokeWidth={2} aria-hidden />
            Later
          </button>
          <button type="button" disabled={!!leaving} onClick={() => onSkip(item)} aria-label={`${skipLabel(item)}: ${item.title}`}>
            <EyeOff size={14} strokeWidth={2} aria-hidden />
            {skipLabel(item)}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** In a Today list, "planned for today" goes without saying. */
function rowWhen(item: NextItem, now: Date): string {
  const w = whenText(item, now);
  return w === 'planned for today' ? '' : w;
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// --------------------------------------------------------------------------

export function Group({ title, count, aside, note, children }: { title: string; count?: number; aside?: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="n3-group" aria-label={title}>
      <h2 className="n3-group-head">
        <span>
          {title}
          {count !== undefined ? <span className="n3-group-count"> {count}</span> : null}
        </span>
        {aside ? <span className="n3-group-aside">{aside}</span> : null}
      </h2>
      {note ? <p className="n3-group-note">{note}</p> : null}
      <div className="n3-rows">{children}</div>
    </section>
  );
}

/** Things-style progress pie: a ring that fills with finished steps. */
export function ProgressRing({ done, total, health, size = 22 }: { done: number; total: number; health: string; size?: number }) {
  const pct = total ? done / total : 0;
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`n3-ring is-${health}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r={r} className="n3-ring-track" />
      <circle cx="12" cy="12" r={r} className="n3-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 12 12)" />
    </svg>
  );
}

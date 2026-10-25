import { Collapse, Disclosure } from './Collapse';
/**
 * Projects: long goals with a plan he can trust.
 *
 * The list answers "am I going to make it?" for each goal in one line.
 * The detail answers "what do I do today, and why that" first, then shows
 * the whole road to the deadline as a single vertical rail, then every
 * step. Dates are computed on the Mac by plain arithmetic; the only model
 * involved is the progress check, whose suggested changes wait here for a yes.
 */
import { Shine } from './Affect';
import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../api';
import { haptic } from '../telegram';
import { Check, ChevronRight, Plus, Spinner, TodoCircle, TrashIcon } from './Icons';
import { Sheet } from './Sheet';
import { toast } from './Toasts';
import { openUrl } from '../utils/openUrl';
import type { NextMilestone, NextProject, NextSpace } from '../types';
import { HEALTH_WORD, dayLabel, hm, hours, shortDay } from '../utils/nextPlanFormat';
import { SpaceChoice } from './NextSpace';

// --------------------------------------------------------------------------
// List

export function ProjectsList({
  projects,
  onOpen,
  onNew,
  space,
}: {
  projects: NextProject[] | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  space: NextSpace;
}) {
  if (!projects) {
    return (
      <p className="list-empty">
        <Shine text="Loading projects…" className="af-loading" />
      </p>
    );
  }
  const active = projects.filter((p) => p.status === 'active' && (p.space ?? 'personal') === space);
  const elsewhere = projects.filter((p) => p.status === 'active' && (p.space ?? 'personal') !== space).length;
  const head = (
    <header className="n3-title-block">
      <h1 className="n3-title">Projects</h1>
      <p className="n3-subtitle">Big goals with a date. Next plans the days; you do the work.</p>
    </header>
  );
  const other = space === 'school' ? 'Personal' : 'School';
  if (!active.length) {
    return (
      <section className="np-empty">
        {head}
        <p className="next-title">{space === 'school' ? 'No school projects yet.' : 'No personal projects yet.'}</p>
        <p className="next-why">
          {space === 'school'
            ? 'A project is a goal with a date, like a research paper due before winter break. Next works out the steps, fits them into your real days, and warns you early if it will not fit.'
            : 'A project is a goal with a date, like every college application in by October 15. Next works out the steps, fits them into your real days, and warns you early if it will not fit.'}
        </p>
        {elsewhere ? <p className="np-elsewhere">{elsewhere === 1 ? `1 project is in ${other}.` : `${elsewhere} projects are in ${other}.`}</p> : null}
        <button type="button" className="next-primary np-empty-go" onClick={onNew}>
          <Plus size={16} strokeWidth={2} /> New project
        </button>
      </section>
    );
  }
  return (
    <div className="np-list">
      {head}
      {active.map((p) => (
        <ProjectCard key={p.id} p={p} onOpen={() => onOpen(p.id)} />
      ))}
      <button type="button" className="np-new-row" onClick={onNew}>
        <Plus size={16} strokeWidth={2} /> New project
      </button>
      {elsewhere ? <p className="np-elsewhere">{elsewhere === 1 ? `1 more project is in ${other}.` : `${elsewhere} more projects are in ${other}.`}</p> : null}
    </div>
  );
}

function ProjectCard({ p, onOpen }: { p: NextProject; onOpen: () => void }) {
  const now = new Date();
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const today = p.today?.items ?? [];
  return (
    <button type="button" className={`np-card is-${p.health}`} onClick={onOpen} aria-label={`${p.title}. ${HEALTH_WORD[p.health]}. ${p.line}`}>
      <span className="np-card-top">
        <span className="np-health">
          <span className="np-health-mark" aria-hidden />
          {HEALTH_WORD[p.health]}
        </span>
        <span className="np-card-date">Due {shortDay(p.deadlineISO)}</span>
      </span>
      <span className="np-card-title">{p.title}</span>
      <span className="np-card-line">{p.line}</span>
      <span className="np-rail" aria-hidden>
        <span className="np-rail-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="np-card-stats">
        <span>
          {p.done} of {p.total} steps
        </span>
        <span>{p.daysLeft} days left</span>
        <span>{hours(p.remainingMin)} of work</span>
      </span>
      {today.length ? (
        <span className="np-card-today">
          <span className="np-card-today-label">{dayLabel(p.today!.day, now)}</span>
          {today[0].title}
          {today.length > 1 ? `, and ${today.length - 1} more` : ''}
          <span className="np-card-today-min">{hm(p.today!.minutes)}</span>
        </span>
      ) : null}
      {p.proposal ? <span className="np-card-flag">New changes to review</span> : null}
      {p.inspect.state === 'running' ? (
        <span className="np-card-flag is-quiet">
          <Spinner size={12} /> Checking progress
        </span>
      ) : null}
    </button>
  );
}

// --------------------------------------------------------------------------
// Detail

export function ProjectDetail({ id, onGone }: { id: string; onGone: () => void }) {
  const [p, setP] = useState<NextProject | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const now = new Date();

  const load = useCallback(async () => {
    try {
      setP(await api.nextProject(id));
      setErr(null);
    } catch {
      setErr('Could not load this project.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the inspector works, check back every 20 seconds.
  useEffect(() => {
    if (p?.inspect.state !== 'running') return;
    const t = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(t);
  }, [p?.inspect.state, load]);

  const run = async (key: string, fn: () => Promise<NextProject>, ok?: string) => {
    setBusy(key);
    try {
      setP(await fn());
      if (ok) toast(ok);
    } catch (e) {
      const msg = String((e as Error)?.message ?? '');
      toast(
        msg.includes('423') || msg.includes('paused')
          ? 'Next is paused. Resume it from Activity first.'
          : msg.includes('409')
            ? 'Already running.'
            : msg.includes('429')
              ? 'That is a lot of starts this hour. Try again later.'
              : 'That did not save. Try again.',
        { tone: 'error' },
      );
    } finally {
      setBusy(null);
    }
  };

  if (!p) return <p className="list-empty">{err ?? <Shine text="Loading…" className="af-loading" />}</p>;

  const setStatus = (m: NextMilestone, status: NextMilestone['status']) => {
    haptic(status === 'done' ? 'success' : 'light');
    void run(m.id, () => api.nextEditStep(p.id, m.id, { status }), status === 'done' ? `Done: ${m.title}` : undefined);
  };

  const open = p.milestones.filter((m) => m.status !== 'done');
  const finished = p.milestones.filter((m) => m.status === 'done');
  const byStart = [...open].sort((a, b) => (a.plannedStart ?? '9999').localeCompare(b.plannedStart ?? '9999'));
  const deadlineDay = p.deadlineISO.slice(0, 10);
  const railDays = p.days.filter((d) => d.items.length).slice(0, 14);

  return (
    <div className="np-detail">
      <header className="np-head">
        <p className={`np-health is-${p.health}`}>
          <span className="np-health-mark" aria-hidden />
          {HEALTH_WORD[p.health]} · due {shortDay(p.deadlineISO)}
        </p>
        <h1 className="next-title np-title">{p.title}</h1>
        {p.goal ? <p className="np-goal">{p.goal}</p> : null}
        <p className="np-line">{p.line}</p>
        <dl className="np-stats">
          <div>
            <dt>Days left</dt>
            <dd>{p.daysLeft}</dd>
          </div>
          <div>
            <dt>Work left</dt>
            <dd>{hours(p.remainingMin)}</dd>
          </div>
          <div>
            <dt>Time you have</dt>
            <dd>{hours(p.capacityMin)}</dd>
          </div>
          <div>
            <dt>Spare days</dt>
            <dd>{p.bufferDays}</dd>
          </div>
        </dl>
      </header>

      {p.proposal ? (
        <button type="button" className="np-proposal-banner" onClick={() => setProposalOpen(true)}>
          <span className="np-proposal-text">
            <strong>New changes to review.</strong>
            <span>
              {p.proposal.diff.added.length} new, {p.proposal.diff.changed.length} changed, {p.proposal.diff.removed.length} dropped. Nothing changes unless you approve it.
            </span>
          </span>
          <ChevronRight size={18} strokeWidth={1.75} />
        </button>
      ) : null}

      <InspectBar p={p} busy={busy === 'inspect'} onInspect={() => void run('inspect', () => api.nextInspect(p.id), 'Checking progress. It only reads, and changes nothing unless you approve.')} />

      {p.today ? (
        <section className="np-block" aria-labelledby="np-today">
          <h2 className="np-block-head" id="np-today">
            {dayLabel(p.today.day, now)}
            <span>{hm(p.today.minutes)} of {hm(p.today.capacity)}</span>
          </h2>
          <div className="settings-rows surface-group">
            {p.today.items.map((slot) => {
              const m = p.milestones.find((x) => x.id === slot.id)!;
              return (
                <StepRow
                  key={slot.id}
                  m={m}
                  minutes={slot.minutes}
                  busy={busy === m.id}
                  expanded={openStep === m.id}
                  onToggle={() => setOpenStep(openStep === m.id ? null : m.id)}
                  onStatus={(s) => setStatus(m, s)}
                />
              );
            })}
          </div>
        </section>
      ) : open.length ? (
        <p className="np-quiet">Nothing scheduled for the rest of today. Your time today is used up or the plan starts tomorrow.</p>
      ) : null}

      {railDays.length ? (
        <section className="np-block" aria-labelledby="np-road">
          <h2 className="np-block-head" id="np-road">
            The road to {shortDay(p.deadlineISO)}
            <span>{p.projectedFinish ? `finishes ${shortDay(p.projectedFinish)}` : 'does not fit yet'}</span>
          </h2>
          <ol className="np-road">
            {railDays.map((d) => {
              const late = d.day > deadlineDay;
              const buffer = !late && d.day > p.targetFinish;
              return (
                <li key={d.day} className={`np-road-day${late ? ' is-late' : buffer ? ' is-buffer' : ''}`}>
                  <span className="np-road-dot" aria-hidden />
                  <div className="np-road-body">
                    <p className="np-road-date">
                      {dayLabel(d.day, now)}
                      <span>
                        {hm(d.minutes)}
                        {late ? ', after the deadline' : buffer ? ', spare day' : ''}
                      </span>
                    </p>
                    <ul>
                      {d.items.map((it) => (
                        <li key={it.id} className={it.critical ? 'is-critical' : ''}>
                          {it.critical ? <span className="np-crit" aria-label="critical path" /> : null}
                          <span className="np-road-title">{it.title}</span>
                          <span className="np-road-min">{hm(it.minutes)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            })}
            <li className="np-road-day is-deadline">
              <span className="np-road-dot" aria-hidden />
              <div className="np-road-body">
                <p className="np-road-date">
                  {shortDay(p.deadlineISO)}
                  <span>deadline</span>
                </p>
              </div>
            </li>
          </ol>
          <p className="np-footnote">
            <span className="np-crit" aria-hidden /> no room to slip. Dates are simple math on your Mac: how long each step takes, what comes first, and {hm(p.capacity.weekdayMin)} a school day, {hm(p.capacity.weekendMin)} a weekend day.
          </p>
        </section>
      ) : null}

      {p.waiting.length ? (
        <section className="np-block" aria-labelledby="np-wait">
          <h2 className="np-block-head" id="np-wait">
            Waiting on someone<span>your part is the nudge</span>
          </h2>
          <div className="settings-rows surface-group">
            {p.waiting.map((m) => (
              <StepRow key={m.id} m={m} busy={busy === m.id} expanded={openStep === m.id} onToggle={() => setOpenStep(openStep === m.id ? null : m.id)} onStatus={(s) => setStatus(m, s)} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="np-block" aria-labelledby="np-steps">
        <h2 className="np-block-head" id="np-steps">
          All steps<span>{open.length} left</span>
        </h2>
        <div className="settings-rows surface-group">
          {byStart.map((m) => (
            <StepRow
              key={m.id}
              m={m}
              busy={busy === m.id}
              expanded={openStep === m.id}
              onToggle={() => setOpenStep(openStep === m.id ? null : m.id)}
              onStatus={(s) => setStatus(m, s)}
              onRemove={() => void run(m.id, () => api.nextRemoveStep(p.id, m.id), 'Step removed')}
            />
          ))}
          {adding ? (
            <AddStep
              onCancel={() => setAdding(false)}
              onAdd={(title, est, owner) =>
                void run('add', () => api.nextAddStep(p.id, { title, estMinutes: est, owner })).then(() => setAdding(false))
              }
            />
          ) : (
            <button type="button" className="settings-row surface-row is-button np-add-row" onClick={() => setAdding(true)}>
              <Plus size={16} strokeWidth={2} /> Add a step
            </button>
          )}
        </div>
        {finished.length ? (
          <Disclosure className="np-done">
            <summary>{finished.length} done</summary>
            <div className="settings-rows surface-group">
              {finished.map((m) => (
                <StepRow key={m.id} m={m} busy={busy === m.id} expanded={false} onToggle={() => undefined} onStatus={(s) => setStatus(m, s)} />
              ))}
            </div>
          </Disclosure>
        ) : null}
      </section>

      <section className="np-block">
        <button type="button" className="np-settings-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
          Plan settings
          <span>
            {(p.space ?? 'personal') === 'school' ? 'School' : 'Personal'} ·{' '}
            {hm(p.capacity.weekdayMin)} school days · {hm(p.capacity.weekendMin)} weekends
          </span>
        </button>
        <Collapse open={settingsOpen}>
          <ProjectSettings
            p={p}
            onSave={(patch) => void run('settings', () => api.nextEditProject(p.id, patch), 'Plan updated')}
            onMove={(space) => void run('settings', () => api.nextEditProject(p.id, { space }), `Moved to ${space === 'school' ? 'School' : 'Personal'}`)}
            onArchive={() =>
              void run('archive', () => api.nextEditProject(p.id, { status: 'archived' }), 'Project archived').then(onGone)
            }
          />
        </Collapse>
      </section>

      {proposalOpen && p.proposal ? (
        <ProposalSheet
          p={p}
          busy={busy === 'proposal'}
          onClose={() => setProposalOpen(false)}
          onDecide={(action) =>
            void run('proposal', () => api.nextProposal(p.id, action, p.proposal!.id), action === 'apply' ? 'Plan approved' : 'Suggestion thrown away. Nothing changed.').then(() =>
              setProposalOpen(false),
            )
          }
        />
      ) : null}
    </div>
  );
}

function InspectBar({ p, busy, onInspect }: { p: NextProject; busy: boolean; onInspect: () => void }) {
  const running = p.inspect.state === 'running';
  const last = p.inspect.finishedAt ? `Last checked ${shortDay(p.inspect.finishedAt)}.` : 'Not checked yet.';
  return (
    <div className="np-inspect">
      <div className="np-inspect-text">
        {running ? (
          <>
            <strong>
              <Spinner size={13} /> Checking progress
            </strong>
            <span>Next is reading your notes and your Common App. It will suggest a plan here. Nothing changes unless you approve it.</span>
          </>
        ) : p.inspect.state === 'failed' ? (
          <>
            <strong>The last check didn't finish</strong>
            <span>{p.inspect.error}</span>
          </>
        ) : (
          <>
            <strong>Check progress</strong>
            <span>{last} Next reads where things stand and suggests the steps left. Only when you tap.</span>
          </>
        )}
      </div>
      <button type="button" className="np-inspect-go" onClick={onInspect} disabled={busy || running}>
        {busy ? <Spinner size={14} /> : <Sparkles size={15} strokeWidth={1.75} />}
        {running ? 'Checking' : 'Check'}
      </button>
    </div>
  );
}

function StepRow({
  m,
  minutes,
  busy,
  expanded,
  onToggle,
  onStatus,
  onRemove,
}: {
  m: NextMilestone;
  minutes?: number;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onStatus: (s: NextMilestone['status']) => void;
  onRemove?: () => void;
}) {
  const done = m.status === 'done';
  const meta = done
    ? m.doneAt
      ? `Done ${shortDay(m.doneAt)}`
      : 'Done'
    : m.status === 'blocked'
      ? 'Blocked'
      : [
          m.plannedFinish ? `planned for ${shortDay(m.plannedFinish)}` : 'not scheduled yet',
          m.fixedDueISO ? `must be done by ${shortDay(m.fixedDueISO)}` : '',
          m.owner === 'wait' ? 'waiting on someone' : '',
          m.critical ? 'no room to slip' : m.slackDays !== null && m.slackDays > 0 ? `${m.slackDays} spare day${m.slackDays === 1 ? '' : 's'}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    <div className={`settings-row surface-row next-row np-step${done ? ' is-done' : ''}${m.atRisk ? ' is-risk' : ''}`}>
      <button
        type="button"
        className="next-check"
        onClick={() => onStatus(done ? 'todo' : 'done')}
        disabled={busy}
        aria-label={done ? `Reopen ${m.title}` : `Mark ${m.title} done`}
        aria-pressed={done}
      >
        <TodoCircle status={done ? 'completed' : 'pending'} size={18} />
      </button>
      <div className="np-step-main">
        <button type="button" className="next-row-body" onClick={onToggle} aria-expanded={expanded}>
          <span className="settings-row-title">{m.title}</span>
          <span className="settings-row-description surface-meta">
            {m.atRisk ? <span className="next-late-mark" aria-hidden /> : null}
            {meta}
          </span>
        </button>
        <Collapse open={expanded}>
          <div className="np-step-more">
            {m.detail ? <p>{m.detail}</p> : null}
            {m.evidence ? (
              <p className="np-evidence">
                <span>Why</span> {m.evidence}
              </p>
            ) : null}
            <p className="np-origin">{m.origin === 'inspector' ? 'Suggested by Next, kept by you.' : 'Added by you.'}</p>
            <div className="np-step-actions">
              {m.url ? (
                <button type="button" onClick={() => void openUrl(m.url!)}>
                  Open page
                </button>
              ) : null}
              {!done ? (
                <button type="button" onClick={() => onStatus(m.status === 'blocked' ? 'todo' : 'blocked')}>
                  {m.status === 'blocked' ? 'Unblock' : 'Mark blocked'}
                </button>
              ) : null}
              {onRemove ? (
                <button type="button" className="is-danger" onClick={onRemove} aria-label={`Remove ${m.title}`}>
                  <TrashIcon size={14} /> Remove
                </button>
              ) : null}
            </div>
          </div>
        </Collapse>
      </div>
      <span className="next-est">{minutes ? hm(minutes) : done ? '' : hm(m.estMinutes)}</span>
    </div>
  );
}

const EFFORT = [15, 30, 60, 90, 120, 180];

function AddStep({ onAdd, onCancel }: { onAdd: (title: string, est: number, owner: 'you' | 'wait') => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [est, setEst] = useState(60);
  const [owner, setOwner] = useState<'you' | 'wait'>('you');
  return (
    <form
      className="np-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onAdd(title.trim(), est, owner);
      }}
    >
      <label className="np-sr" htmlFor="np-add-title">
        Step
      </label>
      <input id="np-add-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Verb first: Review Purdue essays" maxLength={90} />
      <div className="np-chips" role="radiogroup" aria-label="Effort">
        {EFFORT.map((m) => (
          <button type="button" key={m} role="radio" aria-checked={est === m} className={est === m ? 'is-on' : ''} onClick={() => setEst(m)}>
            {hm(m)}
          </button>
        ))}
      </div>
      <div className="np-chips" role="radiogroup" aria-label="Who acts">
        <button type="button" role="radio" aria-checked={owner === 'you'} className={owner === 'you' ? 'is-on' : ''} onClick={() => setOwner('you')}>
          Me
        </button>
        <button type="button" role="radio" aria-checked={owner === 'wait'} className={owner === 'wait' ? 'is-on' : ''} onClick={() => setOwner('wait')}>
          Someone else
        </button>
      </div>
      <div className="np-form-actions">
        <button type="button" className="next-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="next-primary" disabled={!title.trim()}>
          Add step
        </button>
      </div>
    </form>
  );
}

function Stepper({ label, value, onChange, step = 15 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div className="np-stepper" role="group" aria-label={label}>
      <span>{label}</span>
      <button type="button" onClick={() => onChange(Math.max(0, value - step))} aria-label={`Less time on ${label}`}>
        −
      </button>
      <output aria-live="polite">{hm(value)}</output>
      <button type="button" onClick={() => onChange(Math.min(720, value + step))} aria-label={`More time on ${label}`}>
        +
      </button>
    </div>
  );
}

function ProjectSettings({
  p,
  onSave,
  onArchive,
  onMove,
}: {
  p: NextProject;
  onSave: (patch: { deadline?: string; capacity?: { weekdayMin: number; weekendMin: number } }) => void;
  onArchive: () => void;
  onMove: (space: NextSpace) => void;
}) {
  const [wd, setWd] = useState(p.capacity.weekdayMin);
  const [we, setWe] = useState(p.capacity.weekendMin);
  const [deadline, setDeadline] = useState(p.deadlineISO.slice(0, 10));
  const dirty = wd !== p.capacity.weekdayMin || we !== p.capacity.weekendMin || deadline !== p.deadlineISO.slice(0, 10);
  return (
    <div className="np-settings">
      <div className="np-space-row">
        <span>Lives in</span>
        <SpaceChoice value={p.space ?? 'personal'} onChange={(s) => s !== (p.space ?? 'personal') && onMove(s)} />
      </div>
      <Stepper label="School days" value={wd} onChange={setWd} />
      <Stepper label="Weekends" value={we} onChange={setWe} />
      <label className="np-date">
        <span>Deadline</span>
        <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </label>
      <p className="np-footnote">More time a day pulls the finish earlier. The plan redraws the moment you save.</p>
      <div className="np-form-actions">
        <button type="button" className="next-secondary is-danger" onClick={onArchive}>
          Archive
        </button>
        <button type="button" className="next-primary" disabled={!dirty} onClick={() => onSave({ deadline, capacity: { weekdayMin: wd, weekendMin: we } })}>
          Save
        </button>
      </div>
    </div>
  );
}

function ProposalSheet({
  p,
  busy,
  onClose,
  onDecide,
}: {
  p: NextProject;
  busy: boolean;
  onClose: () => void;
  onDecide: (action: 'apply' | 'discard') => void;
}) {
  const prop = p.proposal!;
  const d = prop.diff;
  return (
    <Sheet side="bottom" title="New changes" subtitle={p.title} onClose={onClose}>
      <div className="next-brief np-proposal">
        <p className="next-brief-note">
          Next read your notes and pages and suggests this. Nothing changes unless you approve it, and finished steps stay finished.
        </p>
        {prop.summary ? <p className="np-proposal-summary">{prop.summary}</p> : null}
        <section className={`np-preview is-${prop.preview.health}`} aria-label="If you apply it">
          <p className="np-health">
            <span className="np-health-mark" aria-hidden />
            If you approve it: {HEALTH_WORD[prop.preview.health]}
          </p>
          <p>{prop.preview.line}</p>
          <p className="np-footnote">
            {hours(prop.preview.remainingMin)} of work against {hours(p.capacityMin)} of your time before {shortDay(p.deadlineISO)}.
          </p>
          {prop.preview.pastDeadline.length ? (
            <p className="np-preview-warn">
              {prop.preview.pastDeadline.length} step{prop.preview.pastDeadline.length === 1 ? ' has' : 's have'} a date after your deadline: {prop.preview.pastDeadline.slice(0, 3).join('; ')}
              {prop.preview.pastDeadline.length > 3 ? '…' : ''}. You can remove {prop.preview.pastDeadline.length === 1 ? 'it' : 'them'} after approving.
            </p>
          ) : null}
        </section>
        {prop.findings.length ? (
          <section className="next-brief-block">
            <h3 className="next-brief-label">What it found</h3>
            <ul className="np-findings">
              {prop.findings.map((f, i) => (
                <li key={i}>
                  <span>{f.text}</span>
                  {f.source ? <small>{f.source}</small> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className="next-brief-block">
          <h3 className="next-brief-label">What would change</h3>
          <ul className="np-diff">
            {d.added.map((a) => (
              <li key={`a${a.id}`} className="is-add">
                <span aria-label="new">+</span>
                {a.title}
              </li>
            ))}
            {d.changed.map((c) => (
              <li key={`c${c.id}`} className="is-change">
                <span aria-label="changed">~</span>
                {c.title}
                <small>{c.what.join(', ')}</small>
              </li>
            ))}
            {d.removed.map((r) => (
              <li key={`r${r.id}`} className="is-drop">
                <span aria-label="dropped">−</span>
                {r.title}
              </li>
            ))}
            {d.kept ? <li className="is-keep">{d.kept} step{d.kept === 1 ? '' : 's'} unchanged</li> : null}
          </ul>
        </section>
        <div className="np-form-actions is-sheet">
          <button type="button" className="next-secondary" onClick={() => onDecide('discard')} disabled={busy}>
            Throw away
          </button>
          <button type="button" className="next-primary" onClick={() => onDecide('apply')} disabled={busy}>
            {busy ? <Spinner size={15} /> : <Check size={16} strokeWidth={2} />} Approve plan
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// --------------------------------------------------------------------------
// New project

export function NewProjectSheet({ onClose, onCreated, space: startSpace }: { onClose: () => void; onCreated: (p: NextProject) => void; space: NextSpace }) {
  const [space, setSpace] = useState<NextSpace>(startSpace);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [deadline, setDeadline] = useState('');
  const [wd, setWd] = useState(90);
  const [we, setWe] = useState(180);
  const [inspect, setInspect] = useState(true);
  const [busy, setBusy] = useState(false);
  const ok = title.trim() && /^\d{4}-\d{2}-\d{2}$/.test(deadline);
  const create = async () => {
    setBusy(true);
    try {
      let p = await api.nextCreateProject({ title: title.trim(), goal: goal.trim(), deadline, space, capacity: { weekdayMin: wd, weekendMin: we } });
      if (inspect) {
        try {
          p = await api.nextInspect(p.id);
        } catch {
          toast('Created. The progress check did not start; try it from the project.', { tone: 'error' });
        }
      }
      haptic('success');
      onCreated(p);
    } catch {
      toast('Could not create it. Check the date.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet side="bottom" title="New project" subtitle="A goal with a date" onClose={onClose}>
      <form
        className="np-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void create();
        }}
      >
        <label>
          <span>Name</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={space === 'school' ? 'AP Lang research paper' : 'College applications'} maxLength={90} autoFocus />
        </label>
        <SpaceChoice value={space} onChange={setSpace} />
        <label>
          <span>What done means</span>
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="All 15 submitted, essays final" maxLength={280} />
        </label>
        <label>
          <span>Deadline</span>
          <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
        <Stepper label="School days" value={wd} onChange={setWd} />
        <Stepper label="Weekends" value={we} onChange={setWe} />
        <label className="np-switch">
          <input type="checkbox" checked={inspect} onChange={(e) => setInspect(e.target.checked)} />
          <span>
            <strong>Check progress now</strong>
            Next reads your notes and pages and suggests the steps. You approve before anything changes.
          </span>
        </label>
        <button type="submit" className="next-primary" disabled={!ok || busy}>
          {busy ? <Spinner size={15} /> : null} Create project
        </button>
      </form>
    </Sheet>
  );
}


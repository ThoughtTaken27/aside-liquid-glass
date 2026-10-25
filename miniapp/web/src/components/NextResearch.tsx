import { Shine } from './Affect';
/**
 * Research: things Next looked up because you asked.
 *
 * Report layout borrows from Perplexity (numbered source chips on each
 * point, a sources list with the site's name), Gemini Deep Research
 * ("sources used"), and Elicit (every point traceable to a source).
 * Confidence is stated in words because models are poor at signalling it
 * on their own (OpenAI's deep research notes say so).
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Spinner } from './Icons';
import { Sheet } from './Sheet';
import { toast } from './Toasts';
import { api } from '../api';
import type { ResearchBrief } from '../types';
import { Group } from './NextToday';
import { clock, dayLabel, dayKey } from '../utils/nextPlanFormat';

const VERDICT_WORD: Record<string, string> = { yes: 'Worth it', no: 'Skip it', unclear: 'Not sure' };

function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));
}

export function ResearchView({ onOpen, refreshKey, suggestions = [] }: { onOpen: (b: ResearchBrief) => void; refreshKey: number; suggestions?: string[] }) {
  const [briefs, setBriefs] = useState<ResearchBrief[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const now = new Date();

  const load = useCallback(async () => {
    try {
      setBriefs((await api.researchList()).briefs);
    } catch {
      setBriefs((b) => b ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const working = (briefs ?? []).filter((b) => b.state === 'preparing' || b.state === 'running');
  useEffect(() => {
    if (!working.length) return;
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, [working.length, load]);

  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    setBusy(true);
    try {
      await api.researchStart({ question });
      setQ('');
      toast('Next will look into it and bring back an answer with sources.');
      await load();
    } catch (e) {
      const m = String((e as Error)?.message ?? '');
      toast(m.includes('423') ? 'Next is paused. Turn it back on in Activity.' : m.includes('429') ? 'That is a lot of questions this hour. Try again later.' : 'Could not start that. Try again.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const answers = (briefs ?? []).filter((b) => b.state === 'ready');
  const failed = (briefs ?? []).filter((b) => b.state === 'failed');

  return (
    <div className="n3-research">
      <header className="n3-title-block">
        <h1 className="n3-title">Research</h1>
        <p className="n3-subtitle">Next looks things up only when you ask, and never acts on what it finds.</p>
      </header>

      <form
        className="n3-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <label htmlFor="n3-ask-input" className="np-sr">
          What should Next look into?
        </label>
        <input
          id="n3-ask-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="What should Next look into?"
          maxLength={300}
          enterKeyHint="send"
        />
        <button type="submit" className="n3-ask-go" disabled={!q.trim() || busy} aria-label="Look it up">
          {busy ? <Spinner size={15} /> : 'Ask'}
        </button>
      </form>

      {!briefs ? (
        <div className="n3-skel-list" aria-hidden>
          <span className="n3-skel" />
          <span className="n3-skel is-short" />
          <span className="n3-skel" />
        </div>
      ) : null}

      {working.length ? (
        <Group title="Looking into" count={working.length}>
          {working.map((b) => (
            <button key={b.id} type="button" className="n3-row" onClick={() => onOpen(b)}>
              <span className="n3-live-dot is-busy" aria-hidden />
              <span className="n3-row-body">
                <span className="n3-row-title">{b.title}</span>
                <span className="n3-row-meta">
                  <Shine text={b.state === 'preparing'
                    ? `Getting a locked helper ready${b.readyInMin ? `, about ${b.readyInMin} min` : ''}`
                    : b.sourcesRead
                      ? `Reading sources, ${b.sourcesRead} so far`
                      : 'Reading sources'} />
                </span>
              </span>
            </button>
          ))}
        </Group>
      ) : null}

      {answers.length ? (
        <Group title="Answers" count={answers.length}>
          {answers.map((b) => (
            <button key={b.id} type="button" className="n3-row n3-answer-row" onClick={() => onOpen(b)}>
              <span className={`n3-verdict-mark is-${b.report?.verdict ?? 'none'}`} aria-hidden />
              <span className="n3-row-body">
                <span className="n3-row-title">{b.report?.title || b.title}</span>
                <span className="n3-row-meta n3-clamp-2">
                  {b.report?.verdict ? `${b.report.verdictLabel || VERDICT_WORD[b.report.verdict]}. ` : ''}
                  {b.report?.summary}
                </span>
              </span>
              <span className="n3-row-end">{b.finishedAt ? (dayKey(new Date(b.finishedAt)) === dayKey(now) ? clock(b.finishedAt) : dayLabel(dayKey(new Date(b.finishedAt)), now)) : ''}</span>
            </button>
          ))}
        </Group>
      ) : null}

      {failed.length ? (
        <Group title="Didn't finish" count={failed.length}>
          {failed.map((b) => (
            // AI SDK Agents' Research job: a stopped job keeps a way back in.
            // "Ask again" only fills the box (like the suggestions), so nothing
            // runs until Ask is tapped.
            <div key={b.id} className="n3-row n3-answer-row n3-failed-row">
              <span className="n3-verdict-mark is-stopped" aria-hidden />
              <button type="button" className="n3-row-body" onClick={() => onOpen(b)}>
                <span className="n3-row-title">{b.title}</span>
                <span className="n3-row-meta">{b.error ?? 'It stopped before it had an answer.'}</span>
              </button>
              <button
                type="button"
                className="craft-ghost n3-again"
                aria-label={`Ask again: ${b.question || b.title}`}
                onClick={() => {
                  setQ(b.question || b.title);
                  const input = document.getElementById('n3-ask-input') as HTMLInputElement | null;
                  input?.focus();
                  input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }}
              >
                Ask again
              </button>
            </div>
          ))}
        </Group>
      ) : null}

      {briefs && !briefs.length ? (
        <section className="n3-empty is-left">
          <p className="n3-empty-title">Nothing looked up yet</p>
          <p className="n3-empty-line">Answers come back here with their sources. Next only reads; it never acts on what it finds.</p>
          {suggestions.length ? (
            <div className="n3-suggest" role="group" aria-label="Questions you could ask">
              <p className="n3-suggest-label">From your list</p>
              {suggestions.slice(0, 3).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="n3-suggest-row"
                  onClick={() => {
                    setQ(t);
                    document.getElementById('n3-ask-input')?.focus();
                  }}
                >
                  <span>{t}</span>
                  <span className="n3-suggest-hint" aria-hidden>
                    Fill in
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------

export function ReportSheet({ brief, onClose, onDismissed, onOpenUrl }: { brief: ResearchBrief; onClose: () => void; onDismissed: () => void; onOpenUrl: (url: string) => void }) {
  const r = brief.report;
  const [focusN, setFocusN] = useState<number | null>(null);
  const took = minutesBetween(brief.startedAt, brief.finishedAt);
  const audit = brief.audit ?? null;
  const warnings: string[] = [];
  if (audit?.sources.some((x) => x.bait)) warnings.push('A page it read had hidden text aimed at AI. Treat this brief with care.');
  if ((audit?.pushy ?? 0) >= 0.8) warnings.push('This brief tells you to log in, click, or share something. Check it yourself before you do.');
  if ((audit?.bait ?? 0) >= 0.8) warnings.push('Part of this brief reads like instructions to an AI.');
  const judged = audit ? audit.points.filter((x) => x != null) : [];
  const read = audit ? audit.sources.filter((x) => x.fetched).length : 0;
  const checkedLine = audit
    ? read
      ? `Double-checked: re-read ${read} of ${audit.sources.length} cited page${audit.sources.length === 1 ? '' : 's'}; ${judged.filter((x) => x! >= 0.35).length} of ${judged.length} checked point${judged.length === 1 ? '' : 's'} match their source.`
      : audit.skipped
        ? "Couldn't double-check this one yet."
        : "Couldn't re-open its pages to double-check."
    : null;
  const remove = async () => {
    try {
      await api.researchDismiss(brief.id);
      onDismissed();
    } catch {
      toast('Could not remove it. Try again.', { tone: 'error' });
    }
  };
  return (
    <Sheet side="bottom" title={r?.title || brief.title} subtitle={brief.question !== brief.title ? brief.question : undefined} onClose={onClose}>
      <div className="n3-sheet n3-report">
        {!r ? (
          <p className="n3-help-state">
            {brief.state === 'failed'
              ? brief.error ?? 'It stopped before it had an answer.'
              : brief.state === 'preparing'
                ? `Getting a locked helper ready${brief.readyInMin ? `, about ${brief.readyInMin} min` : ''}. Then it starts reading.`
                : 'Reading sources. The answer shows up here when it is done.'}
          </p>
        ) : (
          <>
            {r.verdict ? (
              <p className={`n3-verdict is-${r.verdict}`}>
                <span className={`n3-verdict-mark is-${r.verdict}`} aria-hidden />
                {r.verdictLabel || VERDICT_WORD[r.verdict]}
              </p>
            ) : null}
            {warnings.length ? (
              <div className="n3-audit-warn" role="note">
                {warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </div>
            ) : null}
            <p className="n3-report-summary">{r.summary}</p>

            {r.points.length ? (
              <ol className="n3-points">
                {r.points.map((p, i) => (
                  <li key={i}>
                    <span>{p.text}</span>
                    {p.cites.length ? (
                      <span className="n3-cites">
                        {p.cites.map((n) => (
                          <button key={n} type="button" className={`n3-cite${focusN === n ? ' is-on' : ''}`} onClick={() => setFocusN(focusN === n ? null : n)} aria-label={`Source ${n}`}>
                            {n}
                          </button>
                        ))}
                      </span>
                    ) : null}
                    {audit && audit.points[i] != null && audit.points[i]! < 0.35 ? <span className="n3-unbacked">Its source doesn't clearly say this</span> : null}
                  </li>
                ))}
              </ol>
            ) : null}

            {r.open.length ? (
              <section className="n3-report-block">
                <h3 className="n3-sheet-head">Still open</h3>
                <ul className="n3-open">
                  {r.open.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {r.sources.length ? (
              <section className="n3-report-block">
                <h3 className="n3-sheet-head">
                  Sources <span>{r.sources.length}</span>
                </h3>
                <ol className="n3-sources">
                  {r.sources.map((s) => (
                    <li key={s.n} className={focusN === s.n ? 'is-on' : ''}>
                      <button type="button" onClick={() => onOpenUrl(s.url)}>
                        <span className="n3-src-n">{s.n}</span>
                        <span className="n3-src-text">
                          <span className="n3-src-title">{s.title || s.host}</span>
                          <span className="n3-src-host">
                            {s.host}
                            {audit?.sources.find((x) => x.n === s.n)?.bait ? <span className="n3-src-bait"> · had text aimed at AI</span> : null}
                          </span>
                        </span>
                        <ArrowUpRight size={15} strokeWidth={1.75} />
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            <p className="n3-report-how">
              How sure: {r.confidence === 'high' ? 'fairly sure' : r.confidence === 'medium' ? 'somewhat sure' : 'not very sure'}. Read {brief.sourcesRead || r.sources.length} page{(brief.sourcesRead || r.sources.length) === 1 ? '' : 's'}
              {took ? ` in about ${took} min` : ''}. {brief.limits}
            </p>
            {checkedLine ? <p className="n3-report-how">{checkedLine}</p> : null}
          </>
        )}
        <button type="button" className="n3-text-btn is-muted n3-dismiss" onClick={() => void remove()}>
          {brief.state === 'running' || brief.state === 'preparing' ? 'Stop and remove' : 'Remove'}
        </button>
      </div>
    </Sheet>
  );
}

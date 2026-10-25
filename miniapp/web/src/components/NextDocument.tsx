import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Trash2 } from 'lucide-react';
import { api, ApiError } from '../api';
import type { NextItem } from '../types';
import type { DocumentView } from '../contextTypes';
import { contextChanged, contextEpoch, minimumContextRevision, onContextChanged } from '../utils/contextPrivacy';
import { ContextConfirmation } from './NextContext';

/** Canonical metadata only. No fetch, navigation, saved form value or account use. */
export function documentLinkURL(value: string): string | null {
  try {
    const u = new URL(value); if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || u.port || u.username || u.password || value.length > 2048) return null;
    const m = u.pathname.match(/\/(document|presentation|spreadsheets|forms)(?:\/u\/\d+)?\/d\/(?:e\/)?([\w-]{20,})/); if (!m) return null;
    return m[1] === 'forms' ? `https://docs.google.com/forms/d/e/${m[2]}/viewform` : `https://docs.google.com/${m[1]}/d/${m[2]}/edit`;
  } catch { return null; }
}
function issue(error: unknown): string {
  if (error instanceof ApiError && error.reason === 'document_already_linked') return 'This document is already linked to another task. Unlink it there first.';
  if (error instanceof ApiError && error.reason === 'context_source_required') return 'Enable context and Work trail in Activity before linking.';
  if (error instanceof ApiError && error.status === 409) return 'These settings changed on another screen. I refreshed them; try again.';
  if (error instanceof ApiError && error.status === 423) return 'Next is paused. Resume it before linking.';
  if (error instanceof ApiError && error.reason === 'invalid_document_link') return 'Use a normal Google Docs, Slides, Sheets or Forms link for this task.';
  return 'Linked-document settings are unavailable. No document is read or opened.';
}

export function DocumentLinkControl({ item }: { item: NextItem }) {
  const [rawView, setView] = useState<DocumentView | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const visibleError = error ?? readError;
  const [dialog, setDialog] = useState<'link' | 'unlink' | null>(null), [url, setURL] = useState('');
  const eligible = ['schoology', 'manual', 'project'].includes(item.source) && !item.taint && !item.flag;
  const view = rawView?.taskId === item.id ? rawView : null;
  const currentTask = useRef(item.id);
  const alive = useRef(true), busyRef = useRef(false), seq = useRef(0), lastRead = useRef(0), abort = useRef<AbortController | null>(null);
  const read = useCallback(async () => {
    if (!eligible) return;
    if (navigator.onLine === false || document.visibilityState !== 'visible') { seq.current += 1; setView(null); return; }
    abort.current?.abort(); const c = new AbortController(); abort.current = c;
    const sequence = ++seq.current, epoch = contextEpoch(), timeout = window.setTimeout(() => c.abort(), 15_000);
    try { const next = await api.nextContextDocument(item.id, c.signal); if (alive.current && seq.current === sequence && epoch === contextEpoch() && next.taskId === item.id && next.revision >= minimumContextRevision()) { lastRead.current = Date.now(); setView(next); setReadError(null); } }
    catch (e) { if (alive.current && seq.current === sequence) { setView(null); setReadError(issue(e)); } }
    finally { window.clearTimeout(timeout); }
  }, [item.id, eligible]);
  useEffect(() => {
    alive.current = true; currentTask.current = item.id; busyRef.current = false; setBusy(false); setView(null); setError(null); setReadError(null); setDialog(null); setURL(''); void read();
    const hide = () => { abort.current?.abort(); seq.current += 1; setView(null); setDialog(null); setURL(''); };
    const wake = () => { if (document.visibilityState === 'visible' && navigator.onLine !== false) void read(); else hide(); };
    const offline = () => { hide(); setReadError('Document context is hidden while offline.'); };
    const unsubscribe = onContextChanged(() => { hide(); if (!busyRef.current) void read(); });
    const poll = window.setInterval(() => { if (!busyRef.current) void read(); }, 15_000);
    const lease = window.setInterval(() => { if (lastRead.current && Date.now() - lastRead.current > 30_000) { lastRead.current = 0; hide(); } }, 1000);
    window.addEventListener('offline', offline); window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    return () => { alive.current = false; abort.current?.abort(); seq.current += 1; unsubscribe(); window.clearInterval(poll); window.clearInterval(lease); window.removeEventListener('offline', offline); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [read]);
  const save = async (nextURL: string | null) => {
    if (!view || busyRef.current) return; const taskKey = item.id; busyRef.current = true; setBusy(true); setError(null); abort.current?.abort(); seq.current += 1; setView(null);
    try { const next = await api.nextContextLinkDocument(item.id, nextURL, view.revision); contextChanged(next.revision); if (alive.current && currentTask.current === taskKey && next.revision >= minimumContextRevision()) setView(next); }
    catch (e) { if (alive.current && currentTask.current === taskKey) setError(issue(e)); }
    finally { if (currentTask.current === taskKey) busyRef.current = false; if (alive.current && currentTask.current === taskKey) { setBusy(false); setDialog(null); setURL(''); void read(); } }
  };
  if (!eligible) return null;
  const canonical = documentLinkURL(url);
  return <section className="nc-document" aria-label="Linked document">
    <div className="nc-document-head"><h3>Linked document</h3>{view?.available && view.enabled ? <button type="button" className="nc-link" disabled={busy} onClick={() => { setURL(view.binding?.url ?? ''); setDialog('link'); }}>{view.binding ? 'Change link' : 'Link document'}</button> : null}</div>
    {visibleError ? <p role="alert" className="nc-document-error">{visibleError}</p> : null}
    {view ? view.binding ? <><p>{view.enabled ? 'Linked by you. Visit timing stays an estimate, not proof of completed work.' : 'A link is saved. Context is off or paused, so it does not affect your plan.'}</p><div className="nc-document-actions">{view.enabled ? <a className="nc-link" href={view.binding.url} target="_blank" rel="noopener noreferrer">Open linked document <ExternalLink size={13} aria-hidden /></a> : null}<button type="button" className="nc-icon" aria-label="Unlink document" disabled={busy} onClick={() => setDialog('unlink')}><Trash2 size={15} aria-hidden /></button></div></> : <p>{!view.available ? 'This server does not support document links yet.' : view.enabled ? 'Link the exact document for this task. Next never guesses from similar titles.' : 'Enable context and Work trail in Activity to use document links.'}</p> : !visibleError ? <p>Checking saved document context…</p> : null}
    {dialog === 'link' && view ? <ContextConfirmation title={view.binding ? 'Change this document link?' : 'Link a document to this task'} description={view.binding ? 'Replace the saved task link and remove its prior matching document-visit facts. Original documents and source-reported task status stay untouched. No document is fetched, opened, read or sent to a model.' : 'Save only this document’s URL and task link on your Mac. No document is fetched, opened, read or sent to a model. Only existing, opted-in visit estimates can inform your plan.'} action="Save link" busy={busy} disabled={!canonical} onClose={() => { setDialog(null); setURL(''); }} onConfirm={() => { if (canonical) void save(canonical); }}><label className="nc-document-input">Google Docs, Slides, Sheets or Forms link<input type="url" aria-label="Document link" value={url} onChange={e => setURL(e.target.value)} autoComplete="off" spellCheck={false} maxLength={2048} placeholder="https://docs.google.com/document/d/…" /></label>{url && !canonical ? <p className="nc-document-validation" role="status">Use the normal share link, without a username, password or lookalike domain.</p> : null}</ContextConfirmation> : null}
    {dialog === 'unlink' && view ? <ContextConfirmation title="Unlink this document?" description="Remove this saved relationship and prior matching document-visit facts for the task. The original document, task and source-reported task status stay untouched." action="Unlink" danger busy={busy} onClose={() => setDialog(null)} onConfirm={() => void save(null)} /> : null}
  </section>;
}

/** Closed, code-created display vocabulary. No model HTML, URLs, scripts or action payloads. */
import { scanText } from '../inbox.js';
import type { NextItem, NextPlan } from '../next.js';
import type { WeatherFacts } from './web.js';

export type VoicePresentation =
  | { kind: 'plan'; title: string; checkedAt: string | null; items: Array<{ title: string; context: string; due: string; minutes: number | null }> }
  | { kind: 'weather'; period: 'Now' | 'Tomorrow'; temperature: number | null; feels: number | null; sky: string; high: number; low: number; rain: number; source: 'open-meteo.com' }
  | { kind: 'sources'; hosts: string[] }
  | { kind: 'handoff'; title: 'Not started'; request: string; next: string };

export function displayText(raw: string, max: number): string {
  return raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** School questions do not leak personal tasks, mail actions or closed work into the model/UI. */
export function classItems(plan: NextPlan): NextItem[] {
  const seen = new Set<string>();
  return [plan.now, ...plan.next, ...plan.later].filter((x): x is NextItem => Boolean(x)).filter(x => {
    if (x.space !== 'school' || !['schoology', 'manual'].includes(x.source) || (x.source === 'manual' && x.kind !== 'coursework') || x.taint === 'email' || x.flag === 'suspicious' || x.status !== 'open') return false;
    if (scanText(`${x.title}\n${x.context}`, { external: true }).suspicious) return false;
    const identity = x.id || `${x.title}\n${x.context}\n${x.dueISO}`;
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
}

export function planPresentation(plan: NextPlan): Extract<VoicePresentation, { kind: 'plan' }> {
  return {
    kind: 'plan', title: 'Your classwork',
    checkedAt: (() => { const at = plan.sources?.find(s => s.id === 'schoology')?.updatedAt; return at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null; })(),
    items: classItems(plan).slice(0, 3).map(x => ({
      title: displayText(x.title, 140), context: displayText(x.context, 70),
      // Date only: an imported timestamp does not establish a precise due-time policy.
      due: listedDate(x.dueISO),
      minutes: Number.isFinite(x.estMinutes) && x.estMinutes! > 0 ? Math.min(240, Math.round(x.estMinutes!)) : null,
    })),
  };
}

export function weatherPresentation(w: WeatherFacts, tomorrow: boolean): Extract<VoicePresentation, { kind: 'weather' }> {
  const day = tomorrow ? w.tomorrow : w;
  return { kind: 'weather', period: tomorrow ? 'Tomorrow' : 'Now', temperature: tomorrow ? null : w.nowF,
    feels: tomorrow ? null : w.feelsF, sky: displayText(day.sky, 50), high: day.highF, low: day.lowF, rain: day.rainChance, source: 'open-meteo.com' };
}

export function sourcePresentation(hosts: string[]): Extract<VoicePresentation, { kind: 'sources' }> {
  return { kind: 'sources', hosts: [...new Set(hosts)].filter(h => /^[a-z0-9.-]{1,120}$/i.test(h) && h.includes('.')).slice(0, 3) };
}

export function listedDate(iso: string | null): string {
  if (!iso) return 'No listed date';
  const value = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? `Listed ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Chicago' })}` : 'No listed date';
}

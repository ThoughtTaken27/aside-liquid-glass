import type { ThreadItem } from '../types';

/**
 * An error card is only news while it is the last word.
 *
 * A turn can hit a transient failure (a timed-out request, an overloaded
 * provider) and carry on. Once anything comes after the error, or a turn is
 * running again, the error has been recovered from, so its card is dropped
 * instead of sitting above a run that is going fine. An error that actually
 * stopped the work stays: nothing follows it and nothing is running.
 *
 * Returns the same array when nothing is hidden, so the virtualized list
 * does not see a new identity on every render.
 */
export function withoutResolvedErrors(items: ThreadItem[], busy: boolean): ThreadItem[] {
  let lastOther = -1;
  let hasError = false;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].kind === 'error') hasError = true;
    else lastOther = i;
  }
  if (!hasError) return items;
  const kept = items.filter((item, i) => item.kind !== 'error' || (!busy && i > lastOther));
  return kept.length === items.length ? items : kept;
}

/** Stable progress, not metadata/status churn or a newly replayed error. */
export function transcriptProgressKey(items: ThreadItem[]): string | null {
  for(let i=items.length-1;i>=0;i--){
    const item=items[i];if(item.kind==='error')continue;
    if(item.kind==='work'){const part=item.items[item.items.length-1];return item.id+':'+(part?part.id+(part.kind==='text'?':'+part.text:''):'');}
    if(item.kind==='question')return item.id+':'+item.status;
    if(item.kind==='answer'||item.kind==='streaming')return item.id+':'+item.text;
    return item.id;
  }
  return null;
}

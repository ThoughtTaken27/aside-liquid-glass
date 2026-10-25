/** Explicit disclosure intent, not a live-update request to steal scrolling. */
export const ACTIVITY_REVEAL_EVENT = 'aside:activity-expand';
export function requestActivityReveal(button: HTMLElement, expanded = true): void {
  const target = button.closest<HTMLElement>('[data-content-surface="activity-fold"], [data-content-surface="activity-group"]');
  if (target) target.dispatchEvent(new CustomEvent(ACTIVITY_REVEAL_EVENT, { bubbles: true, detail: { target, expanded } }));
}

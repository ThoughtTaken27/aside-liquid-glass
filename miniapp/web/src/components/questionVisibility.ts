/** Move only the active question interaction, never an unrelated thread or page. */
export function keepQuestionTargetVisible(root: HTMLElement | null, target: HTMLElement | null, includeHeader = false) {
  const scroller = root?.closest<HTMLElement>('.thread-scroll');
  if (!root || !target || !scroller) return;
  const app = root.closest('.app-thread');
  const viewport = root.ownerDocument.defaultView?.visualViewport;
  const area = scroller.getBoundingClientRect();
  const header = app?.querySelector('.thread-header')?.getBoundingClientRect();
  const footer = app?.querySelector('.thread-footer')?.getBoundingClientRect();
  const top = Math.max(area.top, header?.bottom ?? area.top, viewport?.offsetTop ?? 0) + 8;
  const bottom = Math.min(area.bottom, footer?.top ?? area.bottom, viewport ? viewport.offsetTop + viewport.height : Infinity) - 8;
  if (bottom <= top) return;
  const rect = target.getBoundingClientRect();
  const start = includeHeader ? root.getBoundingClientRect().top : rect.top;
  const delta = rect.bottom - start > bottom - top || start < top ? start - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
  if (Math.abs(delta) > .5) scroller.scrollBy({ top: delta, behavior: 'instant' });
}

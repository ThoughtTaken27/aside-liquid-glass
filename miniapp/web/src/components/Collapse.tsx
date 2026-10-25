import { Children, isValidElement, useEffect, useId, useLayoutEffect, useState, type HTMLAttributes, type ReactNode } from 'react';

export const COLLAPSE_MS = 320;

/** One reversible fold. Closing disables interaction immediately, but keeps
 * the content until its grid row reaches zero. Reopening cancels removal. */
export function Collapse({ open, children, className = '', id }: { open: boolean; children: ReactNode; className?: string; id?: string }) {
  const [present, setPresent] = useState(open);
  useLayoutEffect(() => { if (open) setPresent(true); }, [open]);
  useEffect(() => {
    if (open || !present) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setPresent(false); return; }
    const timer = window.setTimeout(() => setPresent(false), COLLAPSE_MS + 34);
    return () => window.clearTimeout(timer);
  }, [open, present]);
  return <div className={`motion-collapse ${className}`} id={id} data-open={open ? 'true' : 'false'} aria-hidden={!open} inert={!open || undefined}
    onTransitionEnd={e => { if (e.target === e.currentTarget && e.propertyName === 'grid-template-rows' && !open) setPresent(false); }}>
    <div className="motion-collapse-inner">{open || present ? children : null}</div>
  </div>;
}

/** Accessible replacement for native details, whose body otherwise vanishes
 * immediately on close. Call sites retain their authored summary markup. */
export function Disclosure({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const [first, ...body] = Children.toArray(children);
  const summary = isValidElement<{ children: ReactNode; className?: string }>(first) ? first.props : { children: first };
  return <div {...props} className={`motion-disclosure ${className}`} data-open={open ? 'true' : 'false'}>
    <button type="button" className={`disclosure-summary ${summary.className ?? ''}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}>{summary.children}</button>
    <Collapse id={id} open={open}>{body}</Collapse>
  </div>;
}

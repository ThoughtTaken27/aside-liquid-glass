import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { NextSpace } from '../types';

/**
 * Suggest School or Personal from a title as he types. Waits for a pause
 * (600 ms), ignores stale answers, and goes quiet after an error.
 */
export function useSpaceHint(title: string, enabled: boolean): NextSpace | null {
  const [hint, setHint] = useState<NextSpace | null>(null);
  const seq = useRef(0);
  const off = useRef(false);
  useEffect(() => {
    const t = title.trim();
    if (!enabled || off.current || t.length < 4) {
      setHint(null);
      return;
    }
    const my = ++seq.current;
    const timer = window.setTimeout(() => {
      api
        .nextSuggestSpace(t)
        .then((r) => {
          if (my === seq.current) setHint(r.hint?.space ?? null);
        })
        .catch(() => {
          off.current = true;
        });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [title, enabled]);
  return hint;
}

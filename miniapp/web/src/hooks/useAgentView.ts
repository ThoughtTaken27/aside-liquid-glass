import { useCallback, useRef, useState } from 'react';
/** Reopened threads are always manual; a newly created thread gets one reveal. */
export function useAgentView(autoReveal: boolean, onAutoReveal?: () => void) {
  const [liveTab, setLiveTab] = useState<string | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);
  const eligible = useRef(autoReveal);
  const consumed = useRef(false);
  const consume = useRef(onAutoReveal);
  consume.current = onAutoReveal;
  const onLiveTab = useCallback((id: string | null, agentCreated = false) => {
    setLiveTab(id);
    if (id && agentCreated && eligible.current && !consumed.current) {
      consumed.current = true;
      setLiveOpen(true);
      consume.current?.();
    }
    if (!id) setLiveOpen(false);
  }, []);
  const show = useCallback((value?: boolean) => {
    consumed.current = true; // the user's choice wins over later tab changes
    setLiveOpen(current => value ?? !current);
  }, []);
  return { liveTab, liveOpen, onLiveTab, show };
}

'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from './api';

export type Load<T> =
  { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; message: string };

/** Runs `load` on mount and whenever `key` changes; `reload` runs it again. A stale answer never wins. */
export function useLoad<T>(load: () => Promise<T>, key: string): Load<T> & { reload: () => void } {
  const [result, setResult] = useState<Load<T>>({ state: 'loading' });
  const [round, setRound] = useState(0);
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    let live = true;
    setResult((r) => (r.state === 'ready' ? r : { state: 'loading' }));
    latest.current().then(
      (data) => live && setResult({ state: 'ready', data }),
      (error: unknown) => live && setResult({ state: 'error', message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [key, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { ...result, reload };
}

import { useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query. On the server it returns `serverValue`, so the first paint matches the
 * desktop layout and the client corrects it after hydration.
 */
export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

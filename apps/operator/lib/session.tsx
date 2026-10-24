'use client';
// The signed-in operator for every console page. It reads GET /me once, keeps the CSRF token for the client, and
// sends the operator to /login when the API says the session has ended (8 hours, or 30 idle minutes).
import type { OperatorMe } from '@canopy/contracts';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { createOperatorClient, isOperatorApiError, type OperatorClient } from './api';
import { consolePath } from './security/console-path';

type Session = { me: OperatorMe; api: OperatorClient; signOut: () => Promise<void> };

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}

/** The sign-in page's address that brings the operator back to `path` (only console paths, never another site). */
export function loginHref(path: string): string {
  const safe = consolePath(path);
  return safe && safe !== '/' ? `/login?next=${encodeURIComponent(safe)}` : '/login';
}

export type SessionState =
  { state: 'loading' } | { state: 'ready'; me: OperatorMe } | { state: 'error'; message: string };

export function SessionProvider({
  path,
  navigate,
  children,
  fetchImpl,
}: {
  /** The current path, for the way back after signing in again. */
  path: string;
  /** Replaces the location (Next's router.replace in the app). */
  navigate: (href: string) => void;
  children: (state: SessionState) => ReactNode;
  fetchImpl?: typeof fetch;
}) {
  const [state, setState] = useState<SessionState>({ state: 'loading' });
  const csrf = useRef<string | undefined>(undefined);
  const where = useRef(path);
  where.current = path;
  const go = useRef(navigate);
  go.current = navigate;

  const api = useMemo(
    () =>
      createOperatorClient({
        fetch: fetchImpl,
        csrfToken: () => csrf.current,
        onSignedOut: () => go.current(loginHref(where.current)),
      }),
    [fetchImpl],
  );

  useEffect(() => {
    let live = true;
    api.call('operatorMe').then(
      (me) => {
        csrf.current = me.csrfToken;
        if (live) setState({ state: 'ready', me });
      },
      (error: unknown) => {
        if (!live || isOperatorApiError(error, 'UNAUTHENTICATED')) return;
        setState({
          state: 'error',
          message: 'The console could not load your session. Reload the page.',
        });
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const session = useMemo<Session | null>(() => {
    if (state.state !== 'ready') return null;
    return {
      me: state.me,
      api,
      signOut: async () => {
        try {
          await api.call('operatorLogout');
        } finally {
          csrf.current = undefined;
          go.current('/login');
        }
      },
    };
  }, [state, api]);

  return <SessionContext.Provider value={session}>{children(state)}</SessionContext.Provider>;
}

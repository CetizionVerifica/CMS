// Server-side access to the API for Server Components and Server Actions. Forwards the browser's cookies, so the API
// sees the user's session; the tenant always comes from that session, never from the web app (api-conventions.md §1).
import 'server-only';

import type { Me } from '@canopy/contracts';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import { createApiClient, isApiError, type ApiClient } from './client';
import { mockFetch } from './mock';
import { apiMode } from './mode';
import { parseSetCookie } from './set-cookie';

/** True while no real API is configured (see mode.ts): the in-process mock answers instead. */
export async function usingMockApi(): Promise<boolean> {
  return apiMode(process.env) === 'mock';
}

async function forwardedCookie(): Promise<string | undefined> {
  const header = (await headers()).get('cookie');
  return header ?? undefined;
}

export async function serverApi(csrfToken?: string): Promise<ApiClient> {
  const requestId = (await headers()).get('x-request-id') ?? undefined;
  return createApiClient({
    baseUrl: process.env.CANOPY_API_URL ?? 'http://mock.invalid',
    fetch: (await usingMockApi()) ? mockFetch : undefined,
    cookie: await forwardedCookie(),
    csrfToken,
    requestId,
  });
}

/** The signed-in user, once per request. Null when there is no valid session. */
export const getMe = cache(async (): Promise<Me | null> => {
  try {
    return (await (await serverApi()).me()).data;
  } catch (error) {
    if (isApiError(error, 'UNAUTHENTICATED')) return null;
    throw error;
  }
});

/**
 * Whether the session still owes the MFA step. Only roles that require MFA (firm admins and consultants) owe it:
 * `satisfied` says whether this session passed MFA, so it stays false for a client user who never needs to.
 */
export function mfaPending(me: Me): boolean {
  return me.mfa.required && !me.mfa.satisfied;
}

/** The signed-in user, or a redirect to the login page that comes back to `returnTo`. */
export async function requireMe(returnTo: string): Promise<Me> {
  const me = await getMe();
  if (!me) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  if (mfaPending(me)) redirect(`/login/verify?next=${encodeURIComponent(returnTo)}`);
  return me;
}

/** Applies the API's Set-Cookie headers to the browser response (login, MFA, invite accept, logout). */
export async function relayCookies(setCookies: string[]): Promise<void> {
  const jar = await cookies();
  const secure = process.env.NODE_ENV === 'production' && !(await usingMockApi());
  for (const header of setCookies) {
    const parsed = parseSetCookie(header, secure);
    if (parsed) jar.set(parsed);
  }
}

/** API client for state-changing calls in a session: adds the CSRF token from GET /me (api-conventions.md §1). */
export async function sessionApi(): Promise<ApiClient> {
  const me = await getMe();
  return serverApi(me?.csrfToken);
}

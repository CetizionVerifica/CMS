// Server-side data for the shell: the user, their clients, overdue counts for the switcher and the Approvals badge.
import 'server-only';

import { cookies, headers } from 'next/headers';
import { cache } from 'react';

import { requireMe, serverApi } from '../api/server';
import { sessionCache } from '../api/session-cache';
import { initialLayout, LAYOUT_COOKIE, type ShellLayout } from '../layout-hint';
import { APPROVAL_ROLES, buildShellModel, isFirmUser, rolesFor, type ShellModel } from './model';

import { PATH_HEADER } from './path-header';

/** The requested path and query, set by proxy.ts. */
export async function requestPath(): Promise<string> {
  return (await headers()).get(PATH_HEADER) ?? '/';
}

// The switcher's overdue counts come from the whole portfolio, the API's heaviest read. They are a hint, so a session
// reuses them for 30 seconds instead of asking on every render and prefetch (security review F7).
const overdueCache = sessionCache<Record<string, number>>(30_000);

async function overdueCounts(
  api: Awaited<ReturnType<typeof serverApi>>,
): Promise<Record<string, number>> {
  const cookie = (await headers()).get('cookie');
  const cached = cookie ? overdueCache.get(cookie) : undefined;
  if (cached) return cached;
  try {
    const { data } = await api.portfolio();
    const counts = Object.fromEntries(data.items.map((r) => [r.clientId, r.result.counts.OVERDUE]));
    if (cookie) overdueCache.set(cookie, counts);
    return counts;
  } catch {
    return {};
  }
}

export const loadShell = cache(async (): Promise<ShellModel> => {
  const me = await requireMe(await requestPath());
  const firm = isFirmUser(me);
  const approver = rolesFor(me).some((r) => APPROVAL_ROLES.includes(r));
  if (!firm && !approver) return buildShellModel(me);
  const api = await serverApi();
  // The shell works without these counts, so a failed call only hides its count.
  const [overdue, waiting] = await Promise.all([
    firm ? overdueCounts(api) : {},
    approver ? api.approvalsWaiting().catch(() => 0) : 0,
  ]);
  return buildShellModel(me, overdue, waiting);
});

export async function shellLayoutHint(): Promise<ShellLayout> {
  return initialLayout(await headers(), (await cookies()).get(LAYOUT_COOKIE)?.value);
}

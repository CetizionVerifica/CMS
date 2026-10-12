// Server-side data for the shell: the user, their clients, overdue counts for the switcher and the Approvals badge.
import 'server-only';

import { cookies, headers } from 'next/headers';
import { cache } from 'react';

import { requireMe, serverApi } from '../api/server';
import { initialLayout, LAYOUT_COOKIE, type ShellLayout } from '../layout-hint';
import { APPROVAL_ROLES, buildShellModel, isFirmUser, rolesFor, type ShellModel } from './model';

import { PATH_HEADER } from './path-header';

/** The requested path and query, set by proxy.ts. */
export async function requestPath(): Promise<string> {
  return (await headers()).get(PATH_HEADER) ?? '/';
}

export const loadShell = cache(async (): Promise<ShellModel> => {
  const me = await requireMe(await requestPath());
  const firm = isFirmUser(me);
  const approver = rolesFor(me).some((r) => APPROVAL_ROLES.includes(r));
  if (!firm && !approver) return buildShellModel(me);
  const api = await serverApi();
  // The shell works without these counts, so a failed call only hides its count.
  const [overdue, waiting] = await Promise.all([
    firm
      ? api.portfolio().then(
          ({ data }) =>
            Object.fromEntries(data.items.map((r) => [r.clientId, r.result.counts.OVERDUE])),
          () => ({}),
        )
      : {},
    approver ? api.approvalsWaiting().catch(() => 0) : 0,
  ]);
  return buildShellModel(me, overdue, waiting);
});

export async function shellLayoutHint(): Promise<ShellLayout> {
  return initialLayout(await headers(), (await cookies()).get(LAYOUT_COOKIE)?.value);
}

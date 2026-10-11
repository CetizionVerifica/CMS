// Server-side data for the shell: the user, their clients and overdue counts for the switcher.
import 'server-only';

import { cookies, headers } from 'next/headers';
import { cache } from 'react';

import { requireMe, serverApi } from '../api/server';
import { initialLayout, LAYOUT_COOKIE, type ShellLayout } from '../layout-hint';
import { buildShellModel, type ShellModel } from './model';

import { PATH_HEADER } from './path-header';

/** The requested path and query, set by proxy.ts. */
export async function requestPath(): Promise<string> {
  return (await headers()).get(PATH_HEADER) ?? '/';
}

export const loadShell = cache(async (): Promise<ShellModel> => {
  const me = await requireMe(await requestPath());
  const model = buildShellModel(me);
  if (!model.isFirmUser) return model;
  // Overdue counts come from the portfolio. The switcher still works without them, so a failure here only hides counts.
  try {
    const rows = (await (await serverApi()).portfolio()).data;
    return buildShellModel(
      me,
      Object.fromEntries(rows.map((r) => [r.clientId, r.result.counts.OVERDUE])),
    );
  } catch {
    return model;
  }
});

export async function shellLayoutHint(): Promise<ShellLayout> {
  return initialLayout(await headers(), (await cookies()).get(LAYOUT_COOKIE)?.value);
}

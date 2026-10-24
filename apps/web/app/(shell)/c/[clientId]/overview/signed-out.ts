import 'server-only';

import { redirect } from 'next/navigation';

import { isApiError } from '../../../../../lib/api/client';
import { requestPath } from '../../../../../lib/shell/server';

/**
 * Sends a page's API refusal for a missing or half-finished sign-in to the login steps, as the shell layout does.
 * Next renders a page alongside its layout, so a page's own call can meet the expired session before the layout's
 * redirect lands; without this the refusal is logged as an unhandled error. Any other error is left to the caller.
 */
export async function redirectIfSignedOut(error: unknown): Promise<void> {
  if (isApiError(error, 'UNAUTHENTICATED')) {
    redirect(`/login?next=${encodeURIComponent(await requestPath())}`);
  }
  if (isApiError(error, 'MFA_REQUIRED')) {
    redirect(`/login/verify?next=${encodeURIComponent(await requestPath())}`);
  }
}

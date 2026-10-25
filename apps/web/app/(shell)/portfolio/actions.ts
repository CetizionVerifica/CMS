'use server';
// The Server Action behind "Add a client" on the portfolio. The name comes from the browser, so it is checked against
// the contracts' schema first (root rule 7); the API checks the caller is an account admin and audits the new client.
import { ClientCreateBody } from '@canopy/contracts';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { isApiError } from '../../../lib/api/client';
import { sessionApi } from '../../../lib/api/server';
import { forgetSession } from '../../../lib/api/session-cache';
import { redirectIfSignedOut } from '../c/[clientId]/overview/signed-out';

export type AddClientResult = { ok: true; id: string } | { ok: false; message: string };

/** Creates a client with the default settings (India's FY, Asia/Kolkata), which its setup pages can change. */
export async function addClientAction(name: string): Promise<AddClientResult> {
  const parsed = ClientCreateBody.safeParse({ name });
  if (!parsed.success) return { ok: false, message: 'Type a name of up to 300 characters.' };
  try {
    const { data } = await (await sessionApi()).call('createClient', { body: parsed.data });
    // The shell lists the session's clients from a short per-session cache of GET /me; drop it so the new client is
    // in the switcher on the next page.
    const cookie = (await headers()).get('cookie');
    if (cookie) forgetSession(cookie);
    revalidatePath('/portfolio');
    return { ok: true, id: data.id };
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return { ok: false, message: 'Only account admins can add a client.' };
    }
    if (isApiError(error, 'VALIDATION')) {
      return { ok: false, message: 'Type a name of up to 300 characters.' };
    }
    return { ok: false, message: 'The client wasn’t added. Try again.' };
  }
}

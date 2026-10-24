'use server';
// Server Actions behind the account page: let PlanetPulse support in, or end its access. Input is checked against the
// contracts first (root rule 7); the API checks the caller is an account admin and writes the audit trail.
import { Id, SupportGrantCreateBody } from '@canopy/contracts';
import { revalidatePath } from 'next/cache';

import { isApiError } from '../../../lib/api/client';
import { sessionApi } from '../../../lib/api/server';
import { redirectIfSignedOut } from '../c/[clientId]/overview/signed-out';

export type ActionResult = { ok: true } | { ok: false; message: string };

const INVALID = { ok: false, message: 'Choose a level and between 1 and 30 days.' } as const;

function failure(error: unknown): { ok: false; message: string } {
  if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
    return { ok: false, message: 'Only account admins can change support access.' };
  }
  if (isApiError(error, 'INVALID_TRANSITION', 'NOT_FOUND')) {
    return { ok: false, message: 'That access has already ended. The page now shows the latest.' };
  }
  if (isApiError(error, 'VALIDATION')) return INVALID;
  throw error;
}

async function run(change: () => Promise<void>): Promise<ActionResult> {
  try {
    await change();
    return { ok: true };
  } catch (error) {
    await redirectIfSignedOut(error);
    return failure(error);
  } finally {
    revalidatePath('/account');
  }
}

export async function grantSupportAction(input: {
  level: string;
  days: number;
}): Promise<ActionResult> {
  const body = SupportGrantCreateBody.safeParse(input);
  if (!body.success) return INVALID;
  return run(async () => {
    await (await sessionApi()).call('createSupportGrant', { body: body.data });
  });
}

export async function revokeSupportAction(grantId: string): Promise<ActionResult> {
  const parsed = Id.safeParse(grantId);
  if (!parsed.success) {
    return { ok: false, message: 'That access has already ended. The page now shows the latest.' };
  }
  const id = parsed.data;
  return run(async () => {
    await (await sessionApi()).call('revokeSupportGrant', { params: { id } });
  });
}

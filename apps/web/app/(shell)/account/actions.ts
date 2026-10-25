'use server';
// Server Actions behind the account page: let PlanetPulse support in, or end its access, and start a client's
// archive. Input is checked against the contracts first (root rule 7); the API checks the caller is an account admin
// and writes the audit trail.
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

export type ArchiveStart = { ok: true; id: string } | { ok: false; message: string };
export type ArchiveProgress =
  { status: 'pending' } | { status: 'failed'; message: string } | { status: 'ready'; url: string };

const NOT_STARTED = 'The download didn’t start. Try again.';

/** The archive's own wording for a refusal; anything else is `otherwise`. */
function archiveRefused(error: unknown, otherwise: string): string {
  if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
    return 'Only account admins can download a client’s data.';
  }
  if (isApiError(error, 'RATE_LIMITED')) {
    return 'Too many downloads at once. Wait a minute and try again.';
  }
  return otherwise;
}

/**
 * Starts the archive of one client: its whole register and clean evidence files as one zip (ADR M10-0002).
 * `archiveProgressAction` follows it to the download link. Works while the account is closing.
 */
export async function startArchiveAction(clientId: string): Promise<ArchiveStart> {
  const parsed = Id.safeParse(clientId);
  if (!parsed.success) return { ok: false, message: NOT_STARTED };
  try {
    const { data } = await (
      await sessionApi()
    ).call('createExport', {
      params: { clientId: parsed.data },
      body: { kind: 'CLIENT_ARCHIVE_ZIP' },
    });
    return { ok: true, id: data.id };
  } catch (error) {
    await redirectIfSignedOut(error);
    return { ok: false, message: archiveRefused(error, NOT_STARTED) };
  }
}

/**
 * Where an archive is; a finished one comes with its 5-minute download link, which is never logged (root rule 6).
 * The reports page's `exportProgressAction` does the same with the reports' wording for a refusal.
 */
export async function archiveProgressAction(exportId: string): Promise<ArchiveProgress> {
  const failed = 'The archive couldn’t be prepared. Try again.';
  const parsed = Id.safeParse(exportId);
  if (!parsed.success) return { status: 'failed', message: failed };
  try {
    const api = await sessionApi();
    const { data } = await api.call('getExport', { params: { id: parsed.data } });
    if (data.status === 'FAILED') return { status: 'failed', message: failed };
    if (data.status !== 'DONE') return { status: 'pending' };
    const { data: signed } = await api.call('exportDownloadUrl', { params: { id: parsed.data } });
    return { status: 'ready', url: signed.url };
  } catch (error) {
    await redirectIfSignedOut(error);
    return { status: 'failed', message: archiveRefused(error, failed) };
  }
}

'use server';
// Server Actions behind the reports page's downloads. Every argument comes from the browser, so each is checked
// against the contracts' schemas first (root rule 7); the API checks the person may export and audits the export.
// A download link expires in 5 minutes and is never logged (root rule 6).
import { ExportKind, FyLabel, Id } from '@canopy/contracts';

import { isApiError } from '../../../../../lib/api/client';
import { sessionApi } from '../../../../../lib/api/server';

export type ExportStart = { ok: true; id: string } | { ok: false; message: string };
export type ExportProgress =
  { status: 'pending' } | { status: 'failed'; message: string } | { status: 'ready'; url: string };

function refused(error: unknown): string {
  if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
    return 'You can’t download reports for this client.';
  }
  if (isApiError(error, 'RATE_LIMITED'))
    return 'Too many downloads at once. Wait a minute and try again.';
  return 'The download didn’t start. Try again.';
}

/** Starts an export of one report for the page's financial year. */
export async function startExportAction(
  clientId: string,
  kind: string,
  fy: string | null,
): Promise<ExportStart> {
  const id = Id.parse(clientId);
  const body = {
    kind: ExportKind.parse(kind),
    ...(fy === null ? {} : { fy: FyLabel.parse(fy) }),
  };
  try {
    const { data } = await (
      await sessionApi()
    ).call('createExport', {
      params: { clientId: id },
      body,
    });
    return { ok: true, id: data.id };
  } catch (error) {
    return { ok: false, message: refused(error) };
  }
}

/** Where an export is. A finished one comes with its download link. */
export async function exportProgressAction(exportId: string): Promise<ExportProgress> {
  const id = Id.parse(exportId);
  const api = await sessionApi();
  try {
    const { data } = await api.call('getExport', { params: { id } });
    if (data.status === 'FAILED') {
      return { status: 'failed', message: 'The download couldn’t be prepared. Try again.' };
    }
    if (data.status !== 'DONE') return { status: 'pending' };
    const { data: signed } = await api.call('exportDownloadUrl', { params: { id } });
    return { status: 'ready', url: signed.url };
  } catch (error) {
    return { status: 'failed', message: refused(error) };
  }
}

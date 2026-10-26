'use server';
// Server Actions behind the ISO downloads (the risk register now, the NC log later). Every argument comes from the
// browser, so the kind is checked as one of the add-on's export kinds and the body against the contracts' export schema,
// which checks the filters against that kind's list query (root rule 7). The API checks the person may export, honours
// their unit scope and audits the export. A download link expires in 5 minutes and is never logged (root rule 6).
import { ExportCreateBody, Id, IsoExportKind } from '@canopy/contracts';

import { isApiError } from '../../../../../../lib/api/client';
import { sessionApi } from '../../../../../../lib/api/server';
import { redirectIfSignedOut } from '../../overview/signed-out';

export type ExportStart = { ok: true; id: string } | { ok: false; message: string };
export type ExportProgress =
  { status: 'pending' } | { status: 'failed'; message: string } | { status: 'ready'; url: string };

function refused(error: unknown): string {
  if (isApiError(error, 'FEATURE_NOT_ENABLED'))
    return 'ISO management systems is not turned on for this account.';
  if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) return 'You can’t download this.';
  if (isApiError(error, 'RATE_LIMITED'))
    return 'Too many downloads at once. Wait a minute and try again.';
  return 'The download didn’t start. Try again.';
}

/** Starts an ISO export with its list's filters (a query string without paging or `ids`). */
export async function startIsoExport(
  clientId: string,
  kind: string,
  filters: string,
): Promise<ExportStart> {
  try {
    const body = ExportCreateBody.parse({ kind: IsoExportKind.parse(kind), filters });
    const { data } = await (
      await sessionApi()
    ).call('createExport', { params: { clientId: Id.parse(clientId) }, body });
    return { ok: true, id: data.id };
  } catch (error) {
    await redirectIfSignedOut(error);
    return { ok: false, message: refused(error) };
  }
}

/** Where an export is; a finished one comes with its download link. */
export async function isoExportProgress(exportId: string): Promise<ExportProgress> {
  try {
    const id = Id.parse(exportId);
    const api = await sessionApi();
    const { data } = await api.call('getExport', { params: { id } });
    if (data.status === 'FAILED') {
      return { status: 'failed', message: 'The download couldn’t be prepared. Try again.' };
    }
    if (data.status !== 'DONE') return { status: 'pending' };
    const { data: signed } = await api.call('exportDownloadUrl', { params: { id } });
    return { status: 'ready', url: signed.url };
  } catch (error) {
    await redirectIfSignedOut(error);
    return { status: 'failed', message: refused(error) };
  }
}

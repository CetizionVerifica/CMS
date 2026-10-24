// The import steps against the API (contracts M8 endpoints), for the wizard's Server Actions. Kept apart from
// actions.ts so the steps can be tested with a fake client.
import type {
  ColumnMapping,
  ImportBatch,
  ImportIssueDecisionBody,
  ImportUploaded,
} from '@canopy/contracts';

import type { ApiClient } from '../../../../../lib/api/client';

/** Where the browser sends the workbook; null when the demo API answers (it stores no file bytes). */
export type UploadTarget = { url: string; headers: Record<string, string> } | null;

export type StartedImport = { batchId: string; upload: UploadTarget };

export async function startImport(
  api: ApiClient,
  clientId: string,
  file: { fileName: string; sizeBytes: number },
  demo: boolean,
): Promise<StartedImport> {
  const { data } = await api.call('createImport', { params: { clientId }, body: file });
  return { batchId: data.batchId, upload: demo ? null : { url: data.url, headers: data.headers } };
}

/**
 * Confirms the upload, then saves the API's suggested mapping for the first sheet, so the mapping step can be resumed
 * from the batch alone (GET /imports/{id} carries the mapping, not the sheet list). Nothing is read until the person
 * confirms the mapping on the next screen.
 */
export async function confirmUpload(
  api: ApiClient,
  batchId: string,
  sha256: string,
): Promise<ImportUploaded> {
  const { data } = await api.call('importUploaded', { params: { id: batchId }, body: { sha256 } });
  const sheet = data.sheets[0]!;
  const mapping = suggestedFor(sheet.headers, data.suggestedMapping);
  await api.call('putImportMapping', {
    params: { id: batchId },
    body: { sheetName: sheet.name, mapping },
  });
  return data;
}

/** The suggestion, one entry per header in sheet order; headers it doesn't cover are ignored columns. */
export function suggestedFor(
  headers: readonly string[],
  suggested: ColumnMapping | null,
): ColumnMapping {
  const byHeader = new Map((suggested ?? []).map((m) => [m.sourceHeader, m.field]));
  return headers
    .filter((h) => h.trim() !== '')
    .map((sourceHeader) => ({ sourceHeader, field: byHeader.get(sourceHeader) ?? null }));
}

/** Saves the mapping the person confirmed and starts reading the rows (202; the batch stays MAPPED until parsed). */
export async function mapAndParse(
  api: ApiClient,
  batchId: string,
  sheetName: string,
  mapping: ColumnMapping,
  templateName: string | undefined,
): Promise<ImportBatch> {
  await api.call('putImportMapping', {
    params: { id: batchId },
    body: {
      sheetName,
      mapping,
      ...(templateName ? { saveAsTemplate: { name: templateName, scope: 'CLIENT' as const } } : {}),
    },
  });
  return (await api.call('parseImport', { params: { id: batchId } })).data;
}

export async function decide(
  api: ApiClient,
  batchId: string,
  groupKey: string,
  body: ImportIssueDecisionBody,
): Promise<void> {
  await api.call('decideImportIssue', { params: { id: batchId, groupKey }, body });
}

/** Accepts the proposal of each group, one request per group (the API decides one group at a time). */
export async function acceptAll(
  api: ApiClient,
  batchId: string,
  groupKeys: readonly string[],
): Promise<void> {
  for (const groupKey of groupKeys) await decide(api, batchId, groupKey, { decision: 'ACCEPTED' });
}

export async function dryRun(api: ApiClient, batchId: string): Promise<void> {
  await api.call('dryRunImport', { params: { id: batchId } });
}

export async function commit(api: ApiClient, batchId: string): Promise<ImportBatch> {
  return (await api.call('commitImport', { params: { id: batchId } })).data;
}

export async function cancel(api: ApiClient, batchId: string): Promise<ImportBatch> {
  return (await api.call('cancelImport', { params: { id: batchId } })).data;
}

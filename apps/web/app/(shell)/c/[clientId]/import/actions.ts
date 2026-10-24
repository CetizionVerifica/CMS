'use server';
// Server Actions behind the import wizard. Every argument comes from the browser, so each is checked against the
// contracts' schemas first (root rule 7); the API then checks the person may import for this client. Errors come
// back as words for the page, never as the API's details (import rows hold personal data, root rule 6).
import {
  ColumnMapping,
  Id,
  ImportCreateBody,
  ImportIssueDecisionBody,
  ImportIssueGroupParams,
  ImportUploadedBody,
  Name,
} from '@canopy/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '../../../../../lib/api/client';
import { sessionApi, usingMockApi } from '../../../../../lib/api/server';
import * as steps from './import-api';

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

const SheetName = z.string().min(1).max(255);
const GroupKeys = z.array(ImportIssueGroupParams.shape.groupKey).min(1).max(500);

/** The person-facing sentence for a failed step. */
function failure(error: unknown): { ok: false; message: string } {
  if (isApiError(error, 'IMPORT_STATE')) {
    return {
      ok: false,
      message: 'This import moved on in another tab. The page now shows where it is.',
    };
  }
  if (isApiError(error, 'IMPORT_BLOCKED')) {
    return { ok: false, message: 'Some issues still need a decision before the commit.' };
  }
  if (isApiError(error, 'UNSUPPORTED_FILE')) {
    return { ok: false, message: 'Only .xlsx workbooks can be imported.' };
  }
  if (isApiError(error, 'FILE_TOO_LARGE')) {
    return { ok: false, message: 'The workbook is too large to import.' };
  }
  if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
    return { ok: false, message: 'You can no longer import for this client.' };
  }
  if (isApiError(error, 'VALIDATION')) {
    return {
      ok: false,
      message: 'The import could not use these values. Check them and try again.',
    };
  }
  throw error;
}

async function run<T>(clientId: string, step: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const value = await step();
    revalidatePath(`/c/${clientId}/import`);
    return { ok: true, value };
  } catch (error) {
    return failure(error);
  }
}

export async function startImportAction(
  clientId: string,
  file: { fileName: string; sizeBytes: number },
): Promise<ActionResult<steps.StartedImport>> {
  const id = Id.parse(clientId);
  const body = ImportCreateBody.safeParse(file);
  if (!body.success) {
    return { ok: false, message: 'Choose an .xlsx workbook of 20 MB or less.' };
  }
  return run(id, async () =>
    steps.startImport(await sessionApi(), id, body.data, await usingMockApi()),
  );
}

export async function confirmUploadAction(
  clientId: string,
  batchId: string,
  sha256: string,
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const batch = Id.parse(batchId);
  const { sha256: hash } = ImportUploadedBody.parse({ sha256 });
  return run(id, async () => {
    await steps.confirmUpload(await sessionApi(), batch, hash);
    return undefined;
  });
}

export async function mapAndParseAction(
  clientId: string,
  batchId: string,
  sheetName: string,
  mapping: unknown,
  templateName: string,
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const batch = Id.parse(batchId);
  const name = templateName.trim() === '' ? undefined : Name.parse(templateName.trim());
  return run(id, async () => {
    await steps.mapAndParse(
      await sessionApi(),
      batch,
      SheetName.parse(sheetName),
      ColumnMapping.parse(mapping),
      name,
    );
    return undefined;
  });
}

export async function decideAction(
  clientId: string,
  batchId: string,
  groupKey: string,
  decision: unknown,
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const batch = Id.parse(batchId);
  const key = ImportIssueGroupParams.shape.groupKey.parse(groupKey);
  const body = ImportIssueDecisionBody.parse(decision);
  return run(id, async () => steps.decide(await sessionApi(), batch, key, body));
}

export async function acceptAllAction(
  clientId: string,
  batchId: string,
  groupKeys: string[],
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const batch = Id.parse(batchId);
  const keys = GroupKeys.parse(groupKeys);
  return run(id, async () => steps.acceptAll(await sessionApi(), batch, keys));
}

export async function dryRunAction(clientId: string, batchId: string): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const batch = Id.parse(batchId);
  return run(id, async () => steps.dryRun(await sessionApi(), batch));
}

export async function commitAction(clientId: string, batchId: string): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const batch = Id.parse(batchId);
  const result = await run(id, async () => {
    await steps.commit(await sessionApi(), batch);
    return undefined;
  });
  // The register, overview and dashboards now count the imported rows.
  if (result.ok) revalidatePath(`/c/${id}`, 'layout');
  return result;
}

export async function cancelAction(clientId: string, batchId: string): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const batch = Id.parse(batchId);
  return run(id, async () => {
    await steps.cancel(await sessionApi(), batch);
    return undefined;
  });
}

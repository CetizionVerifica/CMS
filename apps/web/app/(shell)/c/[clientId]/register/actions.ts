'use server';
// Server Actions behind the register page. Every argument comes from the browser, so each is checked against the
// contracts' schemas first (root rule 7); the API then checks the person's access to the client and to each instance.
import { Cursor, Id, RegisterFilterQuery } from '@canopy/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { sessionApi, serverApi } from '../../../../../lib/api/server';
import {
  approvableItems,
  approveItems,
  bulkMessage,
  exportState,
  loadPage,
  startExport,
  type ExportState,
  type RegisterPage,
} from './_lib/register-api';

/** A register API query string (`apiQueryFromParams`), as the export and "select all" take it. */
const QueryString = z
  .string()
  .max(4000)
  .refine(
    (q) => RegisterFilterQuery.safeParse(Object.fromEntries(new URLSearchParams(q))).success,
    {
      message: 'Not a register query',
    },
  );

/** Items the person selected, each with the version they saw. Any number: approveItems sends 200 per request. */
const Items = z
  .array(z.strictObject({ id: Id, version: z.int().min(1) }))
  .min(1)
  .max(10_000);

export async function loadMoreRows(
  clientId: string,
  query: string,
  cursor: string,
): Promise<RegisterPage> {
  return loadPage(
    await serverApi(),
    Id.parse(clientId),
    QueryString.parse(query),
    Cursor.parse(cursor),
  );
}

export type ApproveResult = { tone: 'success' | 'warn'; message: string };

/**
 * Every row in the view that is waiting for approval now, with its current version: what "Select all N" would approve.
 * The page shows the count in a confirmation and then sends exactly these items, so a row that changes before the
 * person confirms comes back STALE_VERSION instead of being approved unseen.
 */
export async function waitingRows(
  clientId: string,
  query: string,
): Promise<{ id: string; version: number }[]> {
  return approvableItems(await serverApi(), Id.parse(clientId), QueryString.parse(query));
}

/** Approves the given rows at the versions the person saw; a row changed since then is skipped, not approved. */
export async function bulkApproveRows(
  clientId: string,
  items: { id: string; version: number }[],
): Promise<ApproveResult> {
  const id = Id.parse(clientId);
  const outcome = await approveItems(await sessionApi(), id, Items.parse(items));
  if (outcome.approved > 0) revalidatePath(`/c/${id}`, 'layout');
  return bulkMessage(outcome);
}

export async function startRegisterExport(clientId: string, query: string): Promise<string> {
  return startExport(await sessionApi(), Id.parse(clientId), QueryString.parse(query));
}

export async function registerExportState(exportId: string): Promise<ExportState> {
  return exportState(await serverApi(), Id.parse(exportId));
}

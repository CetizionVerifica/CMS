import {
  ImportBatch,
  ImportIssue,
  ImportRow,
  MappingTemplate,
  type ImportBatchStatus,
  type ImportRowOutcome,
  type IssueDecision,
} from '@canopy/contracts';
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { TenantTx } from '../database.js';
import { DbError, rethrow } from '../errors.js';
import * as s from '../schema/index.js';
import { isUuidV7 } from '../uuid.js';
import { instantsToDates } from './convert.js';
import { entity, pageLimit, type Page, type PageRequest } from './crud.js';

/**
 * Import batches, rows, issues and mapping templates (domain-model.md §6). Rows and issues hold personal
 * data from the sheet: never log what these functions return.
 */

export type NewImportBatch = Omit<
  ImportBatch,
  'id' | 'firmId' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'version' | 'status'
> & {
  id?: string;
  status?: ImportBatch['status'];
};

const batchEntity = entity<ImportBatch, NewImportBatch>({
  table: s.importBatch,
  schema: ImportBatch,
  toRow: instantsToDates('committedAt'),
});

export const importBatches = {
  get: batchEntity.get,
  require: batchEntity.require,
  /** A client's batches, newest first unless `page.order` says otherwise (endpoints.md: history). */
  list: (tx: TenantTx, clientId: string, page: PageRequest = {}) =>
    batchEntity.list(tx, eq(s.importBatch.clientId, clientId), { order: 'desc', ...page }),
  /** Earlier non-archived batches of the same file for a client (re-import detection). */
  findByFile: (tx: TenantTx, clientId: string, fileSha256: string): Promise<ImportBatch[]> =>
    batchEntity.all(
      tx,
      and(
        eq(s.importBatch.clientId, clientId),
        eq(s.importBatch.fileSha256, fileSha256),
        isNull(s.importBatch.archivedAt),
      ),
    ),
  /**
   * Creates a batch. `id` lets the upload ticket hand out the batch id before the batch exists; it must be
   * a UUIDv7 (`uuidv7()`), so id order stays creation order. DUPLICATE when the id is taken.
   */
  create: (tx: TenantTx, input: NewImportBatch): Promise<ImportBatch> => {
    if (input.id !== undefined && !isUuidV7(input.id)) {
      throw new DbError('VALIDATION', 'A batch id must be a UUIDv7');
    }
    return batchEntity.create(tx, input);
  },
  /** Optimistic update of status, mapping, counts, dry run report and commit fields. */
  update: batchEntity.update,
  archive: batchEntity.archive,
};

/** Batch states in which analysis may still change the issue set. */
const ANALYSING: readonly ImportBatchStatus[] = [
  'UPLOADED',
  'MAPPED',
  'PARSED',
  'REVIEWED',
  'DRY_RUN_READY',
];

/** Columns on import_row and import_issue that the contract shapes leave out (README decision 15). */
const ROW_OMIT = ['firmId', 'clientId', 'createdAt', 'updatedAt'] as const;

const rowEntity = entity<ImportRow>({ table: s.importRow, schema: ImportRow, omit: ROW_OMIT });
export type NewImportRow = Omit<ImportRow, 'id' | 'issueIds' | 'outcome' | 'targetInstanceId'> &
  Partial<Pick<ImportRow, 'issueIds' | 'outcome' | 'targetInstanceId'>>;

/** The batch's client, so row and issue inserts carry the right client_id. */
async function batchClientId(tx: TenantTx, batchId: string): Promise<string> {
  const [row] = await tx
    .select({ clientId: s.importBatch.clientId })
    .from(s.importBatch)
    .where(eq(s.importBatch.id, batchId))
    .catch(rethrow);
  if (!row) throw new DbError('NOT_FOUND', 'Import batch not found');
  return row.clientId;
}

export const importRows = {
  get: rowEntity.get,
  /** Inserts a batch's rows; every row must belong to `batchId`. */
  async createMany(
    tx: TenantTx,
    batchId: string,
    rows: readonly NewImportRow[],
  ): Promise<ImportRow[]> {
    if (rows.length === 0) return [];
    if (rows.some((r) => r.batchId !== batchId)) {
      throw new DbError('VALIDATION', 'Every row must belong to the batch');
    }
    const clientId = await batchClientId(tx, batchId);
    const inserted = await tx
      .insert(s.importRow)
      .values(rows.map((r) => ({ ...r, clientId })))
      .returning()
      .catch(rethrow);
    return inserted.map((r) => rowEntity.parseWritten(r));
  },
  /** A batch's rows in row-number order, paged by row number. */
  async forBatch(
    tx: TenantTx,
    batchId: string,
    page: { limit?: number; afterRowNumber?: number } = {},
  ): Promise<Page<ImportRow>> {
    const limit = pageLimit(page.limit);
    const rows = await tx
      .select()
      .from(s.importRow)
      .where(
        and(
          eq(s.importRow.batchId, batchId),
          page.afterRowNumber === undefined
            ? undefined
            : gt(s.importRow.rowNumber, page.afterRowNumber),
        ),
      )
      .orderBy(asc(s.importRow.rowNumber))
      .limit(limit + 1)
      .catch(rethrow);
    const items = rows.slice(0, limit).map((r) => rowEntity.parse(r));
    return {
      items,
      nextCursor: rows.length > limit ? String(items[items.length - 1]!.rowNumber) : null,
    };
  },
  /** Records the dry-run or commit result for one row. */
  setOutcome: (
    tx: TenantTx,
    id: string,
    patch: { outcome: ImportRowOutcome; targetInstanceId?: string | null; issueIds?: string[] },
  ): Promise<ImportRow> => rowEntity.set(tx, id, patch),
};

const issueEntity = entity<ImportIssue>({
  table: s.importIssue,
  schema: ImportIssue,
  omit: ROW_OMIT,
});
export type NewImportIssue = Omit<ImportIssue, 'id' | 'decision' | 'editedValue'> &
  Partial<Pick<ImportIssue, 'decision' | 'editedValue'>>;

export const importIssues = {
  get: issueEntity.get,
  async createMany(
    tx: TenantTx,
    batchId: string,
    issues: readonly NewImportIssue[],
  ): Promise<ImportIssue[]> {
    if (issues.length === 0) return [];
    if (issues.some((i) => i.batchId !== batchId)) {
      throw new DbError('VALIDATION', 'Every issue must belong to the batch');
    }
    const clientId = await batchClientId(tx, batchId);
    const inserted = await tx
      .insert(s.importIssue)
      .values(issues.map((i) => ({ ...i, clientId })))
      .returning()
      .catch(rethrow);
    return inserted.map((r) => issueEntity.parseWritten(r));
  },
  /** A batch's issues, grouped by group key then id. */
  async forBatch(tx: TenantTx, batchId: string): Promise<ImportIssue[]> {
    const rows = await tx
      .select()
      .from(s.importIssue)
      .where(eq(s.importIssue.batchId, batchId))
      .orderBy(asc(s.importIssue.groupKey), asc(s.importIssue.id))
      .catch(rethrow);
    return rows.map((r) => issueEntity.parse(r));
  },
  /** Decides every issue in a group at once (issues with one group key are decided once). */
  async decideGroup(
    tx: TenantTx,
    batchId: string,
    groupKey: string,
    decision: IssueDecision,
    editedValue: string | null = null,
  ): Promise<ImportIssue[]> {
    const rows = await tx
      .update(s.importIssue)
      .set({ decision, editedValue })
      .where(and(eq(s.importIssue.batchId, batchId), eq(s.importIssue.groupKey, groupKey)))
      .returning()
      .catch(rethrow);
    if (rows.length === 0) throw new DbError('NOT_FOUND', 'No issues in that group');
    return rows.map((r) => issueEntity.parseWritten(r));
  },
  /**
   * Deletes a batch's issues in these groups and returns how many went (endpoints.md §5: re-analysis drops
   * stale issues). Issues are working data regenerated by each analysis, so this is the one hard delete the
   * app role has, and only before commit: FORBIDDEN from COMMITTING on (the `delete_before_commit` policy also
   * refuses it), NOT_FOUND for a batch not visible here. Update `import_row.issue_ids` first
   * (`importRows.setOutcome`).
   */
  async removeGroups(tx: TenantTx, batchId: string, groupKeys: readonly string[]): Promise<number> {
    const [batch] = await tx
      .select({ status: s.importBatch.status })
      .from(s.importBatch)
      .where(eq(s.importBatch.id, batchId))
      .catch(rethrow);
    if (!batch) throw new DbError('NOT_FOUND', 'Not found');
    if (!ANALYSING.includes(batch.status)) {
      throw new DbError('FORBIDDEN', 'Issues are kept once a batch is committing or done');
    }
    if (groupKeys.length === 0) return 0;
    const removed = await tx
      .delete(s.importIssue)
      .where(
        and(eq(s.importIssue.batchId, batchId), inArray(s.importIssue.groupKey, [...groupKeys])),
      )
      .returning({ id: s.importIssue.id })
      .catch(rethrow);
    return removed.length;
  },
};

const templateEntity = entity<MappingTemplate>({
  table: s.mappingTemplate,
  schema: MappingTemplate,
});
export const mappingTemplates = {
  get: templateEntity.get,
  require: templateEntity.require,
  /** Templates usable for a client: its own and the firm-wide ones (firm-wide visible to firm contexts). */
  forClient: (tx: TenantTx, clientId: string): Promise<MappingTemplate[]> =>
    templateEntity.all(
      tx,
      and(
        isNull(s.mappingTemplate.archivedAt),
        or(eq(s.mappingTemplate.clientId, clientId), isNull(s.mappingTemplate.clientId)),
      ),
    ),
  create: templateEntity.create,
  update: templateEntity.update,
  archive: templateEntity.archive,
};

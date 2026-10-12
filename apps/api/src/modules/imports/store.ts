import type {
  EngineCalendar,
  ImportBatch,
  ImportIssue,
  ImportRow,
  ImportRowOutcome,
  IssueDecision,
  MappingTemplate,
} from '@canopy/contracts';
import type { TenantContext } from '@canopy/db';
import type { ExistingState, ImportPlan, InstanceChange } from '@canopy/importer';

/**
 * What the import service needs from the database, as one interface. `repositoryStore` implements it on the
 * M3 repositories; the service tests use an in-memory one. Rows and issues hold personal data: never log them.
 */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type NewBatch = Omit<
  ImportBatch,
  'firmId' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'version'
>;
export type BatchPatch = Partial<
  Pick<
    ImportBatch,
    | 'status'
    | 'sheetName'
    | 'mapping'
    | 'mappingTemplateId'
    | 'counts'
    | 'dryRun'
    | 'committedAt'
    | 'failureCode'
  >
>;
export type NewRow = Omit<ImportRow, 'id' | 'targetInstanceId'>;
export type NewIssue = Omit<ImportIssue, 'id'>;
export type NewTemplate = Pick<MappingTemplate, 'clientId' | 'name' | 'mapping'>;
export type TemplatePatch = Partial<Pick<MappingTemplate, 'name' | 'mapping'>>;

/** What a commit writes: the reviewed plan and the changes the dry run found on existing instances. */
export interface CommitRequest {
  batchId: string;
  clientId: string;
  plan: ImportPlan;
  /** Planned instance key → change, for the instances that exist and change. */
  instanceChanges: ReadonlyMap<string, InstanceChange>;
  /** The person committing; every audit event names them. */
  actorId: string;
  requestId: string;
}

export interface CommitResult {
  /** Planned instance key → the stored instance id (created, updated or unchanged). */
  instanceIds: Map<string, string>;
}

export interface ImportTx {
  getBatch(id: string): Promise<ImportBatch | null>;
  createBatch(input: NewBatch): Promise<ImportBatch>;
  /** Optimistic on `version`: throws DbError STALE_VERSION when someone else wrote first. */
  updateBatch(id: string, version: number, patch: BatchPatch): Promise<ImportBatch>;
  /** Newest first. */
  listBatches(
    clientId: string,
    page: { limit?: number; cursor?: string },
  ): Promise<Page<ImportBatch>>;

  addRows(batchId: string, rows: readonly NewRow[]): Promise<ImportRow[]>;
  /** In row-number order; `afterRowNumber` continues a page. */
  rows(batchId: string, page: { limit: number; afterRowNumber?: number }): Promise<Page<ImportRow>>;
  setRow(
    id: string,
    patch: { outcome: ImportRowOutcome; issueIds?: string[]; targetInstanceId?: string | null },
  ): Promise<void>;

  addIssues(batchId: string, issues: readonly NewIssue[]): Promise<ImportIssue[]>;
  issues(batchId: string): Promise<ImportIssue[]>;
  decideGroup(
    batchId: string,
    groupKey: string,
    decision: IssueDecision,
    editedValue: string | null,
  ): Promise<void>;
  removeGroups(batchId: string, groupKeys: readonly string[]): Promise<void>;

  /** The client's own templates and the firm-wide ones. */
  templatesFor(clientId: string): Promise<MappingTemplate[]>;
  getTemplate(id: string): Promise<MappingTemplate | null>;
  createTemplate(input: NewTemplate): Promise<MappingTemplate>;
  updateTemplate(id: string, version: number, patch: TemplatePatch): Promise<MappingTemplate>;

  /** The client's FY and holiday settings, for the engine. DbError NOT_FOUND when the client is not visible. */
  calendar(clientId: string): Promise<EngineCalendar>;
  /** What the firm and client already hold, by the importer's natural keys. */
  existingState(clientId: string): Promise<ExistingState>;
  /**
   * Writes the plan through the repositories with an IMPORT audit event per change, in this transaction.
   * Re-running it with the same plan writes nothing new.
   */
  commit(request: CommitRequest): Promise<CommitResult>;
}

export interface ImportStore {
  /** Runs `fn` in one transaction as `ctx`, under the tenant's RLS policies. */
  transaction<T>(ctx: TenantContext, fn: (tx: ImportTx) => Promise<T>): Promise<T>;
}

import {
  IMPORT_ISSUE_SEVERITY,
  type CanopyField,
  type ColumnMapping,
  type DryRunReport,
} from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  clientPolicy,
  firmIdColumn,
  idColumn,
  instant,
  optionalClientPolicy,
  versionColumn,
} from './columns.js';
import {
  canopyFieldEnum,
  importBatchStatusEnum,
  importIssueTypeEnum,
  importRowOutcomeEnum,
  issueDecisionEnum,
  issueSeverityEnum,
} from './enums.js';
import { client, person } from './tenancy.js';
import { complianceInstance } from './work.js';

/**
 * Excel import (docs/contracts/domain-model.md §6). Rows and issues hold personal data from the source sheet:
 * never log them. Both carry `firm_id` and `client_id` with RLS like every client-data table (README decision 15).
 */

/** Saved column mappings; a null client means firm-wide. */
export const mappingTemplate = pgTable(
  'mapping_template',
  {
    ...baseColumns(),
    version: versionColumn(),
    clientId: uuid('client_id'),
    name: text('name').notNull(),
    mapping: jsonb('mapping').$type<ColumnMapping>().notNull(),
  },
  (t) => [
    unique('mapping_template_firm_key').on(t.firmId, t.id),
    foreignKey({
      name: 'mapping_template_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    index('mapping_template_client_idx').on(t.firmId, t.clientId),
    check('mapping_template_mapping_check', sql`jsonb_typeof(mapping) = 'array'`),
    check('mapping_template_version_check', sql`version >= 1`),
    optionalClientPolicy({ nullClientWrites: false }),
  ],
);

export const importBatch = pgTable(
  'import_batch',
  {
    ...baseColumns(),
    version: versionColumn(),
    clientId: uuid('client_id').notNull(),
    createdById: uuid('created_by_id').notNull(),
    status: importBatchStatusEnum('status').notNull().default('UPLOADED'),
    fileName: text('file_name').notNull(),
    fileSha256: text('file_sha256').notNull(),
    sheetName: text('sheet_name'),
    mapping: jsonb('mapping').$type<ColumnMapping>(),
    mappingTemplateId: uuid('mapping_template_id'),
    counts: jsonb('counts').$type<{
      rows: number;
      errors: number;
      warnings: number;
      infos: number;
    }>(),
    dryRun: jsonb('dry_run').$type<DryRunReport>(),
    committedAt: instant('committed_at'),
    failureCode: text('failure_code'),
  },
  (t) => [
    unique('import_batch_scope_key').on(t.firmId, t.clientId, t.id),
    foreignKey({
      name: 'import_batch_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    foreignKey({
      name: 'import_batch_created_by_fk',
      columns: [t.firmId, t.createdById],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'import_batch_mapping_template_fk',
      columns: [t.firmId, t.mappingTemplateId],
      foreignColumns: [mappingTemplate.firmId, mappingTemplate.id],
    }),
    index('import_batch_client_idx').on(t.firmId, t.clientId, t.createdAt),
    index('import_batch_file_idx').on(t.clientId, t.fileSha256),
    check('import_batch_sha256_check', sql`file_sha256 ~ '^[0-9a-f]{64}$'`),
    check('import_batch_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** One per source row; `raw` keeps the cells exactly as read, beside the cleaned `mapped` values. */
export const importRow = pgTable(
  'import_row',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    clientId: uuid('client_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    raw: jsonb('raw').$type<Record<string, string | number | null>>().notNull(),
    mapped: jsonb('mapped').$type<Partial<Record<CanopyField, string | null>>>(),
    issueIds: uuid('issue_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    outcome: importRowOutcomeEnum('outcome').notNull().default('PENDING'),
    targetInstanceId: uuid('target_instance_id'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'import_row_batch_fk',
      columns: [t.firmId, t.clientId, t.batchId],
      foreignColumns: [importBatch.firmId, importBatch.clientId, importBatch.id],
    }),
    foreignKey({
      name: 'import_row_target_instance_fk',
      columns: [t.firmId, t.clientId, t.targetInstanceId],
      foreignColumns: [
        complianceInstance.firmId,
        complianceInstance.clientId,
        complianceInstance.id,
      ],
    }),
    unique('import_row_batch_row_key').on(t.batchId, t.rowNumber),
    index('import_row_target_instance_idx').on(t.targetInstanceId),
    check('import_row_row_number_check', sql`row_number >= 2`),
    check('import_row_raw_check', sql`jsonb_typeof(raw) = 'object'`),
    clientPolicy(),
  ],
);

/** Severity is fixed by issue type (domain-model.md §6, README decision 14). */
const severityByType = sql.raw(
  `severity = case type ${Object.entries(IMPORT_ISSUE_SEVERITY)
    .map(([type, severity]) => `when '${type}' then '${severity}'`)
    .join(' ')} end::issue_severity`,
);

/** Issues with the same type and proposal share a group key and are decided once. */
export const importIssue = pgTable(
  'import_issue',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    clientId: uuid('client_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    groupKey: text('group_key').notNull(),
    type: importIssueTypeEnum('type').notNull(),
    severity: issueSeverityEnum('severity').notNull(),
    rowNumbers: integer('row_numbers').array().notNull(),
    field: canopyFieldEnum('field'),
    rawValues: text('raw_values')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    proposal: text('proposal'),
    decision: issueDecisionEnum('decision').notNull().default('PENDING'),
    editedValue: text('edited_value'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'import_issue_batch_fk',
      columns: [t.firmId, t.clientId, t.batchId],
      foreignColumns: [importBatch.firmId, importBatch.clientId, importBatch.id],
    }),
    index('import_issue_batch_idx').on(t.batchId, t.groupKey),
    check('import_issue_severity_check', severityByType),
    check(
      'import_issue_row_numbers_check',
      sql`cardinality(row_numbers) >= 1 and 2 <= all(row_numbers)`,
    ),
    check(
      'import_issue_edited_value_check',
      sql`(decision = 'EDITED') = (edited_value is not null)`,
    ),
    clientPolicy(),
    // Issues are deleted only while their batch is still being analysed (migration 0009); from COMMITTING on
    // they are the record of the cleaning that was proposed and decided (non-negotiable 5).
    pgPolicy('delete_before_commit', {
      as: 'restrictive',
      for: 'delete',
      to: 'public',
      using: sql`firm_id = app_firm_id() and exists (select 1 from import_batch b where b.id = batch_id and b.status in ('UPLOADED', 'MAPPED', 'PARSED', 'REVIEWED', 'DRY_RUN_READY'))`,
    }),
  ],
);

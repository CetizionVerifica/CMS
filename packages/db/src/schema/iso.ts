import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { MAX_EVIDENCE_BYTES } from '@canopy/contracts';
import {
  baseColumns,
  cataloguePolicies,
  clientPolicy,
  firmIdColumn,
  idColumn,
  instant,
  versionColumn,
} from './columns.js';
import {
  auditRecommendationEnum,
  clauseNaStateEnum,
  clauseStatusEnum,
  contextItemKindEnum,
  documentStatusEnum,
  documentTypeEnum,
  externalAuditStateEnum,
  externalAuditTypeEnum,
  isoStandardCodeEnum,
  managementSystemStatusEnum,
  reviewInputKeyEnum,
  reviewInputSourceEnum,
  reviewOutputKeyEnum,
  revisionStateEnum,
  scanStatusEnum,
} from './enums.js';
import { client, person, unit } from './tenancy.js';

/**
 * The ISO add-on, part 1 (docs/iso/model.md §1-3.4, §3.8, §6; ISO-2d). Catalogue tables are the account's own copy,
 * firm-wide, written only by a system job. Every other table holds client data: `firm_id`, `client_id`, the client
 * policy, a `(firm_id, client_id, id)` key for composite foreign keys, so a client-A row never points at a client-B
 * row. No deletes: rows and join rows are archived. No standard's text is stored, only numbers and our own words.
 */

/** `ClauseNumber` from the contracts, e.g. "6.1.2". */
const CLAUSE_NUMBER = `'^[1-9][0-9]?([.](0|[1-9][0-9]?)){0,3}$'`;

/** A list of 1-3 distinct standard ids (`standardIds`, model §1.4: M16 checks each exists in the account's copy). */
const standardList = (column: string) =>
  sql.raw(`cardinality(${column}) between 1 and 3 and canopy_ids_distinct(${column})`);

/** Base, version and client columns of an ISO client record (model §3). */
function recordColumns() {
  return { ...baseColumns(), version: versionColumn(), clientId: uuid('client_id').notNull() };
}

// ---------- catalogue (the account's copy, firm-wide) ----------

/** One edition of a standard. */
export const isoStandard = pgTable(
  'iso_standard',
  {
    ...baseColumns(),
    code: isoStandardCodeEnum('code').notNull(),
    edition: text('edition').notNull(),
    title: text('title').notNull(),
    topic: text('topic').notNull(),
  },
  (t) => [
    unique('iso_standard_firm_key').on(t.firmId, t.id),
    unique('iso_standard_edition_key').on(t.firmId, t.code, t.edition),
    check('iso_standard_edition_check', sql`edition ~ '^[0-9]{4}(\\+A[0-9]+:[0-9]{4})*$'`),
    ...cataloguePolicies(),
  ],
);

/** A clause of one edition: number, title and our own summary. */
export const isoClause = pgTable(
  'iso_clause',
  {
    ...baseColumns(),
    standardId: uuid('standard_id').notNull(),
    number: text('number').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    parentId: uuid('parent_id'),
    hlsKey: text('hls_key'),
    assessable: boolean('assessable').notNull(),
    exclusionAllowed: boolean('exclusion_allowed').notNull(),
  },
  (t) => [
    unique('iso_clause_firm_key').on(t.firmId, t.id),
    unique('iso_clause_number_key').on(t.firmId, t.standardId, t.number),
    foreignKey({
      name: 'iso_clause_standard_fk',
      columns: [t.firmId, t.standardId],
      foreignColumns: [isoStandard.firmId, isoStandard.id],
    }),
    foreignKey({
      name: 'iso_clause_parent_fk',
      columns: [t.firmId, t.parentId],
      foreignColumns: [t.firmId, t.id],
    }),
    index('iso_clause_parent_idx').on(t.parentId),
    check('iso_clause_number_check', sql.raw(`number ~ ${CLAUSE_NUMBER}`)),
    check('iso_clause_hls_key_check', sql.raw(`hls_key is null or hls_key ~ ${CLAUSE_NUMBER}`)),
    check('iso_clause_exclusion_check', sql`assessable or not exclusion_allowed`),
    ...cataloguePolicies(),
  ],
);

const clauseItemCheck = sql`item is null or item ~ '^[a-z][0-9]?$'`;

/** One standard's management review input (9.3), under our own key and title. */
export const isoReviewInputDef = pgTable(
  'iso_review_input_def',
  {
    ...baseColumns(),
    standardId: uuid('standard_id').notNull(),
    key: reviewInputKeyEnum('key').notNull(),
    clauseNumber: text('clause_number').notNull(),
    item: text('item'),
    title: text('title').notNull(),
    source: reviewInputSourceEnum('source').notNull(),
  },
  (t) => [
    unique('iso_review_input_def_firm_key').on(t.firmId, t.id),
    unique('iso_review_input_def_key_key').on(t.firmId, t.standardId, t.key),
    foreignKey({
      name: 'iso_review_input_def_standard_fk',
      columns: [t.firmId, t.standardId],
      foreignColumns: [isoStandard.firmId, isoStandard.id],
    }),
    check('iso_review_input_def_clause_check', sql.raw(`clause_number ~ ${CLAUSE_NUMBER}`)),
    check('iso_review_input_def_item_check', clauseItemCheck),
    ...cataloguePolicies(),
  ],
);

/** One standard's management review output (9.3), under our own key and title. */
export const isoReviewOutputDef = pgTable(
  'iso_review_output_def',
  {
    ...baseColumns(),
    standardId: uuid('standard_id').notNull(),
    key: reviewOutputKeyEnum('key').notNull(),
    clauseNumber: text('clause_number').notNull(),
    item: text('item'),
    title: text('title').notNull(),
  },
  (t) => [
    unique('iso_review_output_def_firm_key').on(t.firmId, t.id),
    unique('iso_review_output_def_key_key').on(t.firmId, t.standardId, t.key),
    foreignKey({
      name: 'iso_review_output_def_standard_fk',
      columns: [t.firmId, t.standardId],
      foreignColumns: [isoStandard.firmId, isoStandard.id],
    }),
    check('iso_review_output_def_clause_check', sql.raw(`clause_number ~ ${CLAUSE_NUMBER}`)),
    check('iso_review_output_def_item_check', clauseItemCheck),
    ...cataloguePolicies(),
  ],
);

// ---------- management system and context ----------

/** One client's management system, covering one or more standards. Its units are `management_system_unit` rows. */
export const managementSystem = pgTable(
  'management_system',
  {
    ...recordColumns(),
    name: text('name').notNull(),
    standardIds: uuid('standard_ids').array().notNull(),
    scopeStatement: text('scope_statement'),
    status: managementSystemStatusEnum('status').notNull().default('PLANNING'),
    reviewIntervalMonths: integer('review_interval_months').notNull().default(12),
    climateChangeRelevant: boolean('climate_change_relevant'),
    climateChangeRationale: text('climate_change_rationale'),
    climateDecidedOn: date('climate_decided_on', { mode: 'string' }),
  },
  (t) => [
    unique('management_system_scope_key').on(t.firmId, t.clientId, t.id),
    foreignKey({
      name: 'management_system_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    index('management_system_client_idx').on(t.firmId, t.clientId),
    check('management_system_standards_check', standardList('standard_ids')),
    check('management_system_review_interval_check', sql`review_interval_months between 1 and 36`),
    check(
      'management_system_climate_check',
      sql`(climate_change_relevant is null) = (climate_change_rationale is null) and (climate_change_relevant is null) = (climate_decided_on is null)`,
    ),
    check('management_system_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** A record of a management system: the composite key to its system, in the same client. */
function systemFk(
  name: string,
  t: { firmId: AnyPgColumn; clientId: AnyPgColumn; managementSystemId: AnyPgColumn },
) {
  return foreignKey({
    name,
    columns: [t.firmId, t.clientId, t.managementSystemId],
    foreignColumns: [managementSystem.firmId, managementSystem.clientId, managementSystem.id],
  });
}

/** A system's units. Removing a unit archives its row; the partial key covers live rows only. */
export const managementSystemUnit = pgTable(
  'management_system_unit',
  {
    ...baseColumns(),
    clientId: uuid('client_id').notNull(),
    managementSystemId: uuid('management_system_id').notNull(),
    unitId: uuid('unit_id').notNull(),
  },
  (t) => [
    systemFk('management_system_unit_system_fk', t),
    foreignKey({
      name: 'management_system_unit_unit_fk',
      columns: [t.firmId, t.clientId, t.unitId],
      foreignColumns: [unit.firmId, unit.clientId, unit.id],
    }),
    uniqueIndex('management_system_unit_live_key')
      .on(t.managementSystemId, t.unitId)
      .where(sql`archived_at is null`),
    index('management_system_unit_unit_idx').on(t.unitId),
    clientPolicy(),
  ],
);

/** 4.1 issues and 4.2 interested parties. */
export const contextItem = pgTable(
  'context_item',
  {
    ...recordColumns(),
    managementSystemId: uuid('management_system_id').notNull(),
    kind: contextItemKindEnum('kind').notNull(),
    text: text('text').notNull(),
    needs: text('needs'),
    climateRelated: boolean('climate_related').notNull().default(false),
    reviewedOn: date('reviewed_on', { mode: 'string' }),
  },
  (t) => [
    unique('context_item_scope_key').on(t.firmId, t.clientId, t.id),
    systemFk('context_item_system_fk', t),
    index('context_item_system_idx').on(t.managementSystemId),
    check('context_item_needs_check', sql`kind = 'INTERESTED_PARTY' or needs is null`),
    check('context_item_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** One checklist row: an assessable clause of a standard of the system (model §3.3, §4.6). */
export const clauseAssessment = pgTable(
  'clause_assessment',
  {
    ...recordColumns(),
    managementSystemId: uuid('management_system_id').notNull(),
    clauseId: uuid('clause_id').notNull(),
    status: clauseStatusEnum('status').notNull().default('NOT_STARTED'),
    justification: text('justification'),
    naState: clauseNaStateEnum('na_state').notNull().default('NONE'),
    statusBeforeNa: clauseStatusEnum('status_before_na'),
    naRequestedById: uuid('na_requested_by_id'),
    naDecidedById: uuid('na_decided_by_id'),
    naDecidedAt: instant('na_decided_at'),
    ownerId: uuid('owner_id'),
    notes: text('notes'),
    lastReviewedOn: date('last_reviewed_on', { mode: 'string' }),
  },
  (t) => [
    unique('clause_assessment_scope_key').on(t.firmId, t.clientId, t.id),
    unique('clause_assessment_clause_key').on(t.managementSystemId, t.clauseId),
    systemFk('clause_assessment_system_fk', t),
    foreignKey({
      name: 'clause_assessment_clause_fk',
      columns: [t.firmId, t.clauseId],
      foreignColumns: [isoClause.firmId, isoClause.id],
    }),
    foreignKey({
      name: 'clause_assessment_owner_fk',
      columns: [t.firmId, t.ownerId],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'clause_assessment_na_requested_by_fk',
      columns: [t.firmId, t.naRequestedById],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'clause_assessment_na_decided_by_fk',
      columns: [t.firmId, t.naDecidedById],
      foreignColumns: [person.firmId, person.id],
    }),
    index('clause_assessment_clause_idx').on(t.clauseId),
    index('clause_assessment_owner_idx').on(t.ownerId),
    // The contracts' ClauseAssessment refinements, kept by the database too.
    check(
      'clause_assessment_na_status_check',
      sql`(status = 'NOT_APPLICABLE') = (na_state in ('REQUESTED', 'APPROVED'))`,
    ),
    check(
      'clause_assessment_na_open_check',
      sql`na_state not in ('REQUESTED', 'APPROVED') or (justification is not null and status_before_na is not null and na_requested_by_id is not null)`,
    ),
    check(
      'clause_assessment_status_before_na_check',
      sql`status_before_na is null or status_before_na <> 'NOT_APPLICABLE'`,
    ),
    check(
      'clause_assessment_na_decided_check',
      sql`(na_decided_by_id is null) = (na_decided_at is null) and (na_state not in ('APPROVED', 'REJECTED') or (na_decided_by_id is not null and na_decided_by_id is distinct from na_requested_by_id))`,
    ),
    check('clause_assessment_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

// ---------- documents ----------

/**
 * A controlled document (5.2, 7.5). `current_revision_id` is its latest APPROVED revision: a trigger (migration 0040)
 * checks it names an APPROVED revision of this document, rather than a foreign key, which would make the two tables
 * reference each other and leave the account purge no order to delete them in.
 */
export const controlledDocument = pgTable(
  'controlled_document',
  {
    ...recordColumns(),
    managementSystemId: uuid('management_system_id').notNull(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    type: documentTypeEnum('type').notNull(),
    clauseIds: uuid('clause_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: documentStatusEnum('status').notNull().default('ACTIVE'),
    currentRevisionId: uuid('current_revision_id'),
    ownerId: uuid('owner_id').notNull(),
    approverId: uuid('approver_id').notNull(),
    reviewDueOn: date('review_due_on', { mode: 'string' }),
    lastReviewedOn: date('last_reviewed_on', { mode: 'string' }),
    retention: text('retention'),
    issuer: text('issuer'),
    externalRef: text('external_ref'),
  },
  (t) => [
    unique('controlled_document_scope_key').on(t.firmId, t.clientId, t.id),
    systemFk('controlled_document_system_fk', t),
    foreignKey({
      name: 'controlled_document_owner_fk',
      columns: [t.firmId, t.ownerId],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'controlled_document_approver_fk',
      columns: [t.firmId, t.approverId],
      foreignColumns: [person.firmId, person.id],
    }),
    // Codes are unique per client (model §3.4), an obsolete document's included.
    uniqueIndex('controlled_document_code_key')
      .on(t.firmId, t.clientId, t.code)
      .where(sql`archived_at is null`),
    index('controlled_document_system_idx').on(t.managementSystemId),
    index('controlled_document_owner_idx').on(t.ownerId),
    index('controlled_document_approver_idx').on(t.approverId),
    check(
      'controlled_document_clauses_check',
      sql`cardinality(clause_ids) <= 50 and canopy_ids_distinct(clause_ids)`,
    ),
    check('controlled_document_retention_check', sql`type = 'FORM' or retention is null`),
    check(
      'controlled_document_external_check',
      sql`type = 'EXTERNAL' or (issuer is null and external_ref is null)`,
    ),
    check('controlled_document_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** One revision of a document. Its file is its `iso_file`. */
export const documentRevision = pgTable(
  'document_revision',
  {
    ...recordColumns(),
    documentId: uuid('document_id').notNull(),
    revision: text('revision').notNull(),
    changeNote: text('change_note'),
    state: revisionStateEnum('state').notNull().default('DRAFT'),
    preparedById: uuid('prepared_by_id').notNull(),
    approvedById: uuid('approved_by_id'),
    approvedAt: instant('approved_at'),
    sendBackReason: text('send_back_reason'),
  },
  (t) => [
    unique('document_revision_scope_key').on(t.firmId, t.clientId, t.id),
    foreignKey({
      name: 'document_revision_document_fk',
      columns: [t.firmId, t.clientId, t.documentId],
      foreignColumns: [
        controlledDocument.firmId,
        controlledDocument.clientId,
        controlledDocument.id,
      ],
    }),
    foreignKey({
      name: 'document_revision_prepared_by_fk',
      columns: [t.firmId, t.preparedById],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'document_revision_approved_by_fk',
      columns: [t.firmId, t.approvedById],
      foreignColumns: [person.firmId, person.id],
    }),
    index('document_revision_document_idx').on(t.documentId),
    // DRAFT_REVISION's guard (model §4.2): at most one revision in DRAFT or IN_REVIEW, and one APPROVED, per document.
    uniqueIndex('document_revision_open_key')
      .on(t.documentId)
      .where(sql`state in ('DRAFT', 'IN_REVIEW') and archived_at is null`),
    uniqueIndex('document_revision_approved_key')
      .on(t.documentId)
      .where(sql`state = 'APPROVED'`),
    check(
      'document_revision_approved_check',
      sql`(state in ('APPROVED', 'SUPERSEDED')) = (approved_at is not null) and (state in ('APPROVED', 'SUPERSEDED') or approved_by_id is null)`,
    ),
    check(
      'document_revision_approver_check',
      sql`approved_by_id is null or approved_by_id <> prepared_by_id`,
    ),
    check('document_revision_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

// ---------- certification and external audits ----------

/** A certificate for one standard of a system. Its units are `certification_unit` rows (none: the system's). */
export const certification = pgTable(
  'certification',
  {
    ...recordColumns(),
    managementSystemId: uuid('management_system_id').notNull(),
    standardId: uuid('standard_id').notNull(),
    body: text('body').notNull(),
    certificateNumber: text('certificate_number'),
    issuedOn: date('issued_on', { mode: 'string' }),
    expiresOn: date('expires_on', { mode: 'string' }),
    scopeText: text('scope_text'),
  },
  (t) => [
    unique('certification_scope_key').on(t.firmId, t.clientId, t.id),
    systemFk('certification_system_fk', t),
    foreignKey({
      name: 'certification_standard_fk',
      columns: [t.firmId, t.standardId],
      foreignColumns: [isoStandard.firmId, isoStandard.id],
    }),
    index('certification_system_idx').on(t.managementSystemId),
    index('certification_expires_idx').on(t.firmId, t.expiresOn),
    // Number, issue and expiry are set together or not at all (contracts README decision 51 a).
    check(
      'certification_issued_check',
      sql`(issued_on is null) = (expires_on is null) and (issued_on is null) = (certificate_number is null) and (expires_on is null or expires_on > issued_on)`,
    ),
    check('certification_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** A certificate's units. Removing a unit archives its row. */
export const certificationUnit = pgTable(
  'certification_unit',
  {
    ...baseColumns(),
    clientId: uuid('client_id').notNull(),
    certificationId: uuid('certification_id').notNull(),
    unitId: uuid('unit_id').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'certification_unit_certification_fk',
      columns: [t.firmId, t.clientId, t.certificationId],
      foreignColumns: [certification.firmId, certification.clientId, certification.id],
    }),
    foreignKey({
      name: 'certification_unit_unit_fk',
      columns: [t.firmId, t.clientId, t.unitId],
      foreignColumns: [unit.firmId, unit.clientId, unit.id],
    }),
    uniqueIndex('certification_unit_live_key')
      .on(t.certificationId, t.unitId)
      .where(sql`archived_at is null`),
    index('certification_unit_unit_idx').on(t.unitId),
    clientPolicy(),
  ],
);

/** A certification body's visit; one integrated visit can cover several standards. */
export const externalAudit = pgTable(
  'external_audit',
  {
    ...recordColumns(),
    managementSystemId: uuid('management_system_id').notNull(),
    standardIds: uuid('standard_ids').array().notNull(),
    type: externalAuditTypeEnum('type').notNull(),
    body: text('body').notNull(),
    leadAuditorName: text('lead_auditor_name'),
    startOn: date('start_on', { mode: 'string' }).notNull(),
    endOn: date('end_on', { mode: 'string' }).notNull(),
    recommendation: auditRecommendationEnum('recommendation'),
    responseDueOn: date('response_due_on', { mode: 'string' }),
    state: externalAuditStateEnum('state').notNull().default('PLANNED'),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    unique('external_audit_scope_key').on(t.firmId, t.clientId, t.id),
    systemFk('external_audit_system_fk', t),
    index('external_audit_system_idx').on(t.managementSystemId, t.startOn),
    check('external_audit_standards_check', standardList('standard_ids')),
    check('external_audit_dates_check', sql`end_on >= start_on`),
    check('external_audit_closed_check', sql`state <> 'CLOSED' or recommendation is not null`),
    check('external_audit_cancel_check', sql`(state = 'CANCELLED') = (cancel_reason is not null)`),
    check('external_audit_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

// ---------- files ----------

/**
 * The `iso_file` subject columns this migration creates, by contracts `IsoFileSubjectType`. ISO-2e adds the rest
 * (model §6) and widens `iso_file_subject_check` to cover them.
 */
export const ISO_FILE_SUBJECTS_PART_1 = {
  clause_assessment: 'clause_assessment_id',
  document_revision: 'document_revision_id',
  external_audit: 'external_audit_id',
  certification: 'certification_id',
} as const;

/**
 * An ISO file: never in `evidence` (model §6). One nullable column per subject, exactly one set. The file is in
 * object storage under `storage_key`, inside the account's purge prefix, and is never returned to clients.
 */
export const isoFile = pgTable(
  'iso_file',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    archivedAt: instant('archived_at'),
    clientId: uuid('client_id').notNull(),
    clauseAssessmentId: uuid('clause_assessment_id'),
    documentRevisionId: uuid('document_revision_id'),
    externalAuditId: uuid('external_audit_id'),
    certificationId: uuid('certification_id'),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    scanStatus: scanStatusEnum('scan_status').notNull().default('PENDING'),
    uploadedById: uuid('uploaded_by_id').notNull(),
    uploadedAt: instant('uploaded_at').notNull().defaultNow(),
    removeReason: text('remove_reason'),
  },
  (t) => [
    foreignKey({
      name: 'iso_file_clause_assessment_fk',
      columns: [t.firmId, t.clientId, t.clauseAssessmentId],
      foreignColumns: [clauseAssessment.firmId, clauseAssessment.clientId, clauseAssessment.id],
    }),
    foreignKey({
      name: 'iso_file_document_revision_fk',
      columns: [t.firmId, t.clientId, t.documentRevisionId],
      foreignColumns: [documentRevision.firmId, documentRevision.clientId, documentRevision.id],
    }),
    foreignKey({
      name: 'iso_file_external_audit_fk',
      columns: [t.firmId, t.clientId, t.externalAuditId],
      foreignColumns: [externalAudit.firmId, externalAudit.clientId, externalAudit.id],
    }),
    foreignKey({
      name: 'iso_file_certification_fk',
      columns: [t.firmId, t.clientId, t.certificationId],
      foreignColumns: [certification.firmId, certification.clientId, certification.id],
    }),
    foreignKey({
      name: 'iso_file_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    foreignKey({
      name: 'iso_file_uploaded_by_fk',
      columns: [t.firmId, t.uploadedById],
      foreignColumns: [person.firmId, person.id],
    }),
    uniqueIndex('iso_file_storage_key_key').on(t.storageKey),
    index('iso_file_clause_assessment_idx').on(t.clauseAssessmentId),
    index('iso_file_document_revision_idx').on(t.documentRevisionId),
    index('iso_file_external_audit_idx').on(t.externalAuditId),
    index('iso_file_certification_idx').on(t.certificationId),
    // The scan job's queue (isoFiles.pendingScan).
    index('iso_file_pending_idx')
      .on(t.createdAt)
      .where(sql`scan_status = 'PENDING' and archived_at is null`),
    check(
      'iso_file_subject_check',
      sql`num_nonnulls(clause_assessment_id, document_revision_id, external_audit_id, certification_id) = 1`,
    ),
    check('iso_file_size_check', sql.raw(`size_bytes between 1 and ${MAX_EVIDENCE_BYTES}`)),
    check('iso_file_sha256_check', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check('iso_file_removed_check', sql`(archived_at is null) = (remove_reason is null)`),
    // Keys sit inside the account's purge prefix (model §6, apps/api/src/platform/purge-objects.ts).
    check(
      'iso_file_storage_key_check',
      sql`starts_with(storage_key, 'evidence/' || firm_id || '/' || client_id || '/iso/')`,
    ),
    clientPolicy(),
  ],
);

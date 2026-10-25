import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { MAX_EVIDENCE_BYTES, type RecurrenceRule } from '@canopy/contracts';
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
  aspectControlTypeEnum,
  auditRecommendationEnum,
  checklistResultEnum,
  controlHierarchyEnum,
  findingTypeEnum,
  incidentOutcomeEnum,
  incidentPersonCategoryEnum,
  incidentTypeEnum,
  internalAuditRoleEnum,
  internalAuditStateEnum,
  isoActionStateEnum,
  lifeCycleStageEnum,
  managementReviewStateEnum,
  ncDispositionEnum,
  ncSeverityEnum,
  ncSourceEnum,
  ncStateEnum,
  nonconformityRiskRoleEnum,
  objectiveDirectionEnum,
  objectiveOutcomeEnum,
  operatingConditionEnum,
  personsExposedEnum,
  riskKindEnum,
  rootCauseMethodEnum,
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
import { complianceInstance } from './work.js';

/**
 * The ISO add-on (docs/iso/model.md §1-3.13, §6): part 1 (ISO-2d) and part 2 (ISO-2e). Catalogue tables are the account's own copy,
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

// ---------- part 2 (ISO-2e): shared helpers ----------

/** A list of 1-3 distinct standard codes (`StandardList`: an objective's, an NC's, a review's standards). */
const codeList = (column: string) =>
  sql.raw(`cardinality(${column}) between 1 and 3 and canopy_values_distinct(${column})`);

/** At most `max` distinct ids of catalogue rows or obligations (model §1.4: M16 checks each exists). */
const idList = (column: string, max: number) =>
  sql.raw(`cardinality(${column}) <= ${max} and canopy_ids_distinct(${column})`);

const emptyIds = sql`'{}'::uuid[]`;

/** A person reference: a firm-level row, by `(firm_id, id)`. */
function personFk(name: string, firmId: AnyPgColumn, column: AnyPgColumn) {
  return foreignKey({
    name,
    columns: [firmId, column],
    foreignColumns: [person.firmId, person.id],
  });
}

/** A reference to a row of the same client, by `(firm_id, client_id, id)`. */
function sameClientFk(
  name: string,
  t: { firmId: AnyPgColumn; clientId: AnyPgColumn },
  column: AnyPgColumn,
  target: { firmId: AnyPgColumn; clientId: AnyPgColumn; id: AnyPgColumn },
) {
  return foreignKey({
    name,
    columns: [t.firmId, t.clientId, column],
    foreignColumns: [target.firmId, target.clientId, target.id],
  });
}

/** Columns of a join table row (model §1.4): firm, client, no version; removal archives it. */
function joinColumns() {
  return { ...baseColumns(), clientId: uuid('client_id').notNull() };
}

// ---------- risks and objectives ----------

/**
 * 6.1 risks and opportunities, 14001 aspects and 45001 hazards (model §3.5). `rating`, `residual_rating` and
 * `significant` are the engine's results, stored at write (model §1.7); the checks keep the contracts' kind rules.
 */
export const riskItem = pgTable(
  'risk_item',
  {
    ...recordColumns(),
    managementSystemId: uuid('management_system_id').notNull(),
    kind: riskKindEnum('kind').notNull(),
    unitId: uuid('unit_id'),
    activity: text('activity').notNull(),
    description: text('description').notNull(),
    impact: text('impact'),
    lifeCycleStages: lifeCycleStageEnum('life_cycle_stages')
      .array()
      .notNull()
      .default(sql`'{}'`),
    controlType: aspectControlTypeEnum('control_type'),
    routine: boolean('routine'),
    personsExposed: personsExposedEnum('persons_exposed')
      .array()
      .notNull()
      .default(sql`'{}'`),
    condition: operatingConditionEnum('condition'),
    assessedWith: text('assessed_with'),
    likelihood: integer('likelihood').notNull(),
    severity: integer('severity').notNull(),
    residualLikelihood: integer('residual_likelihood'),
    residualSeverity: integer('residual_severity'),
    rating: integer('rating').notNull(),
    residualRating: integer('residual_rating'),
    significant: boolean('significant').notNull(),
    significantOverride: boolean('significant_override'),
    significanceReason: text('significance_reason'),
    obligationIds: uuid('obligation_ids').array().notNull().default(emptyIds),
    climateRelated: boolean('climate_related').notNull().default(false),
    ownerId: uuid('owner_id').notNull(),
    reviewDueOn: date('review_due_on', { mode: 'string' }),
    lastReviewedOn: date('last_reviewed_on', { mode: 'string' }),
  },
  (t) => [
    unique('risk_item_scope_key').on(t.firmId, t.clientId, t.id),
    systemFk('risk_item_system_fk', t),
    sameClientFk('risk_item_unit_fk', t, t.unitId, unit),
    personFk('risk_item_owner_fk', t.firmId, t.ownerId),
    index('risk_item_system_idx').on(t.managementSystemId),
    index('risk_item_unit_idx').on(t.unitId),
    index('risk_item_owner_idx').on(t.ownerId),
    index('risk_item_review_due_idx').on(t.firmId, t.reviewDueOn),
    check(
      'risk_item_scales_check',
      sql`likelihood between 1 and 5 and severity between 1 and 5 and rating between 1 and 25`,
    ),
    check(
      'risk_item_residual_check',
      sql`(residual_likelihood is null) = (residual_severity is null) and (residual_likelihood is null) = (residual_rating is null) and (residual_likelihood is null or (residual_likelihood between 1 and 5 and residual_severity between 1 and 5 and residual_rating between 1 and 25))`,
    ),
    check('risk_item_impact_check', sql`kind not in ('ASPECT', 'HAZARD') or impact is not null`),
    check(
      'risk_item_aspect_check',
      sql`(kind = 'ASPECT') = (cardinality(life_cycle_stages) > 0) and (kind = 'ASPECT') = (control_type is not null) and canopy_values_distinct(life_cycle_stages)`,
    ),
    check(
      'risk_item_hazard_check',
      sql`(kind = 'HAZARD') = (cardinality(persons_exposed) > 0) and (kind = 'HAZARD') = (routine is not null) and canopy_values_distinct(persons_exposed)`,
    ),
    check(
      'risk_item_condition_check',
      sql`(kind in ('ASPECT', 'HAZARD')) = (condition is not null)`,
    ),
    check(
      'risk_item_override_check',
      sql`(significant_override is null) = (significance_reason is null)`,
    ),
    check('risk_item_obligations_check', idList('obligation_ids', 50)),
    check('risk_item_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** 6.2: an objective of some of its system's standards. Its risk items are `objective_risk_item` rows. */
export const objective = pgTable(
  'objective',
  {
    ...recordColumns(),
    managementSystemId: uuid('management_system_id').notNull(),
    standards: isoStandardCodeEnum('standards').array().notNull(),
    text: text('text').notNull(),
    target: doublePrecision('target').notNull(),
    unitOfMeasure: text('unit_of_measure').notNull(),
    baseline: doublePrecision('baseline'),
    direction: objectiveDirectionEnum('direction').notNull(),
    /** Shape validated with the contracts `RecurrenceRule` schema before every write. */
    readingRule: jsonb('reading_rule').$type<RecurrenceRule>().notNull(),
    ownerId: uuid('owner_id').notNull(),
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    closedOn: date('closed_on', { mode: 'string' }),
    outcome: objectiveOutcomeEnum('outcome'),
  },
  (t) => [
    unique('objective_scope_key').on(t.firmId, t.clientId, t.id),
    systemFk('objective_system_fk', t),
    personFk('objective_owner_fk', t.firmId, t.ownerId),
    index('objective_system_idx').on(t.managementSystemId),
    index('objective_owner_idx').on(t.ownerId),
    check('objective_standards_check', codeList('standards')),
    check(
      'objective_reading_rule_check',
      sql`jsonb_typeof(reading_rule) = 'object' and reading_rule ? 'kind'`,
    ),
    check('objective_closed_check', sql`(closed_on is null) = (outcome is null)`),
    check('objective_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** One reading of an objective's measure over a period. */
export const objectiveReading = pgTable(
  'objective_reading',
  {
    ...recordColumns(),
    objectiveId: uuid('objective_id').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    value: doublePrecision('value').notNull(),
    note: text('note'),
    recordedById: uuid('recorded_by_id').notNull(),
  },
  (t) => [
    unique('objective_reading_scope_key').on(t.firmId, t.clientId, t.id),
    sameClientFk('objective_reading_objective_fk', t, t.objectiveId, objective),
    personFk('objective_reading_recorded_by_fk', t.firmId, t.recordedById),
    index('objective_reading_objective_idx').on(t.objectiveId, t.periodStart),
    check('objective_reading_period_check', sql`period_end >= period_start`),
    check('objective_reading_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** The risk items an objective addresses (14001 and 45001 6.2.1). */
export const objectiveRiskItem = pgTable(
  'objective_risk_item',
  {
    ...joinColumns(),
    objectiveId: uuid('objective_id').notNull(),
    riskItemId: uuid('risk_item_id').notNull(),
  },
  (t) => [
    sameClientFk('objective_risk_item_objective_fk', t, t.objectiveId, objective),
    sameClientFk('objective_risk_item_risk_item_fk', t, t.riskItemId, riskItem),
    uniqueIndex('objective_risk_item_live_key')
      .on(t.objectiveId, t.riskItemId)
      .where(sql`archived_at is null`),
    index('objective_risk_item_risk_item_idx').on(t.riskItemId),
    clientPolicy(),
  ],
);

// ---------- internal audits ----------

/** 9.2: the audit programme of one FY of a system. */
export const auditProgramme = pgTable(
  'audit_programme',
  {
    ...recordColumns(),
    managementSystemId: uuid('management_system_id').notNull(),
    fy: text('fy').notNull(),
    notes: text('notes'),
  },
  (t) => [
    unique('audit_programme_scope_key').on(t.firmId, t.clientId, t.id),
    unique('audit_programme_fy_key').on(t.managementSystemId, t.fy),
    systemFk('audit_programme_system_fk', t),
    // FyLabel: "2026-27", the second year the first plus one.
    check(
      'audit_programme_fy_check',
      sql`fy ~ '^[0-9]{4}-[0-9]{2}$' and (left(fy, 4)::int + 1) % 100 = right(fy, 2)::int`,
    ),
    check('audit_programme_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/**
 * An internal audit of a programme. Its units are `internal_audit_unit` rows (none: the system's) and its auditors,
 * auditees and reported-to people `internal_audit_person` rows; the lead is a column.
 */
export const internalAudit = pgTable(
  'internal_audit',
  {
    ...recordColumns(),
    programmeId: uuid('programme_id').notNull(),
    title: text('title').notNull(),
    plannedStart: date('planned_start', { mode: 'string' }).notNull(),
    plannedEnd: date('planned_end', { mode: 'string' }).notNull(),
    clauseIds: uuid('clause_ids').array().notNull().default(emptyIds),
    leadAuditorId: uuid('lead_auditor_id').notNull(),
    independenceNote: text('independence_note'),
    state: internalAuditStateEnum('state').notNull().default('PLANNED'),
    summary: text('summary'),
    reportedOn: date('reported_on', { mode: 'string' }),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    unique('internal_audit_scope_key').on(t.firmId, t.clientId, t.id),
    sameClientFk('internal_audit_programme_fk', t, t.programmeId, auditProgramme),
    personFk('internal_audit_lead_auditor_fk', t.firmId, t.leadAuditorId),
    index('internal_audit_programme_idx').on(t.programmeId, t.plannedStart),
    index('internal_audit_lead_auditor_idx').on(t.leadAuditorId),
    check('internal_audit_dates_check', sql`planned_end >= planned_start`),
    check('internal_audit_clauses_check', idList('clause_ids', 300)),
    check(
      'internal_audit_reported_check',
      sql`(state in ('REPORTED', 'CLOSED')) = (reported_on is not null) and (state not in ('REPORTED', 'CLOSED') or summary is not null)`,
    ),
    check('internal_audit_cancel_check', sql`(state = 'CANCELLED') = (cancel_reason is not null)`),
    check('internal_audit_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** An internal audit's units. */
export const internalAuditUnit = pgTable(
  'internal_audit_unit',
  {
    ...joinColumns(),
    internalAuditId: uuid('internal_audit_id').notNull(),
    unitId: uuid('unit_id').notNull(),
  },
  (t) => [
    sameClientFk('internal_audit_unit_audit_fk', t, t.internalAuditId, internalAudit),
    sameClientFk('internal_audit_unit_unit_fk', t, t.unitId, unit),
    uniqueIndex('internal_audit_unit_live_key')
      .on(t.internalAuditId, t.unitId)
      .where(sql`archived_at is null`),
    index('internal_audit_unit_unit_idx').on(t.unitId),
    clientPolicy(),
  ],
);

/** The people of an internal audit, by role: auditor, auditee or reported-to. */
export const internalAuditPerson = pgTable(
  'internal_audit_person',
  {
    ...joinColumns(),
    internalAuditId: uuid('internal_audit_id').notNull(),
    personId: uuid('person_id').notNull(),
    role: internalAuditRoleEnum('role').notNull(),
  },
  (t) => [
    sameClientFk('internal_audit_person_audit_fk', t, t.internalAuditId, internalAudit),
    personFk('internal_audit_person_person_fk', t.firmId, t.personId),
    uniqueIndex('internal_audit_person_live_key')
      .on(t.internalAuditId, t.role, t.personId)
      .where(sql`archived_at is null`),
    index('internal_audit_person_person_idx').on(t.personId),
    clientPolicy(),
  ],
);

// ---------- nonconformities ----------

/**
 * 10.2: a nonconformity (model §3.10). `number` counts per client from 1: a trigger (migration 0041) sets it on
 * insert and keeps it on update. The incident fields (model §3.11) are `incident_*` columns, set exactly for an
 * INCIDENT or NEAR_MISS source; its investigators are `nonconformity_person` rows, its risk items
 * `nonconformity_risk_item` rows and its changed documents `nonconformity_document` rows.
 */
export const nonconformity = pgTable(
  'nonconformity',
  {
    ...recordColumns(),
    managementSystemId: uuid('management_system_id').notNull(),
    number: integer('number').notNull(),
    source: ncSourceEnum('source').notNull(),
    sourceInstanceId: uuid('source_instance_id'),
    raisedFromRiskItemId: uuid('raised_from_risk_item_id'),
    severity: ncSeverityEnum('severity').notNull(),
    standards: isoStandardCodeEnum('standards').array().notNull(),
    clauseIds: uuid('clause_ids').array().notNull().default(emptyIds),
    unitId: uuid('unit_id'),
    description: text('description').notNull(),
    reportedById: uuid('reported_by_id').notNull(),
    reportedOn: date('reported_on', { mode: 'string' }).notNull(),
    containment: text('containment'),
    correction: text('correction'),
    disposition: ncDispositionEnum('disposition'),
    dispositionAuthorisedById: uuid('disposition_authorised_by_id'),
    rootCauseMethod: rootCauseMethodEnum('root_cause_method'),
    rootCause: text('root_cause'),
    similarOccurrences: text('similar_occurrences'),
    riskReview: text('risk_review'),
    systemChange: text('system_change'),
    noActionReason: text('no_action_reason'),
    ownerId: uuid('owner_id').notNull(),
    approverId: uuid('approver_id').notNull(),
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    effectivenessDueOn: date('effectiveness_due_on', { mode: 'string' }),
    effectivenessNote: text('effectiveness_note'),
    effective: boolean('effective'),
    closedOn: date('closed_on', { mode: 'string' }),
    cancelReason: text('cancel_reason'),
    state: ncStateEnum('state').notNull().default('OPEN'),
    incidentOccurredAt: instant('incident_occurred_at'),
    incidentLocation: text('incident_location'),
    incidentType: incidentTypeEnum('incident_type'),
    incidentOutcome: incidentOutcomeEnum('incident_outcome'),
    incidentPersonCategory: incidentPersonCategoryEnum('incident_person_category'),
    incidentLostDays: integer('incident_lost_days'),
    incidentReportable: boolean('incident_reportable'),
    statutoryInstanceId: uuid('statutory_instance_id'),
    incidentWorkerParticipation: boolean('incident_worker_participation'),
  },
  (t) => [
    unique('nonconformity_scope_key').on(t.firmId, t.clientId, t.id),
    unique('nonconformity_number_key').on(t.firmId, t.clientId, t.number),
    systemFk('nonconformity_system_fk', t),
    sameClientFk('nonconformity_source_instance_fk', t, t.sourceInstanceId, complianceInstance),
    sameClientFk(
      'nonconformity_statutory_instance_fk',
      t,
      t.statutoryInstanceId,
      complianceInstance,
    ),
    sameClientFk('nonconformity_risk_item_fk', t, t.raisedFromRiskItemId, riskItem),
    sameClientFk('nonconformity_unit_fk', t, t.unitId, unit),
    personFk('nonconformity_reported_by_fk', t.firmId, t.reportedById),
    personFk('nonconformity_disposition_by_fk', t.firmId, t.dispositionAuthorisedById),
    personFk('nonconformity_owner_fk', t.firmId, t.ownerId),
    personFk('nonconformity_approver_fk', t.firmId, t.approverId),
    index('nonconformity_system_idx').on(t.managementSystemId),
    index('nonconformity_unit_idx').on(t.unitId),
    index('nonconformity_owner_state_idx').on(t.ownerId, t.state),
    index('nonconformity_approver_state_idx').on(t.approverId, t.state),
    index('nonconformity_source_instance_idx').on(t.sourceInstanceId),
    index('nonconformity_statutory_instance_idx').on(t.statutoryInstanceId),
    index('nonconformity_risk_item_idx').on(t.raisedFromRiskItemId),
    // The contracts' Nonconformity and Incident refinements, kept by the database too.
    check('nonconformity_number_check', sql`number >= 1`),
    check('nonconformity_standards_check', codeList('standards')),
    check('nonconformity_clauses_check', idList('clause_ids', 20)),
    check('nonconformity_maker_checker_check', sql`owner_id <> approver_id`),
    check('nonconformity_due_check', sql`due_on >= reported_on`),
    check(
      'nonconformity_disposition_check',
      sql`(disposition is null) = (disposition_authorised_by_id is null)`,
    ),
    check(
      'nonconformity_root_cause_check',
      sql`state not in ('ROOT_CAUSE_FOUND', 'ACTIONS_PLANNED', 'AWAITING_VERIFICATION', 'CLOSED') or num_nonnulls(containment, correction, root_cause_method, root_cause, similar_occurrences) = 5`,
    ),
    check(
      'nonconformity_submitted_check',
      sql`state not in ('AWAITING_VERIFICATION', 'CLOSED') or (risk_review is not null and system_change is not null)`,
    ),
    check(
      'nonconformity_closed_check',
      sql`(state = 'CLOSED') = (closed_on is not null) and (state <> 'CLOSED' or (effective and effectiveness_note is not null)) and (closed_on is null or closed_on >= reported_on)`,
    ),
    check('nonconformity_cancel_check', sql`(state = 'CANCELLED') = (cancel_reason is not null)`),
    check(
      'nonconformity_incident_check',
      sql`num_nonnulls(incident_occurred_at, incident_location, incident_type, incident_outcome, incident_reportable, incident_worker_participation) = case when source in ('INCIDENT', 'NEAR_MISS') then 6 else 0 end and (incident_type is not null or num_nonnulls(incident_person_category, incident_lost_days, statutory_instance_id) = 0)`,
    ),
    check(
      'nonconformity_incident_unit_check',
      sql`source not in ('INCIDENT', 'NEAR_MISS') or unit_id is not null`,
    ),
    check(
      'nonconformity_near_miss_check',
      sql`incident_type is null or ((incident_type = 'NEAR_MISS') = (source = 'NEAR_MISS') and (incident_type <> 'NEAR_MISS' or incident_outcome = 'NONE'))`,
    ),
    check(
      'nonconformity_lost_days_check',
      sql`(incident_lost_days is not null) = (incident_outcome is not distinct from 'LOST_TIME') and (incident_lost_days is null or incident_lost_days between 1 and 10000)`,
    ),
    check('nonconformity_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** An NC's investigators (model §3.11). Every row is an investigator: the table has the one role. */
export const nonconformityPerson = pgTable(
  'nonconformity_person',
  {
    ...joinColumns(),
    nonconformityId: uuid('nonconformity_id').notNull(),
    personId: uuid('person_id').notNull(),
  },
  (t) => [
    sameClientFk('nonconformity_person_nonconformity_fk', t, t.nonconformityId, nonconformity),
    personFk('nonconformity_person_person_fk', t.firmId, t.personId),
    uniqueIndex('nonconformity_person_live_key')
      .on(t.nonconformityId, t.personId)
      .where(sql`archived_at is null`),
    index('nonconformity_person_person_idx').on(t.personId),
    clientPolicy(),
  ],
);

/** The risk items an NC reviewed (RELATED) or changed (UPDATED). */
export const nonconformityRiskItem = pgTable(
  'nonconformity_risk_item',
  {
    ...joinColumns(),
    nonconformityId: uuid('nonconformity_id').notNull(),
    riskItemId: uuid('risk_item_id').notNull(),
    role: nonconformityRiskRoleEnum('role').notNull(),
  },
  (t) => [
    sameClientFk('nonconformity_risk_item_nonconformity_fk', t, t.nonconformityId, nonconformity),
    sameClientFk('nonconformity_risk_item_risk_item_fk', t, t.riskItemId, riskItem),
    uniqueIndex('nonconformity_risk_item_live_key')
      .on(t.nonconformityId, t.role, t.riskItemId)
      .where(sql`archived_at is null`),
    index('nonconformity_risk_item_risk_item_idx').on(t.riskItemId),
    clientPolicy(),
  ],
);

/** The documents an NC changed. */
export const nonconformityDocument = pgTable(
  'nonconformity_document',
  {
    ...joinColumns(),
    nonconformityId: uuid('nonconformity_id').notNull(),
    documentId: uuid('document_id').notNull(),
  },
  (t) => [
    sameClientFk('nonconformity_document_nonconformity_fk', t, t.nonconformityId, nonconformity),
    sameClientFk('nonconformity_document_document_fk', t, t.documentId, controlledDocument),
    uniqueIndex('nonconformity_document_live_key')
      .on(t.nonconformityId, t.documentId)
      .where(sql`archived_at is null`),
    index('nonconformity_document_document_idx').on(t.documentId),
    clientPolicy(),
  ],
);

// ---------- findings and checklists ----------

/**
 * A finding of exactly one internal or external audit (model §3.9). A MAJOR_NC or MINOR_NC finding links the NC it
 * raised; no other type links one, and an NC is raised by at most one finding.
 */
export const auditFinding = pgTable(
  'audit_finding',
  {
    ...recordColumns(),
    internalAuditId: uuid('internal_audit_id'),
    externalAuditId: uuid('external_audit_id'),
    type: findingTypeEnum('type').notNull(),
    clauseIds: uuid('clause_ids').array().notNull().default(emptyIds),
    unitId: uuid('unit_id'),
    description: text('description').notNull(),
    nonconformityId: uuid('nonconformity_id'),
  },
  (t) => [
    unique('audit_finding_scope_key').on(t.firmId, t.clientId, t.id),
    sameClientFk('audit_finding_internal_audit_fk', t, t.internalAuditId, internalAudit),
    sameClientFk('audit_finding_external_audit_fk', t, t.externalAuditId, externalAudit),
    sameClientFk('audit_finding_unit_fk', t, t.unitId, unit),
    sameClientFk('audit_finding_nonconformity_fk', t, t.nonconformityId, nonconformity),
    uniqueIndex('audit_finding_nonconformity_key').on(t.nonconformityId),
    index('audit_finding_internal_audit_idx').on(t.internalAuditId),
    index('audit_finding_external_audit_idx').on(t.externalAuditId),
    check('audit_finding_audit_check', sql`num_nonnulls(internal_audit_id, external_audit_id) = 1`),
    check(
      'audit_finding_nonconformity_check',
      sql`(nonconformity_id is not null) = (type in ('MAJOR_NC', 'MINOR_NC'))`,
    ),
    check('audit_finding_clauses_check', idList('clause_ids', 20)),
    check('audit_finding_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** One row of an internal audit's checklist. A FINDING row links its finding. */
export const auditChecklistItem = pgTable(
  'audit_checklist_item',
  {
    ...recordColumns(),
    internalAuditId: uuid('internal_audit_id').notNull(),
    clauseId: uuid('clause_id').notNull(),
    unitId: uuid('unit_id'),
    question: text('question').notNull(),
    auditorNote: text('auditor_note'),
    result: checklistResultEnum('result'),
    findingId: uuid('finding_id'),
    notAuditedReason: text('not_audited_reason'),
  },
  (t) => [
    unique('audit_checklist_item_scope_key').on(t.firmId, t.clientId, t.id),
    sameClientFk('audit_checklist_item_audit_fk', t, t.internalAuditId, internalAudit),
    foreignKey({
      name: 'audit_checklist_item_clause_fk',
      columns: [t.firmId, t.clauseId],
      foreignColumns: [isoClause.firmId, isoClause.id],
    }),
    sameClientFk('audit_checklist_item_unit_fk', t, t.unitId, unit),
    sameClientFk('audit_checklist_item_finding_fk', t, t.findingId, auditFinding),
    index('audit_checklist_item_audit_idx').on(t.internalAuditId),
    index('audit_checklist_item_finding_idx').on(t.findingId),
    check(
      'audit_checklist_item_result_check',
      sql`(finding_id is not null) = (result is not distinct from 'FINDING') and (not_audited_reason is not null) = (result is not distinct from 'NOT_AUDITED')`,
    ),
    check('audit_checklist_item_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

// ---------- management review ----------

/** 9.3: a management review of some of its system's standards. Its attendees are `management_review_person` rows. */
export const managementReview = pgTable(
  'management_review',
  {
    ...recordColumns(),
    managementSystemId: uuid('management_system_id').notNull(),
    standards: isoStandardCodeEnum('standards').array().notNull(),
    plannedOn: date('planned_on', { mode: 'string' }).notNull(),
    heldOn: date('held_on', { mode: 'string' }),
    chairId: uuid('chair_id').notNull(),
    minutes: text('minutes'),
    state: managementReviewStateEnum('state').notNull().default('PLANNED'),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    unique('management_review_scope_key').on(t.firmId, t.clientId, t.id),
    systemFk('management_review_system_fk', t),
    personFk('management_review_chair_fk', t.firmId, t.chairId),
    index('management_review_system_idx').on(t.managementSystemId, t.plannedOn),
    index('management_review_chair_idx').on(t.chairId),
    check('management_review_standards_check', codeList('standards')),
    check(
      'management_review_held_check',
      sql`(state in ('HELD', 'CLOSED')) = (held_on is not null)`,
    ),
    check(
      'management_review_cancel_check',
      sql`(state = 'CANCELLED') = (cancel_reason is not null)`,
    ),
    check('management_review_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** A review's attendees. Every row is an attendee: the table has the one role. */
export const managementReviewPerson = pgTable(
  'management_review_person',
  {
    ...joinColumns(),
    managementReviewId: uuid('management_review_id').notNull(),
    personId: uuid('person_id').notNull(),
  },
  (t) => [
    sameClientFk('management_review_person_review_fk', t, t.managementReviewId, managementReview),
    personFk('management_review_person_person_fk', t.firmId, t.personId),
    uniqueIndex('management_review_person_live_key')
      .on(t.managementReviewId, t.personId)
      .where(sql`archived_at is null`),
    index('management_review_person_person_idx').on(t.personId),
    clientPolicy(),
  ],
);

/** One input row of a review: one per input definition. */
export const reviewInput = pgTable(
  'review_input',
  {
    ...recordColumns(),
    managementReviewId: uuid('management_review_id').notNull(),
    inputDefId: uuid('input_def_id').notNull(),
    notes: text('notes'),
  },
  (t) => [
    unique('review_input_scope_key').on(t.firmId, t.clientId, t.id),
    unique('review_input_def_key').on(t.managementReviewId, t.inputDefId),
    sameClientFk('review_input_review_fk', t, t.managementReviewId, managementReview),
    foreignKey({
      name: 'review_input_def_fk',
      columns: [t.firmId, t.inputDefId],
      foreignColumns: [isoReviewInputDef.firmId, isoReviewInputDef.id],
    }),
    index('review_input_def_idx').on(t.inputDefId),
    check('review_input_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** One output row of a review: one per output definition. */
export const reviewOutput = pgTable(
  'review_output',
  {
    ...recordColumns(),
    managementReviewId: uuid('management_review_id').notNull(),
    outputDefId: uuid('output_def_id').notNull(),
    decision: text('decision'),
  },
  (t) => [
    unique('review_output_scope_key').on(t.firmId, t.clientId, t.id),
    unique('review_output_def_key').on(t.managementReviewId, t.outputDefId),
    sameClientFk('review_output_review_fk', t, t.managementReviewId, managementReview),
    foreignKey({
      name: 'review_output_def_fk',
      columns: [t.firmId, t.outputDefId],
      foreignColumns: [isoReviewOutputDef.firmId, isoReviewOutputDef.id],
    }),
    index('review_output_def_idx').on(t.outputDefId),
    check('review_output_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

// ---------- actions and controls ----------

/**
 * One action entity for every subject (model §3.12): exactly one subject column is set. A control hierarchy only on a
 * risk item's action, an output key only on a review's.
 */
export const isoAction = pgTable(
  'iso_action',
  {
    ...recordColumns(),
    nonconformityId: uuid('nonconformity_id'),
    riskItemId: uuid('risk_item_id'),
    objectiveId: uuid('objective_id'),
    auditFindingId: uuid('audit_finding_id'),
    managementReviewId: uuid('management_review_id'),
    text: text('text').notNull(),
    resources: text('resources'),
    ownerId: uuid('owner_id').notNull(),
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    doneOn: date('done_on', { mode: 'string' }),
    state: isoActionStateEnum('state').notNull().default('OPEN'),
    effectivenessNote: text('effectiveness_note'),
    cancelReason: text('cancel_reason'),
    controlHierarchy: controlHierarchyEnum('control_hierarchy'),
    outputKey: reviewOutputKeyEnum('output_key'),
  },
  (t) => [
    unique('iso_action_scope_key').on(t.firmId, t.clientId, t.id),
    sameClientFk('iso_action_nonconformity_fk', t, t.nonconformityId, nonconformity),
    sameClientFk('iso_action_risk_item_fk', t, t.riskItemId, riskItem),
    sameClientFk('iso_action_objective_fk', t, t.objectiveId, objective),
    sameClientFk('iso_action_audit_finding_fk', t, t.auditFindingId, auditFinding),
    sameClientFk('iso_action_management_review_fk', t, t.managementReviewId, managementReview),
    personFk('iso_action_owner_fk', t.firmId, t.ownerId),
    index('iso_action_nonconformity_idx').on(t.nonconformityId),
    index('iso_action_risk_item_idx').on(t.riskItemId),
    index('iso_action_objective_idx').on(t.objectiveId),
    index('iso_action_audit_finding_idx').on(t.auditFindingId),
    index('iso_action_management_review_idx').on(t.managementReviewId),
    index('iso_action_owner_state_idx').on(t.ownerId, t.state),
    index('iso_action_open_due_idx')
      .on(t.firmId, t.dueOn)
      .where(sql`state = 'OPEN' and archived_at is null`),
    check(
      'iso_action_subject_check',
      sql`num_nonnulls(nonconformity_id, risk_item_id, objective_id, audit_finding_id, management_review_id) = 1`,
    ),
    check('iso_action_done_check', sql`(state = 'DONE') = (done_on is not null)`),
    check('iso_action_cancel_check', sql`(state = 'CANCELLED') = (cancel_reason is not null)`),
    check('iso_action_hierarchy_check', sql`control_hierarchy is null or risk_item_id is not null`),
    check('iso_action_output_check', sql`output_key is null or management_review_id is not null`),
    check('iso_action_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** A control in place on a risk item; `source_action_id` is the treatment action that put it there. */
export const riskControl = pgTable(
  'risk_control',
  {
    ...recordColumns(),
    riskItemId: uuid('risk_item_id').notNull(),
    text: text('text').notNull(),
    hierarchy: controlHierarchyEnum('hierarchy'),
    sourceActionId: uuid('source_action_id'),
  },
  (t) => [
    unique('risk_control_scope_key').on(t.firmId, t.clientId, t.id),
    sameClientFk('risk_control_risk_item_fk', t, t.riskItemId, riskItem),
    sameClientFk('risk_control_source_action_fk', t, t.sourceActionId, isoAction),
    index('risk_control_risk_item_idx').on(t.riskItemId),
    index('risk_control_source_action_idx').on(t.sourceActionId),
    check('risk_control_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

// ---------- files ----------

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
    riskItemId: uuid('risk_item_id'),
    objectiveReadingId: uuid('objective_reading_id'),
    internalAuditId: uuid('internal_audit_id'),
    auditFindingId: uuid('audit_finding_id'),
    nonconformityId: uuid('nonconformity_id'),
    isoActionId: uuid('iso_action_id'),
    managementReviewId: uuid('management_review_id'),
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
    sameClientFk('iso_file_risk_item_fk', t, t.riskItemId, riskItem),
    sameClientFk('iso_file_objective_reading_fk', t, t.objectiveReadingId, objectiveReading),
    sameClientFk('iso_file_internal_audit_fk', t, t.internalAuditId, internalAudit),
    sameClientFk('iso_file_audit_finding_fk', t, t.auditFindingId, auditFinding),
    sameClientFk('iso_file_nonconformity_fk', t, t.nonconformityId, nonconformity),
    sameClientFk('iso_file_iso_action_fk', t, t.isoActionId, isoAction),
    sameClientFk('iso_file_management_review_fk', t, t.managementReviewId, managementReview),
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
    index('iso_file_risk_item_idx').on(t.riskItemId),
    index('iso_file_objective_reading_idx').on(t.objectiveReadingId),
    index('iso_file_internal_audit_idx').on(t.internalAuditId),
    index('iso_file_audit_finding_idx').on(t.auditFindingId),
    index('iso_file_nonconformity_idx').on(t.nonconformityId),
    index('iso_file_iso_action_idx').on(t.isoActionId),
    index('iso_file_management_review_idx').on(t.managementReviewId),
    // The scan job's queue (isoFiles.pendingScan).
    index('iso_file_pending_idx')
      .on(t.createdAt)
      .where(sql`scan_status = 'PENDING' and archived_at is null`),
    check(
      'iso_file_subject_check',
      sql`num_nonnulls(clause_assessment_id, document_revision_id, external_audit_id, certification_id, risk_item_id, objective_reading_id, internal_audit_id, audit_finding_id, nonconformity_id, iso_action_id, management_review_id) = 1`,
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

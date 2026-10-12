import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
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
  applicabilityEnum,
  auditActionEnum,
  auditActorKindEnum,
  commentKindEnum,
  entityTypeEnum,
  scanStatusEnum,
  submissionKindEnum,
  workflowStateEnum,
} from './enums.js';
import { obligation } from './library.js';
import { client, department, person, unit } from './tenancy.js';

/** Work: assignments, instances, evidence, comments, audit (docs/contracts/domain-model.md §5). */

/** An obligation applied to a unit, with department, default owner and default approver. */
export const assignment = pgTable(
  'assignment',
  {
    ...baseColumns(),
    version: versionColumn(),
    clientId: uuid('client_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    obligationId: uuid('obligation_id').notNull(),
    departmentId: uuid('department_id').notNull(),
    defaultOwnerId: uuid('default_owner_id').notNull(),
    defaultApproverId: uuid('default_approver_id').notNull(),
    applicability: applicabilityEnum('applicability').notNull(),
    naReason: text('na_reason'),
    activeFrom: date('active_from', { mode: 'string' }).notNull(),
    activeTo: date('active_to', { mode: 'string' }),
  },
  (t) => [
    unique('assignment_scope_key').on(t.firmId, t.clientId, t.unitId, t.id),
    foreignKey({
      name: 'assignment_unit_fk',
      columns: [t.firmId, t.clientId, t.unitId],
      foreignColumns: [unit.firmId, unit.clientId, unit.id],
    }),
    foreignKey({
      name: 'assignment_obligation_fk',
      columns: [t.firmId, t.obligationId],
      foreignColumns: [obligation.firmId, obligation.id],
    }),
    foreignKey({
      name: 'assignment_department_fk',
      columns: [t.firmId, t.clientId, t.departmentId],
      foreignColumns: [department.firmId, department.clientId, department.id],
    }),
    foreignKey({
      name: 'assignment_default_owner_fk',
      columns: [t.firmId, t.defaultOwnerId],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'assignment_default_approver_fk',
      columns: [t.firmId, t.defaultApproverId],
      foreignColumns: [person.firmId, person.id],
    }),
    uniqueIndex('assignment_unit_obligation_department_key')
      .on(t.unitId, t.obligationId, t.departmentId)
      .where(sql`archived_at is null`),
    index('assignment_client_idx').on(t.firmId, t.clientId),
    index('assignment_obligation_idx').on(t.obligationId),
    index('assignment_department_idx').on(t.departmentId),
    index('assignment_default_owner_idx').on(t.defaultOwnerId),
    index('assignment_default_approver_idx').on(t.defaultApproverId),
    check(
      'assignment_na_reason_check',
      sql`applicability <> 'NOT_APPLICABLE' or na_reason is not null`,
    ),
    check('assignment_active_range_check', sql`active_to is null or active_to >= active_from`),
    check('assignment_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** One dated occurrence of an assignment (Excel: one row). Derived status is never stored. */
export const complianceInstance = pgTable(
  'compliance_instance',
  {
    ...baseColumns(),
    version: versionColumn(),
    clientId: uuid('client_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    assignmentId: uuid('assignment_id').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    workflowState: workflowStateEnum('workflow_state').notNull().default('OPEN'),
    pendingKind: submissionKindEnum('pending_kind'),
    completedOn: date('completed_on', { mode: 'string' }),
    naReason: text('na_reason'),
    ownerId: uuid('owner_id').notNull(),
    approverId: uuid('approver_id').notNull(),
    submittedAt: instant('submitted_at'),
    approvedAt: instant('approved_at'),
    dueDateOverridden: boolean('due_date_overridden').notNull().default(false),
  },
  (t) => [
    unique('compliance_instance_scope_key').on(t.firmId, t.clientId, t.id),
    // client and unit are denormalised for filtering and RLS; the key makes them match the assignment.
    foreignKey({
      name: 'compliance_instance_assignment_fk',
      columns: [t.firmId, t.clientId, t.unitId, t.assignmentId],
      foreignColumns: [assignment.firmId, assignment.clientId, assignment.unitId, assignment.id],
    }),
    foreignKey({
      name: 'compliance_instance_owner_fk',
      columns: [t.firmId, t.ownerId],
      foreignColumns: [person.firmId, person.id],
    }),
    foreignKey({
      name: 'compliance_instance_approver_fk',
      columns: [t.firmId, t.approverId],
      foreignColumns: [person.firmId, person.id],
    }),
    // Instance generation is idempotent on this key (apps/api/CLAUDE.md, jobs).
    unique('compliance_instance_assignment_period_key').on(t.assignmentId, t.periodStart),
    index('compliance_instance_client_due_idx').on(t.firmId, t.clientId, t.dueDate),
    index('compliance_instance_owner_state_idx').on(t.ownerId, t.workflowState),
    index('compliance_instance_approver_state_idx').on(t.approverId, t.workflowState),
    index('compliance_instance_unit_idx').on(t.unitId),
    // README decision 12.
    check('compliance_instance_period_check', sql`period_end >= period_start`),
    check(
      'compliance_instance_pending_kind_check',
      sql`(workflow_state = 'SUBMITTED') = (pending_kind is not null)`,
    ),
    check(
      'compliance_instance_completed_on_check',
      sql`completed_on is not null or not (workflow_state in ('APPROVED', 'NOT_APPLICABLE') or (workflow_state = 'SUBMITTED' and pending_kind = 'COMPLETION'))`,
    ),
    check(
      'compliance_instance_na_reason_check',
      sql`na_reason is not null or not (workflow_state = 'NOT_APPLICABLE' or pending_kind = 'NA')`,
    ),
    check('compliance_instance_version_check', sql`version >= 1`),
    clientPolicy(),
  ],
);

/** Largest evidence file (contracts MAX_EVIDENCE_BYTES, 25 MiB). */
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

/** Evidence file metadata. The file itself is in object storage under `storage_key`, never returned to clients. */
export const evidence = pgTable(
  'evidence',
  {
    ...baseColumns(),
    instanceId: uuid('instance_id').notNull(),
    clientId: uuid('client_id').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    scanStatus: scanStatusEnum('scan_status').notNull().default('PENDING'),
    uploadedById: uuid('uploaded_by_id').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'evidence_instance_fk',
      columns: [t.firmId, t.clientId, t.instanceId],
      foreignColumns: [
        complianceInstance.firmId,
        complianceInstance.clientId,
        complianceInstance.id,
      ],
    }),
    foreignKey({
      name: 'evidence_uploaded_by_fk',
      columns: [t.firmId, t.uploadedById],
      foreignColumns: [person.firmId, person.id],
    }),
    uniqueIndex('evidence_storage_key_key').on(t.storageKey),
    index('evidence_instance_idx').on(t.instanceId),
    index('evidence_client_idx').on(t.firmId, t.clientId, t.createdAt),
    check('evidence_size_check', sql.raw(`size_bytes between 1 and ${MAX_EVIDENCE_BYTES}`)),
    check('evidence_sha256_check', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    clientPolicy(),
  ],
);

export const comment = pgTable(
  'comment',
  {
    ...baseColumns(),
    instanceId: uuid('instance_id').notNull(),
    clientId: uuid('client_id').notNull(),
    /** Null for import and system comments. */
    authorId: uuid('author_id'),
    kind: commentKindEnum('kind').notNull(),
    body: text('body').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'comment_instance_fk',
      columns: [t.firmId, t.clientId, t.instanceId],
      foreignColumns: [
        complianceInstance.firmId,
        complianceInstance.clientId,
        complianceInstance.id,
      ],
    }),
    foreignKey({
      name: 'comment_author_fk',
      columns: [t.firmId, t.authorId],
      foreignColumns: [person.firmId, person.id],
    }),
    index('comment_instance_idx').on(t.instanceId, t.createdAt),
    clientPolicy(),
  ],
);

/**
 * Append-only legal history. The app role may only insert and read; a trigger rejects UPDATE, DELETE
 * and TRUNCATE for every role (packages/db/CLAUDE.md rule 6).
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    clientId: uuid('client_id'),
    at: instant('at').notNull().defaultNow(),
    requestId: text('request_id').notNull(),
    actorId: uuid('actor_id'),
    actorKind: auditActorKindEnum('actor_kind').notNull(),
    action: auditActionEnum('action').notNull(),
    entityType: entityTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    reason: text('reason'),
  },
  (t) => [
    foreignKey({
      name: 'audit_event_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    index('audit_event_client_at_idx').on(t.firmId, t.clientId, t.at),
    index('audit_event_entity_idx').on(t.entityType, t.entityId, t.at),
    check('audit_event_actor_check', sql`actor_kind <> 'PERSON' or actor_id is not null`),
    check('audit_event_request_id_check', sql`length(request_id) between 1 and 200`),
    optionalClientPolicy({ nullClientWrites: true }),
  ],
);

import { z } from 'zod';
import {
  Applicability,
  AuditAction,
  AuditActorKind,
  CommentKind,
  Criticality,
  DerivedStatus,
  EntityType,
  InstanceAction,
  ScanStatus,
  SubmissionKind,
  TimelineType,
  WorkflowState,
} from '../enums.js';
import {
  baseShape,
  Id,
  Instant,
  LocalDate,
  LongText,
  Name,
  Sha256,
  Text,
  versionedShape,
} from '../primitives.js';
import { TemplateRef } from './library.js';

/** Work: assignments, instances, evidence, comments, audit (docs/contracts/domain-model.md §5). */

/**
 * Shape check only: `YYYY-MM-DD` strings order the same as the dates they name.
 * Anything relative to "today" is engine work.
 */
function notBefore(later: string, earlier: string): boolean {
  return later >= earlier;
}

/** An obligation applied to a unit, with department, default owner and default approver. */
export const Assignment = z
  .strictObject({
    ...baseShape,
    ...versionedShape,
    clientId: Id,
    unitId: Id,
    obligationId: Id,
    departmentId: Id,
    defaultOwnerId: Id,
    defaultApproverId: Id,
    applicability: Applicability,
    /** Required when NOT_APPLICABLE. */
    naReason: LongText.nullable(),
    activeFrom: LocalDate,
    activeTo: LocalDate.nullable(),
  })
  .superRefine((a, ctx) => {
    if (a.applicability === 'NOT_APPLICABLE' && a.naReason === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['naReason'],
        message: 'NOT_APPLICABLE needs a naReason',
      });
    }
    if (a.activeTo !== null && !notBefore(a.activeTo, a.activeFrom)) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeTo'],
        message: 'activeTo is before activeFrom',
      });
    }
  });
export type Assignment = z.infer<typeof Assignment>;

/** One dated occurrence of an assignment. Unique on (assignmentId, periodStart). */
export const ComplianceInstance = z
  .strictObject({
    ...baseShape,
    ...versionedShape,
    /** Denormalised for filtering and RLS. */
    clientId: Id,
    unitId: Id,
    assignmentId: Id,
    periodStart: LocalDate,
    periodEnd: LocalDate,
    dueDate: LocalDate,
    workflowState: WorkflowState,
    /** Set while SUBMITTED, null otherwise. */
    pendingKind: SubmissionKind.nullable(),
    /** Required for APPROVED; for NOT_APPLICABLE the date NA was recorded. */
    completedOn: LocalDate.nullable(),
    /** Required when NOT_APPLICABLE or pendingKind is NA. */
    naReason: LongText.nullable(),
    /** Copied from the assignment; may be reassigned per instance. */
    ownerId: Id,
    approverId: Id,
    submittedAt: Instant.nullable(),
    approvedAt: Instant.nullable(),
    /** True when a person moved the due date (audited). */
    dueDateOverridden: z.boolean(),
  })
  .superRefine((i, ctx) => {
    if (!notBefore(i.periodEnd, i.periodStart)) {
      ctx.addIssue({
        code: 'custom',
        path: ['periodEnd'],
        message: 'periodEnd is before periodStart',
      });
    }
    if ((i.workflowState === 'SUBMITTED') !== (i.pendingKind !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pendingKind'],
        message: 'pendingKind is set exactly while SUBMITTED',
      });
    }
    const needsCompletedOn =
      i.workflowState === 'APPROVED' ||
      i.workflowState === 'NOT_APPLICABLE' ||
      (i.workflowState === 'SUBMITTED' && i.pendingKind === 'COMPLETION');
    if (needsCompletedOn && i.completedOn === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedOn'],
        message: `${i.workflowState} needs completedOn`,
      });
    }
    if ((i.workflowState === 'NOT_APPLICABLE' || i.pendingKind === 'NA') && i.naReason === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['naReason'],
        message: 'Not applicable needs a naReason',
      });
    }
  });
export type ComplianceInstance = z.infer<typeof ComplianceInstance>;

/** What engine.deriveStatus reads from an instance. */
export const InstanceStatusInput = z.strictObject({
  workflowState: WorkflowState,
  pendingKind: SubmissionKind.nullable(),
  dueDate: LocalDate,
  completedOn: LocalDate.nullable(),
});
export type InstanceStatusInput = z.infer<typeof InstanceStatusInput>;

const instanceRowShape = {
  id: Id,
  version: z.int().min(1),
  obligationId: Id,
  externalRef: Text.nullable(),
  title: Text,
  timelineType: TimelineType,
  categoryName: Name,
  actId: Id,
  actName: Name,
  criticality: Criticality,
  clientId: Id,
  companyName: Name,
  unitId: Id,
  unitName: Name,
  /** e.g. "India / West Bengal / Belur". */
  locationLabel: Name,
  departmentId: Id,
  departmentName: Name,
  ownerId: Id,
  ownerName: Name,
  approverId: Id,
  approverName: Name,
  periodStart: LocalDate,
  periodEnd: LocalDate,
  dueDate: LocalDate,
  completedOn: LocalDate.nullable(),
  workflowState: WorkflowState,
  pendingKind: SubmissionKind.nullable(),
  /** From the engine, asOf = today in the client time zone. */
  status: DerivedStatus,
  overdueDays: z.int().min(1).nullable(),
  evidenceCount: z.int().min(0),
  commentCount: z.int().min(0),
  lastComment: LongText.nullable(),
  formLabels: z.array(Text),
  logSheetLabels: z.array(Text),
};

/** Register row: what instance list endpoints return, flattened for the grid and export. */
export const InstanceRow = z.strictObject(instanceRowShape);
export type InstanceRow = z.infer<typeof InstanceRow>;

export const InstanceDetail = z.strictObject({
  ...instanceRowShape,
  description: LongText,
  applicabilityText: LongText.nullable(),
  naReason: LongText.nullable(),
  forms: z.array(TemplateRef),
  logSheets: z.array(TemplateRef),
  evidenceRequired: z.boolean(),
  /** Computed by the API from can() and the state machine; the UI shows only these. */
  allowedActions: z.array(InstanceAction),
});
export type InstanceDetail = z.infer<typeof InstanceDetail>;

/** Largest evidence file accepted (api-conventions.md §6). */
export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

const evidenceViewShape = {
  ...baseShape,
  instanceId: Id,
  clientId: Id,
  fileName: Text.max(255),
  mimeType: Text.max(255),
  sizeBytes: z.int().min(1).max(MAX_EVIDENCE_BYTES),
  sha256: Sha256,
  scanStatus: ScanStatus,
  uploadedById: Id,
};

/** Stored evidence. `storageKey` is never returned to clients; the API returns EvidenceView. */
export const Evidence = z.strictObject({ ...evidenceViewShape, storageKey: Text });
export type Evidence = z.infer<typeof Evidence>;

/** Evidence as the API returns it: Evidence without `storageKey`. */
export const EvidenceView = z.strictObject(evidenceViewShape);
export type EvidenceView = z.infer<typeof EvidenceView>;

export const Comment = z.strictObject({
  ...baseShape,
  instanceId: Id,
  clientId: Id,
  /** Null for import or system comments. */
  authorId: Id.nullable(),
  kind: CommentKind,
  body: LongText,
});
export type Comment = z.infer<typeof Comment>;

/**
 * Append-only audit record: no updatedAt, archivedAt or version.
 * `before`/`after` hold changed fields only; never file contents or signed URLs.
 */
export const AuditEvent = z
  .strictObject({
    id: Id,
    firmId: Id,
    clientId: Id.nullable(),
    at: Instant,
    requestId: z.string().min(1).max(200),
    actorId: Id.nullable(),
    actorKind: AuditActorKind,
    action: AuditAction,
    entityType: EntityType,
    entityId: Id,
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    reason: LongText.nullable(),
  })
  .refine((e) => e.actorKind !== 'PERSON' || e.actorId !== null, {
    message: 'A PERSON audit event names its actor',
    path: ['actorId'],
  });
export type AuditEvent = z.infer<typeof AuditEvent>;

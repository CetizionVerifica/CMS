import { z } from 'zod';
import {
  AuditAction,
  Criticality,
  DerivedStatus,
  EntityType,
  ObligationDomain,
  ScanStatus,
  TimelineType,
  WorkflowState,
} from '../enums.js';
import { MAX_EVIDENCE_BYTES } from '../schemas/work.js';
import { FyLabel, Id, Instant, LocalDate, LongText, Sha256, Text } from '../primitives.js';
import {
  asOfQueryShape,
  checkPeriod,
  csv,
  MAX_BULK_ITEMS,
  pageQueryShape,
  PersonRef,
  QueryBoolean,
  Reason,
  SearchText,
  sortParam,
  versionField,
} from './common.js';

/** M7 · Workflow, evidence, comments and audit (docs/contracts/endpoints.md §4). */

// ---------- register ----------

/** Fields the register can sort by (api-conventions.md §3). */
export const REGISTER_SORT_FIELDS = [
  'dueDate',
  'completedOn',
  'criticality',
  'title',
  'actName',
  'departmentName',
  'ownerName',
  'status',
  'updatedAt',
] as const;

/**
 * Register filters (api-conventions.md §3). Saved views, dashboard links and exports store exactly this query
 * string, so one filter language serves all of them.
 */
export const registerFilterShape = {
  unitId: csv(Id).optional(),
  departmentId: csv(Id).optional(),
  actId: csv(Id).optional(),
  categoryId: csv(Id).optional(),
  ownerId: PersonRef.optional(),
  approverId: PersonRef.optional(),
  criticality: csv(Criticality).optional(),
  status: csv(DerivedStatus).optional(),
  workflowState: csv(WorkflowState).optional(),
  timelineType: TimelineType.optional(),
  domain: csv(ObligationDomain).optional(),
  dueFrom: LocalDate.optional(),
  dueTo: LocalDate.optional(),
  fy: FyLabel.optional(),
  completedFrom: LocalDate.optional(),
  completedTo: LocalDate.optional(),
  hasEvidence: QueryBoolean.optional(),
  q: SearchText.optional(),
};

/** `fy` excludes dueFrom/dueTo; each range must run forwards. */
export function checkRegisterFilters(
  query: {
    fy?: unknown;
    dueFrom?: string;
    dueTo?: string;
    completedFrom?: string;
    completedTo?: string;
  },
  ctx: z.core.$RefinementCtx,
): void {
  checkPeriod({ fy: query.fy, from: query.dueFrom, to: query.dueTo }, ctx, {
    from: 'dueFrom',
    to: 'dueTo',
  });
  for (const [from, to] of [
    ['dueFrom', 'dueTo'],
    ['completedFrom', 'completedTo'],
  ] as const) {
    const start = query[from];
    const end = query[to];
    if (start !== undefined && end !== undefined && end < start) {
      ctx.addIssue({ code: 'custom', path: [to], message: `${to} is before ${from}` });
    }
  }
}

export const RegisterQuery = z
  .strictObject({
    ...pageQueryShape,
    ...asOfQueryShape,
    ...registerFilterShape,
    sort: sortParam(REGISTER_SORT_FIELDS).optional(),
  })
  .superRefine(checkRegisterFilters);
export type RegisterQuery = z.output<typeof RegisterQuery>;

/** The register filters an export takes in `ExportCreateBody.filters`: the register query without paging. */
export const RegisterFilterQuery = z
  .strictObject({
    ...asOfQueryShape,
    ...registerFilterShape,
    sort: sortParam(REGISTER_SORT_FIELDS).optional(),
  })
  .superRefine(checkRegisterFilters);

/** `/me/approvals` and `/me/tasks`: always the signed-in person's queue, by due date. */
export const MyQueueQuery = z.strictObject({ ...pageQueryShape, ...asOfQueryShape });

export const InstanceReadQuery = z.strictObject({ ...asOfQueryShape });

// ---------- transitions ----------

/**
 * OWNER marks the work done. `completedOn` may not be after today in the client's time zone. A comment is required
 * (domain-model.md §5).
 */
export const SubmitBody = z.strictObject({
  ...versionField,
  completedOn: LocalDate,
  comment: LongText.max(5000),
});
export type SubmitBody = z.infer<typeof SubmitBody>;

export const RequestNaBody = z.strictObject({ ...versionField, reason: Reason });
export type RequestNaBody = z.infer<typeof RequestNaBody>;

export const ApproveBody = z.strictObject({
  ...versionField,
  comment: LongText.max(5000).optional(),
});
export type ApproveBody = z.infer<typeof ApproveBody>;

export const SendBackBody = z.strictObject({ ...versionField, reason: Reason });
export type SendBackBody = z.infer<typeof SendBackBody>;

export const ReopenBody = z.strictObject({ ...versionField, reason: Reason });
export type ReopenBody = z.infer<typeof ReopenBody>;

export const BulkApproveBody = z.strictObject({
  items: z
    .array(z.strictObject({ id: Id, ...versionField }))
    .min(1)
    .max(MAX_BULK_ITEMS),
  comment: LongText.max(5000).optional(),
});
export type BulkApproveBody = z.infer<typeof BulkApproveBody>;

/**
 * Reassign or move the due date of one instance. Reassigning needs `instance.reassign`, moving the due date
 * `instance.due_date`; the reason is required for a due-date change and recorded for both.
 */
export const InstanceUpdateBody = z
  .strictObject({
    ...versionField,
    ownerId: Id.optional(),
    approverId: Id.optional(),
    dueDate: LocalDate.optional(),
    /** Required for every change: reassignment and due-date changes are audited with it. */
    reason: Reason,
  })
  .superRefine((body, ctx) => {
    if (body.ownerId === undefined && body.approverId === undefined && body.dueDate === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Nothing to update' });
    }
  });
export type InstanceUpdateBody = z.infer<typeof InstanceUpdateBody>;

// ---------- comments ----------

export const CommentListQuery = z.strictObject({ ...pageQueryShape });

export const CommentCreateBody = z.strictObject({ body: LongText.max(5000) });
export type CommentCreateBody = z.infer<typeof CommentCreateBody>;

// ---------- evidence ----------

/** Allowed evidence extensions (api-conventions.md §6). Zip files are scanned recursively. */
export const EVIDENCE_EXTENSIONS = [
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'heic',
  'docx',
  'xlsx',
  'xls',
  'csv',
  'txt',
  'zip',
] as const;

const EvidenceFileName = Text.max(255).refine(
  (name) => {
    const parts = name.toLowerCase().split('.');
    return parts.length > 1 && (EVIDENCE_EXTENSIONS as readonly string[]).includes(parts.at(-1)!);
  },
  { message: `Allowed file types: ${EVIDENCE_EXTENSIONS.join(', ')}` },
);

export const EvidenceUploadUrlBody = z.strictObject({
  fileName: EvidenceFileName,
  mimeType: Text.max(255),
  sizeBytes: z.int().min(1).max(MAX_EVIDENCE_BYTES),
});
export type EvidenceUploadUrlBody = z.infer<typeof EvidenceUploadUrlBody>;

/** Confirms an upload; the evidence stays PENDING until the virus scan finishes. */
export const EvidenceConfirmBody = z.strictObject({
  uploadId: Id,
  fileName: EvidenceFileName,
  sha256: Sha256,
});
export type EvidenceConfirmBody = z.infer<typeof EvidenceConfirmBody>;

export const EvidenceRemoveBody = z.strictObject({ reason: Reason });
export type EvidenceRemoveBody = z.infer<typeof EvidenceRemoveBody>;

/** Evidence vault filters. AP and OW see only their units. */
export const EvidenceVaultQuery = z
  .strictObject({
    ...pageQueryShape,
    unitId: csv(Id).optional(),
    actId: csv(Id).optional(),
    departmentId: csv(Id).optional(),
    uploadedFrom: LocalDate.optional(),
    uploadedTo: LocalDate.optional(),
    scanStatus: csv(ScanStatus).optional(),
    q: SearchText.optional(),
  })
  .refine(
    (query) =>
      query.uploadedFrom === undefined ||
      query.uploadedTo === undefined ||
      query.uploadedTo >= query.uploadedFrom,
    { path: ['uploadedTo'], message: 'uploadedTo is before uploadedFrom' },
  );

// ---------- audit ----------

export const AuditQuery = z
  .strictObject({
    ...pageQueryShape,
    entityType: EntityType.optional(),
    entityId: Id.optional(),
    actorId: Id.optional(),
    action: csv(AuditAction).optional(),
    /** Inclusive UTC bounds on `at`. */
    from: Instant.optional(),
    to: Instant.optional(),
  })
  // Compare instants, not strings: "…43.500Z" is after "…43Z" but sorts before it.
  .refine(
    (q) => q.from === undefined || q.to === undefined || Date.parse(q.to) >= Date.parse(q.from),
    {
      path: ['to'],
      message: 'to is before from',
    },
  );

export const InstanceAuditQuery = z.strictObject({ ...pageQueryShape });

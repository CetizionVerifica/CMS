import { z } from 'zod';
import { IsoExportKind, IsoStandardCode } from '../enums.js';
import { FyLabel, Id, LocalDate, LongText, Name, Sha256, Text } from '../primitives.js';
import { RecurrenceRule } from '../schemas/library.js';
import {
  AspectControlType,
  AuditProgramme,
  AuditRecommendation,
  Certification,
  ChecklistResult,
  ClauseAssessment,
  ClauseItem,
  ClauseNaAction,
  ClauseNaState,
  ClauseStatus,
  ClauseWorkStatus,
  ContextItemKind,
  ControlHierarchy,
  ControlledDocument,
  DocumentAction,
  DocumentCode,
  DocumentRevision,
  DocumentStatus,
  DocumentType,
  ExternalAudit,
  ExternalAuditAction,
  ExternalAuditState,
  ExternalAuditType,
  FindingType,
  Incident,
  IncidentOutcome,
  IncidentPersonCategory,
  IncidentType,
  InternalAudit,
  InternalAuditAction,
  InternalAuditState,
  IsoAction,
  IsoActionAction,
  IsoActionState,
  IsoActionSubject,
  IsoActionSubjectType,
  IsoFileSubject,
  IsoFileSubjectType,
  IsoReviewInputDef,
  IsoReviewOutputDef,
  LifeCycleStage,
  ManagementReview,
  ManagementReviewAction,
  ManagementReviewState,
  ManagementSystemStatus,
  NcAction,
  NcBackTo,
  NcDisposition,
  NcSeverity,
  NcSource,
  NcState,
  Nonconformity,
  Objective,
  ObjectiveDirection,
  ObjectiveOutcome,
  OperatingCondition,
  PersonsExposed,
  ReviewInput,
  ReviewInputKey,
  ReviewInputSource,
  ReviewOutput,
  ReviewOutputKey,
  RevisionAction,
  RiskItem,
  RiskKind,
  RiskScale,
  StandardList,
} from '../schemas/iso.js';
import {
  AuditProgrammeCoverage,
  CertificationCycle,
  CertificationReadiness,
  ClauseReadiness,
  ClimateGap,
  IdCount,
  IncidentCounts,
  IsoDueStatus,
  ManagementReviewDue,
  NonconformityStatus,
  ObjectiveProgress,
  ReviewInputFigures,
} from '../schemas/iso-results.js';
import { MAX_EVIDENCE_BYTES } from '../schemas/work.js';
import {
  asOfQueryShape,
  checkHasChanges,
  csv,
  pageQueryShape,
  PersonRef,
  QueryBoolean,
  Reason,
  SearchText,
  versionField,
} from './common.js';
import { EvidenceUploadUrlBody } from './workflow.js';

/**
 * M16 · The ISO add-on's request bodies, list queries and views (docs/contracts/endpoints.md §10, docs/iso/model.md
 * §10). Every route is under `/clients/{clientId}/iso/...`, needs the account's `isoManagement` feature, and answers
 * `409 FEATURE_NOT_READY` until the account's catalogue copy is recorded.
 */

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
const ids = (max: number) => z.array(Id).max(max).refine(unique, { message: 'Ids repeat' });
const Note = LongText.max(4000);

function issue(ctx: z.core.$RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: 'custom', path: [path], message });
}

/** A field a body may set, or clear with null. */
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

/** Filters most ISO lists take. AP and OW see only their units and the records that name them (plan §3.3). */
const isoListShape = {
  ...pageQueryShape,
  managementSystemId: csv(Id).optional(),
  q: SearchText.optional(),
};

/** `?from=&to=` on a date field: each range runs forwards. */
function checkRange(q: { from?: string; to?: string }, ctx: z.core.$RefinementCtx): void {
  if (q.from !== undefined && q.to !== undefined && q.to < q.from)
    issue(ctx, 'to', 'to is before from');
}

/**
 * A change audited as a reassignment (REASSIGN) or a due-date change (DUE_DATE_CHANGE) needs a reason, recorded on the
 * audit event; one rule for every ISO record (README decision 51 p).
 */
function reasonWith(
  fields: readonly string[],
): (body: Record<string, unknown>, ctx: z.core.$RefinementCtx) => void {
  return (body, ctx) => {
    if (fields.some((f) => body[f] !== undefined) && body.reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `A change of ${fields.join(' or ')} needs a reason`,
      });
    }
  };
}

/** Only an update that changes something besides `version` and `reason`. */
function hasChanges(body: object, ctx: z.core.$RefinementCtx): void {
  if (Object.keys(body).every((key) => key === 'version' || key === 'reason')) {
    ctx.addIssue({ code: 'custom', message: 'Nothing to update' });
  }
}

const VersionBody = z.strictObject({ ...versionField });
const ReasonBody = z.strictObject({ ...versionField, reason: Reason });

// ---------- catalogue ----------

export const IsoClauseQuery = z.strictObject({
  standardId: csv(Id).optional(),
  assessable: QueryBoolean.optional(),
});

export const IsoReviewDefQuery = z.strictObject({ standardId: csv(Id).optional() });

/** The account's review input and output definitions. */
export const IsoReviewDefs = z.strictObject({
  inputs: z.array(IsoReviewInputDef),
  outputs: z.array(IsoReviewOutputDef),
});
export type IsoReviewDefs = z.infer<typeof IsoReviewDefs>;

// ---------- management systems and context ----------

export const ManagementSystemQuery = z.strictObject({
  ...pageQueryShape,
  status: csv(ManagementSystemStatus).optional(),
  q: SearchText.optional(),
});

/**
 * A new system: one edition per standard, from the account's catalogue. Its checklist rows are created with it, one per
 * assessable clause. An empty `unitIds` means the units are not chosen yet.
 */
export const ManagementSystemCreateBody = z.strictObject({
  name: Name,
  standardIds: z.array(Id).min(1).max(3).refine(unique, { message: 'Standards repeat' }),
  scopeStatement: LongText.max(8000).nullable().default(null),
  unitIds: ids(500).default([]),
  status: ManagementSystemStatus.default('PLANNING'),
  reviewIntervalMonths: z.int().min(1).max(36).default(12),
});
export type ManagementSystemCreateBody = z.input<typeof ManagementSystemCreateBody>;

/**
 * `standardIds` may only grow: an added standard gets its checklist rows; dropping one is 400 VALIDATION. The climate
 * decision has its own route.
 */
export const ManagementSystemUpdateBody = z
  .strictObject({
    ...versionField,
    name: Name.optional(),
    standardIds: z
      .array(Id)
      .min(1)
      .max(3)
      .refine(unique, { message: 'Standards repeat' })
      .optional(),
    scopeStatement: nullable(LongText.max(8000)),
    unitIds: ids(500).optional(),
    status: ManagementSystemStatus.optional(),
    reviewIntervalMonths: z.int().min(1).max(36).optional(),
  })
  .superRefine(checkHasChanges);
export type ManagementSystemUpdateBody = z.input<typeof ManagementSystemUpdateBody>;

/** The Amd 1:2024 climate decision for the system. Once made it can change, never return to undecided. Audited. */
export const ClimateDecisionBody = z.strictObject({
  ...versionField,
  climateChangeRelevant: z.boolean(),
  climateChangeRationale: LongText.max(4000),
  climateDecidedOn: LocalDate,
});
export type ClimateDecisionBody = z.input<typeof ClimateDecisionBody>;

export const ContextItemQuery = z.strictObject({
  kind: csv(ContextItemKind).optional(),
  climateRelated: QueryBoolean.optional(),
  includeArchived: QueryBoolean.optional(),
});

export const ContextItemCreateBody = z
  .strictObject({
    kind: ContextItemKind,
    text: LongText.max(2000),
    needs: LongText.max(4000).nullable().default(null),
    climateRelated: z.boolean().default(false),
    reviewedOn: LocalDate.nullable().default(null),
  })
  .refine((c) => c.kind === 'INTERESTED_PARTY' || c.needs === null, {
    path: ['needs'],
    message: 'Only an interested party has needs',
  });
export type ContextItemCreateBody = z.input<typeof ContextItemCreateBody>;

export const ContextItemUpdateBody = z
  .strictObject({
    ...versionField,
    text: LongText.max(2000).optional(),
    needs: nullable(LongText.max(4000)),
    climateRelated: z.boolean().optional(),
    reviewedOn: nullable(LocalDate),
  })
  .superRefine(checkHasChanges);
export type ContextItemUpdateBody = z.input<typeof ContextItemUpdateBody>;

// ---------- clause checklist ----------

export const ChecklistQuery = z.strictObject({
  standardId: csv(Id).optional(),
  status: csv(ClauseStatus).optional(),
  naState: csv(ClauseNaState).optional(),
  ownerId: PersonRef.optional(),
});

/** A checklist row with its clause, for sorting and display, and what the signed-in person may do with its N/A. */
export const ClauseAssessmentView = ClauseAssessment.safeExtend({
  standardId: Id,
  clauseNumber: z.string().min(1),
  clauseTitle: Text.max(200),
  exclusionAllowed: z.boolean(),
  allowedActions: z.array(ClauseNaAction),
});
export type ClauseAssessmentView = z.infer<typeof ClauseAssessmentView>;

/**
 * A row's own work. `status` never takes NOT_APPLICABLE (that goes through REQUEST_NA) and is refused while N/A is
 * REQUESTED or APPROVED; clause 4.1 cannot be IMPLEMENTED before the system's climate decision (400 VALIDATION). A new
 * owner needs a reason.
 */
export const ClauseAssessmentUpdateBody = z
  .strictObject({
    ...versionField,
    status: ClauseWorkStatus.optional(),
    ownerId: nullable(Id),
    notes: nullable(Note),
    lastReviewedOn: nullable(LocalDate),
    reason: Reason.optional(),
  })
  .superRefine(hasChanges)
  .superRefine(reasonWith(['ownerId']));
export type ClauseAssessmentUpdateBody = z.input<typeof ClauseAssessmentUpdateBody>;

/** REQUEST_NA: only on a clause with `exclusionAllowed`. `reason` is stored as the row's justification. */
export const ClauseNaRequestBody = ReasonBody;
/** APPROVE_NA: an approver or client admin other than the requester. */
export const ClauseNaApproveBody = z.strictObject({
  ...versionField,
  comment: LongText.max(2000).optional(),
});
export const ClauseNaRejectBody = ReasonBody;
/** WITHDRAW_NA: the clause applies again; the row returns to NOT_STARTED. */
export const ClauseNaWithdrawBody = ReasonBody;

// ---------- documents ----------

export const DocumentQuery = z.strictObject({
  ...isoListShape,
  type: csv(DocumentType).optional(),
  /** Default: ACTIVE only (obsolete documents stay out of default lists). */
  status: csv(DocumentStatus).optional(),
  ownerId: PersonRef.optional(),
  approverId: PersonRef.optional(),
  clauseId: csv(Id).optional(),
});

function checkDocumentTypeFields(
  d: { type?: string; retention?: unknown; issuer?: unknown; externalRef?: unknown },
  ctx: z.core.$RefinementCtx,
): void {
  if (d.type === undefined) return;
  const set = (v: unknown) => v !== undefined && v !== null;
  if (d.type !== 'FORM' && set(d.retention)) issue(ctx, 'retention', 'Only a FORM has retention');
  if (d.type !== 'EXTERNAL' && (set(d.issuer) || set(d.externalRef))) {
    issue(ctx, 'issuer', 'Only an EXTERNAL document has an issuer and external reference');
  }
}

export const DocumentCreateBody = z
  .strictObject({
    managementSystemId: Id,
    code: DocumentCode,
    title: Text.max(300),
    type: DocumentType,
    clauseIds: ids(50).default([]),
    ownerId: Id,
    approverId: Id,
    reviewDueOn: LocalDate.nullable().default(null),
    retention: LongText.max(2000).nullable().default(null),
    issuer: Name.nullable().default(null),
    externalRef: Text.max(200).nullable().default(null),
  })
  .superRefine(checkDocumentTypeFields);
export type DocumentCreateBody = z.input<typeof DocumentCreateBody>;

/**
 * The document's own fields stay editable while it is ACTIVE. `code` and `type` do not change. A new owner or approver,
 * or a moved `reviewDueOn`, needs a reason.
 */
export const DocumentUpdateBody = z
  .strictObject({
    ...versionField,
    title: Text.max(300).optional(),
    clauseIds: ids(50).optional(),
    ownerId: Id.optional(),
    approverId: Id.optional(),
    reviewDueOn: nullable(LocalDate),
    retention: nullable(LongText.max(2000)),
    issuer: nullable(Name),
    externalRef: nullable(Text.max(200)),
    reason: Reason.optional(),
  })
  .superRefine(hasChanges)
  .superRefine(reasonWith(['ownerId', 'approverId', 'reviewDueOn']));
export type DocumentUpdateBody = z.input<typeof DocumentUpdateBody>;

/** REVIEW: the approver confirms the current revision still fits; sets `lastReviewedOn` and the next review date. */
export const DocumentReviewBody = z.strictObject({
  ...versionField,
  note: LongText.max(2000),
  nextReviewDueOn: LocalDate,
});
export type DocumentReviewBody = z.input<typeof DocumentReviewBody>;

export const DocumentObsoleteBody = ReasonBody;

/** A document with its current revision label, review timing, open revision and the actions on offer. */
export const DocumentView = ControlledDocument.safeExtend({
  currentRevision: Text.max(20).nullable(),
  /** The revision in DRAFT or IN_REVIEW, if any (there is at most one). */
  openRevisionId: Id.nullable(),
  reviewStatus: IsoDueStatus,
  allowedActions: z.array(z.union([DocumentAction, z.literal('DRAFT_REVISION')])),
});
export type DocumentView = z.infer<typeof DocumentView>;

/** DRAFT_REVISION: no other revision of the document may be in DRAFT or IN_REVIEW. */
export const RevisionCreateBody = z.strictObject({
  revision: Text.max(20),
  changeNote: LongText.max(2000).nullable().default(null),
});
export type RevisionCreateBody = z.input<typeof RevisionCreateBody>;

/** Only while DRAFT. */
export const RevisionUpdateBody = z
  .strictObject({
    ...versionField,
    revision: Text.max(20).optional(),
    changeNote: nullable(LongText.max(2000)),
  })
  .superRefine(checkHasChanges);
export type RevisionUpdateBody = z.input<typeof RevisionUpdateBody>;

/** SUBMIT (not EXTERNAL): needs a change note and exactly one live CLEAN file on the revision. */
export const RevisionSubmitBody = VersionBody;
export const RevisionApproveBody = z.strictObject({
  ...versionField,
  comment: LongText.max(2000).optional(),
});
export const RevisionSendBackBody = ReasonBody;
/** RECORD_EDITION (EXTERNAL only): the document's issuer and external reference set, one live CLEAN file. */
export const RevisionRecordEditionBody = VersionBody;

export const RevisionView = DocumentRevision.safeExtend({
  allowedActions: z.array(RevisionAction.exclude(['DRAFT_REVISION'])),
});
export type RevisionView = z.infer<typeof RevisionView>;

// ---------- risk register ----------

export const RiskQuery = z.strictObject({
  ...isoListShape,
  unitId: csv(Id).optional(),
  kind: csv(RiskKind).optional(),
  significant: QueryBoolean.optional(),
  climateRelated: QueryBoolean.optional(),
  ownerId: PersonRef.optional(),
  includeArchived: QueryBoolean.optional(),
});

interface RiskKindFields {
  kind: string;
  impact?: string | null;
  lifeCycleStages?: readonly string[];
  controlType?: string | null;
  routine?: boolean | null;
  personsExposed?: readonly string[];
  condition?: string | null;
}

/** The kind rules of model §3.5, on a body with its defaults applied. */
function checkRiskKindFields(r: RiskKindFields, ctx: z.core.$RefinementCtx): void {
  const aspect = r.kind === 'ASPECT';
  const hazard = r.kind === 'HAZARD';
  const set = (v: unknown) => v !== undefined && v !== null;
  if ((aspect || hazard) && !set(r.impact)) issue(ctx, 'impact', `A ${r.kind} has an impact`);
  if (aspect !== (r.lifeCycleStages ?? []).length > 0) {
    issue(ctx, 'lifeCycleStages', 'An ASPECT has at least one life-cycle stage, other kinds none');
  }
  if (aspect !== set(r.controlType))
    issue(ctx, 'controlType', 'controlType is set exactly for an ASPECT');
  if (hazard !== set(r.routine)) issue(ctx, 'routine', 'routine is set exactly for a HAZARD');
  if (hazard !== (r.personsExposed ?? []).length > 0) {
    issue(ctx, 'personsExposed', 'A HAZARD has at least one exposed group, other kinds none');
  }
  if (aspect || hazard ? !set(r.condition) : set(r.condition)) {
    issue(ctx, 'condition', 'condition is set exactly for an ASPECT or HAZARD');
  }
}

function checkResidual(
  r: { residualLikelihood?: number | null; residualSeverity?: number | null },
  ctx: z.core.$RefinementCtx,
): void {
  if (((r.residualLikelihood ?? null) === null) !== ((r.residualSeverity ?? null) === null)) {
    issue(ctx, 'residualSeverity', 'Residual likelihood and severity are set together');
  }
}

/** A new item; the API stores the engine's `rating`, `residualRating` and `significant` with it. */
export const RiskItemCreateBody = z
  .strictObject({
    managementSystemId: Id,
    kind: RiskKind,
    unitId: Id.nullable().default(null),
    activity: Text.max(300),
    description: LongText.max(4000),
    impact: LongText.max(2000).nullable().default(null),
    lifeCycleStages: z
      .array(LifeCycleStage)
      .refine(unique, { message: 'Stages repeat' })
      .default([]),
    controlType: AspectControlType.nullable().default(null),
    routine: z.boolean().nullable().default(null),
    personsExposed: z
      .array(PersonsExposed)
      .refine(unique, { message: 'Groups repeat' })
      .default([]),
    condition: OperatingCondition.nullable().default(null),
    assessedWith: LongText.max(2000).nullable().default(null),
    likelihood: RiskScale,
    severity: RiskScale,
    residualLikelihood: RiskScale.nullable().default(null),
    residualSeverity: RiskScale.nullable().default(null),
    obligationIds: ids(50).default([]),
    climateRelated: z.boolean().default(false),
    ownerId: Id,
    reviewDueOn: LocalDate.nullable().default(null),
  })
  .superRefine(checkRiskKindFields)
  .superRefine(checkResidual);
export type RiskItemCreateBody = z.input<typeof RiskItemCreateBody>;

/**
 * `kind` does not change; the merged item must still meet the kind rules (400 VALIDATION). Re-rating is audited. A new
 * owner or a moved `reviewDueOn` needs a reason.
 */
export const RiskItemUpdateBody = z
  .strictObject({
    ...versionField,
    unitId: nullable(Id),
    activity: Text.max(300).optional(),
    description: LongText.max(4000).optional(),
    impact: nullable(LongText.max(2000)),
    lifeCycleStages: z
      .array(LifeCycleStage)
      .refine(unique, { message: 'Stages repeat' })
      .optional(),
    controlType: nullable(AspectControlType),
    routine: nullable(z.boolean()),
    personsExposed: z.array(PersonsExposed).refine(unique, { message: 'Groups repeat' }).optional(),
    condition: nullable(OperatingCondition),
    assessedWith: nullable(LongText.max(2000)),
    likelihood: RiskScale.optional(),
    severity: RiskScale.optional(),
    residualLikelihood: nullable(RiskScale),
    residualSeverity: nullable(RiskScale),
    obligationIds: ids(50).optional(),
    climateRelated: z.boolean().optional(),
    ownerId: Id.optional(),
    reviewDueOn: nullable(LocalDate),
    reason: Reason.optional(),
  })
  .superRefine(hasChanges)
  .superRefine(reasonWith(['ownerId', 'reviewDueOn']));
export type RiskItemUpdateBody = z.input<typeof RiskItemUpdateBody>;

/** REVIEW: the item still stands as rated; sets `lastReviewedOn` and the next review date, nothing else. */
export const RiskReviewBody = z.strictObject({
  ...versionField,
  nextReviewDueOn: LocalDate,
  note: LongText.max(2000).optional(),
});
export type RiskReviewBody = z.input<typeof RiskReviewBody>;

/** Sets (true or false) or clears (null) the significance override. Both are audited with the reason. */
export const RiskSignificanceBody = z.strictObject({
  ...versionField,
  significantOverride: z.boolean().nullable(),
  reason: Reason,
});
export type RiskSignificanceBody = z.input<typeof RiskSignificanceBody>;

/** A control in place. `hierarchy` is required on a HAZARD item (400 VALIDATION). */
export const RiskControlCreateBody = z.strictObject({
  text: LongText.max(2000),
  hierarchy: ControlHierarchy.nullable().default(null),
});
export type RiskControlCreateBody = z.input<typeof RiskControlCreateBody>;

export const RiskControlUpdateBody = z
  .strictObject({
    ...versionField,
    text: LongText.max(2000).optional(),
    hierarchy: nullable(ControlHierarchy),
  })
  .superRefine(checkHasChanges);
export type RiskControlUpdateBody = z.input<typeof RiskControlUpdateBody>;

export const RiskItemView = RiskItem.safeExtend({ reviewStatus: IsoDueStatus });
export type RiskItemView = z.infer<typeof RiskItemView>;

// ---------- objectives ----------

export const ObjectiveQuery = z.strictObject({
  ...isoListShape,
  standard: csv(IsoStandardCode).optional(),
  ownerId: PersonRef.optional(),
  /** true: without `closedOn`; false: closed. */
  open: QueryBoolean.optional(),
});

export const ObjectiveCreateBody = z.strictObject({
  managementSystemId: Id,
  standards: StandardList,
  text: Text.max(1000),
  target: z.number().finite(),
  unitOfMeasure: Text.max(50),
  baseline: z.number().finite().nullable().default(null),
  direction: ObjectiveDirection,
  readingRule: RecurrenceRule,
  riskItemIds: ids(100).default([]),
  ownerId: Id,
  dueOn: LocalDate,
});
export type ObjectiveCreateBody = z.input<typeof ObjectiveCreateBody>;

/** A new owner or a moved `dueOn` needs a reason. */
export const ObjectiveUpdateBody = z
  .strictObject({
    ...versionField,
    standards: StandardList.optional(),
    text: Text.max(1000).optional(),
    target: z.number().finite().optional(),
    unitOfMeasure: Text.max(50).optional(),
    baseline: nullable(z.number().finite()),
    direction: ObjectiveDirection.optional(),
    readingRule: RecurrenceRule.optional(),
    riskItemIds: ids(100).optional(),
    ownerId: Id.optional(),
    dueOn: LocalDate.optional(),
    reason: Reason.optional(),
  })
  .superRefine(hasChanges)
  .superRefine(reasonWith(['ownerId', 'dueOn']));
export type ObjectiveUpdateBody = z.input<typeof ObjectiveUpdateBody>;

/** Closing ends the objective with its outcome; readings and actions stop. */
export const ObjectiveCloseBody = z.strictObject({
  ...versionField,
  closedOn: LocalDate,
  outcome: ObjectiveOutcome,
});
export type ObjectiveCloseBody = z.input<typeof ObjectiveCloseBody>;

export const ReadingCreateBody = z
  .strictObject({
    periodStart: LocalDate,
    periodEnd: LocalDate,
    value: z.number().finite(),
    note: LongText.max(2000).nullable().default(null),
  })
  .refine((r) => r.periodEnd >= r.periodStart, {
    path: ['periodEnd'],
    message: 'periodEnd must not be before periodStart',
  });
export type ReadingCreateBody = z.input<typeof ReadingCreateBody>;

export const ReadingUpdateBody = z
  .strictObject({
    ...versionField,
    value: z.number().finite().optional(),
    note: nullable(LongText.max(2000)),
  })
  .superRefine(checkHasChanges);
export type ReadingUpdateBody = z.input<typeof ReadingUpdateBody>;

export const ObjectiveView = Objective.safeExtend({ progress: ObjectiveProgress });
export type ObjectiveView = z.infer<typeof ObjectiveView>;

// ---------- audit programmes and internal audits ----------

export const AuditProgrammeQuery = z.strictObject({
  ...pageQueryShape,
  managementSystemId: csv(Id).optional(),
  fy: FyLabel.optional(),
});

export const AuditProgrammeCreateBody = z.strictObject({
  managementSystemId: Id,
  fy: FyLabel,
  notes: Note.nullable().default(null),
});
export type AuditProgrammeCreateBody = z.input<typeof AuditProgrammeCreateBody>;

export const AuditProgrammeUpdateBody = z.strictObject({ ...versionField, notes: Note.nullable() });
export type AuditProgrammeUpdateBody = z.input<typeof AuditProgrammeUpdateBody>;

/** A programme with its coverage (M4 `auditProgrammeCoverage`), the "audit programme progress" KPI. */
export const AuditProgrammeView = AuditProgramme.safeExtend({ coverage: AuditProgrammeCoverage });
export type AuditProgrammeView = z.infer<typeof AuditProgrammeView>;

export const InternalAuditQuery = z
  .strictObject({
    ...isoListShape,
    programmeId: csv(Id).optional(),
    state: csv(InternalAuditState).optional(),
    unitId: csv(Id).optional(),
    leadAuditorId: PersonRef.optional(),
    /** On `plannedStart`. */
    from: LocalDate.optional(),
    to: LocalDate.optional(),
  })
  .superRefine(checkRange);

function checkAuditTeam(
  a: {
    plannedStart?: string;
    plannedEnd?: string;
    leadAuditorId?: string;
    auditorIds?: readonly string[];
    auditeeIds?: readonly string[];
    independenceNote?: string | null;
  },
  ctx: z.core.$RefinementCtx,
): void {
  if (a.plannedStart !== undefined && a.plannedEnd !== undefined && a.plannedEnd < a.plannedStart) {
    issue(ctx, 'plannedEnd', 'The audit ends after it starts');
  }
  if (a.leadAuditorId !== undefined && (a.auditorIds ?? []).includes(a.leadAuditorId)) {
    issue(ctx, 'auditorIds', 'The lead auditor is not listed again');
  }
  const team = [a.leadAuditorId, ...(a.auditorIds ?? [])].filter((id) => id !== undefined);
  if (
    team.some((id) => (a.auditeeIds ?? []).includes(id)) &&
    (a.independenceNote ?? null) === null
  ) {
    issue(ctx, 'independenceNote', 'An auditor who is also an auditee needs an independence note');
  }
}

/** Auditors are people named on the audit with the owner role or above in the client. */
export const InternalAuditCreateBody = z
  .strictObject({
    programmeId: Id,
    title: Text.max(300),
    plannedStart: LocalDate,
    plannedEnd: LocalDate,
    clauseIds: ids(300).default([]),
    unitIds: ids(500).default([]),
    leadAuditorId: Id,
    auditorIds: ids(20).default([]),
    auditeeIds: ids(100).default([]),
    reportedToIds: ids(20).default([]),
    independenceNote: LongText.max(2000).nullable().default(null),
  })
  .superRefine(checkAuditTeam);
export type InternalAuditCreateBody = z.input<typeof InternalAuditCreateBody>;

/** Only while PLANNED or IN_PROGRESS. Moving `plannedStart` or `plannedEnd`, or a new lead auditor, needs a reason. */
export const InternalAuditUpdateBody = z
  .strictObject({
    ...versionField,
    title: Text.max(300).optional(),
    plannedStart: LocalDate.optional(),
    plannedEnd: LocalDate.optional(),
    clauseIds: ids(300).optional(),
    unitIds: ids(500).optional(),
    leadAuditorId: Id.optional(),
    auditorIds: ids(20).optional(),
    auditeeIds: ids(100).optional(),
    reportedToIds: ids(20).optional(),
    independenceNote: nullable(LongText.max(2000)),
    reason: Reason.optional(),
  })
  .superRefine(hasChanges)
  .superRefine(reasonWith(['plannedStart', 'plannedEnd', 'leadAuditorId']));
export type InternalAuditUpdateBody = z.input<typeof InternalAuditUpdateBody>;

export const InternalAuditStartBody = VersionBody;
/**
 * REPORT: a summary, at least one person reported to, and a checklist row with a result for every clause of the audit.
 * `reportedOn` defaults to today and may not be after it.
 */
export const InternalAuditReportBody = z.strictObject({
  ...versionField,
  summary: LongText.max(8000),
  reportedOn: LocalDate.optional(),
  reportedToIds: ids(20).optional(),
});
export type InternalAuditReportBody = z.input<typeof InternalAuditReportBody>;
/** CLOSE: every nonconformity its findings raised has left OPEN. */
export const InternalAuditCloseBody = VersionBody;
export const InternalAuditCancelBody = ReasonBody;

export const InternalAuditView = InternalAudit.safeExtend({
  managementSystemId: Id,
  allowedActions: z.array(InternalAuditAction),
});
export type InternalAuditView = z.infer<typeof InternalAuditView>;

export const ChecklistItemCreateBody = z.strictObject({
  clauseId: Id,
  unitId: Id.nullable().default(null),
  question: LongText.max(2000),
});
export type ChecklistItemCreateBody = z.input<typeof ChecklistItemCreateBody>;

/** A FINDING result links the finding (create it with `checklistItemId` to do both at once). */
export const ChecklistItemUpdateBody = z
  .strictObject({
    ...versionField,
    question: LongText.max(2000).optional(),
    unitId: nullable(Id),
    auditorNote: nullable(Note),
    result: nullable(ChecklistResult),
    findingId: nullable(Id),
    notAuditedReason: nullable(LongText.max(2000)),
  })
  .superRefine(checkHasChanges)
  .superRefine((c, ctx) => {
    if (c.result === 'FINDING' && (c.findingId ?? null) === null) {
      issue(ctx, 'findingId', 'A FINDING row links its finding');
    }
    if (c.result === 'NOT_AUDITED' && (c.notAuditedReason ?? null) === null) {
      issue(ctx, 'notAuditedReason', 'A NOT_AUDITED row has a reason');
    }
  });
export type ChecklistItemUpdateBody = z.input<typeof ChecklistItemUpdateBody>;

/**
 * What the nonconformity a MAJOR_NC or MINOR_NC finding raises needs beyond the finding: its owner, approver and due
 * date. Its source, severity, clauses, unit and standards come from the finding and its audit.
 */
export const FindingNcBody = z
  .strictObject({ ownerId: Id, approverId: Id, dueOn: LocalDate })
  .refine((n) => n.ownerId !== n.approverId, {
    path: ['approverId'],
    message: 'The approver is not the owner',
  });

const findingFields = {
  type: FindingType,
  clauseIds: ids(20).default([]),
  unitId: Id.nullable().default(null),
  description: LongText.max(4000),
  /** Required for MAJOR_NC and MINOR_NC, refused otherwise. */
  nonconformity: FindingNcBody.optional(),
};

function checkFindingNc(
  f: { type: FindingType; nonconformity?: unknown },
  ctx: z.core.$RefinementCtx,
): void {
  const nc = f.type === 'MAJOR_NC' || f.type === 'MINOR_NC';
  if (nc !== (f.nonconformity !== undefined)) {
    issue(
      ctx,
      'nonconformity',
      'A MAJOR_NC or MINOR_NC finding raises a nonconformity, other types none',
    );
  }
}

/** A finding of an internal audit (IN_PROGRESS); `checklistItemId` also marks that row FINDING. */
export const InternalFindingCreateBody = z
  .strictObject({ ...findingFields, checklistItemId: Id.optional() })
  .superRefine(checkFindingNc);
export type InternalFindingCreateBody = z.input<typeof InternalFindingCreateBody>;

/** A finding of an external audit (HELD). */
export const ExternalFindingCreateBody = z.strictObject(findingFields).superRefine(checkFindingNc);
export type ExternalFindingCreateBody = z.input<typeof ExternalFindingCreateBody>;

/**
 * `type` moves only among OBSERVATION, OFI and GOOD_PRACTICE, or between MAJOR_NC and MINOR_NC (the nonconformity's
 * severity follows); any other change is 400 VALIDATION (cancel the nonconformity instead).
 */
export const FindingUpdateBody = z
  .strictObject({
    ...versionField,
    type: FindingType.optional(),
    clauseIds: ids(20).optional(),
    unitId: nullable(Id),
    description: LongText.max(4000).optional(),
  })
  .superRefine(checkHasChanges);
export type FindingUpdateBody = z.input<typeof FindingUpdateBody>;

// ---------- certification and external audits ----------

export const CertificationQuery = z.strictObject({
  ...pageQueryShape,
  managementSystemId: csv(Id).optional(),
  standardId: csv(Id).optional(),
});

function checkIssued(
  c: { issuedOn?: string | null; expiresOn?: string | null; certificateNumber?: string | null },
  ctx: z.core.$RefinementCtx,
): void {
  const issued = (c.issuedOn ?? null) !== null;
  if (issued !== ((c.expiresOn ?? null) !== null)) {
    issue(ctx, 'expiresOn', 'issuedOn and expiresOn are set together');
  }
  if (issued !== ((c.certificateNumber ?? null) !== null)) {
    issue(ctx, 'certificateNumber', 'An issued certificate has a number, and only an issued one');
  }
  if (issued && c.expiresOn != null && c.expiresOn <= c.issuedOn!) {
    issue(ctx, 'expiresOn', 'expiresOn must be after issuedOn');
  }
}

export const CertificationCreateBody = z
  .strictObject({
    managementSystemId: Id,
    standardId: Id,
    body: Name,
    certificateNumber: Text.max(100).nullable().default(null),
    issuedOn: LocalDate.nullable().default(null),
    expiresOn: LocalDate.nullable().default(null),
    scopeText: LongText.max(4000).nullable().default(null),
    unitIds: ids(500).default([]),
  })
  .superRefine(checkIssued);
export type CertificationCreateBody = z.input<typeof CertificationCreateBody>;

/** Issuing sets `certificateNumber`, `issuedOn` and `expiresOn` together (checked on the merged certificate). */
export const CertificationUpdateBody = z
  .strictObject({
    ...versionField,
    body: Name.optional(),
    certificateNumber: nullable(Text.max(100)),
    issuedOn: nullable(LocalDate),
    expiresOn: nullable(LocalDate),
    scopeText: nullable(LongText.max(4000)),
    unitIds: ids(500).optional(),
  })
  .superRefine(checkHasChanges);
export type CertificationUpdateBody = z.input<typeof CertificationUpdateBody>;

/** A certificate with its surveillance and recertification due dates (M4 `certificationCycle`). */
export const CertificationView = Certification.safeExtend({ cycle: CertificationCycle });
export type CertificationView = z.infer<typeof CertificationView>;

export const ExternalAuditQuery = z
  .strictObject({
    ...pageQueryShape,
    managementSystemId: csv(Id).optional(),
    state: csv(ExternalAuditState).optional(),
    type: csv(ExternalAuditType).optional(),
    /** On `startOn`. */
    from: LocalDate.optional(),
    to: LocalDate.optional(),
  })
  .superRefine(checkRange);

export const ExternalAuditCreateBody = z
  .strictObject({
    managementSystemId: Id,
    standardIds: z.array(Id).min(1).max(3).refine(unique, { message: 'Standards repeat' }),
    type: ExternalAuditType,
    body: Name,
    leadAuditorName: Name.nullable().default(null),
    startOn: LocalDate,
    endOn: LocalDate,
    responseDueOn: LocalDate.nullable().default(null),
  })
  .refine((a) => a.endOn >= a.startOn, {
    path: ['endOn'],
    message: 'The audit ends after it starts',
  });
export type ExternalAuditCreateBody = z.input<typeof ExternalAuditCreateBody>;

/** Until CLOSED or CANCELLED. Moving `responseDueOn` needs a reason. */
export const ExternalAuditUpdateBody = z
  .strictObject({
    ...versionField,
    standardIds: z
      .array(Id)
      .min(1)
      .max(3)
      .refine(unique, { message: 'Standards repeat' })
      .optional(),
    type: ExternalAuditType.optional(),
    body: Name.optional(),
    leadAuditorName: nullable(Name),
    startOn: LocalDate.optional(),
    endOn: LocalDate.optional(),
    recommendation: nullable(AuditRecommendation),
    responseDueOn: nullable(LocalDate),
    reason: Reason.optional(),
  })
  .superRefine(hasChanges)
  .superRefine(reasonWith(['responseDueOn']));
export type ExternalAuditUpdateBody = z.input<typeof ExternalAuditUpdateBody>;

/** RECORD_HELD: the visit's dates, and the body's report as a file on the external audit. */
export const ExternalAuditHeldBody = z
  .strictObject({
    ...versionField,
    startOn: LocalDate,
    endOn: LocalDate,
    recommendation: AuditRecommendation.nullable().default(null),
    responseDueOn: LocalDate.nullable().optional(),
  })
  .refine((a) => a.endOn >= a.startOn, {
    path: ['endOn'],
    message: 'The audit ends after it starts',
  });
export type ExternalAuditHeldBody = z.input<typeof ExternalAuditHeldBody>;
/** RECORD_RESPONSE: every finding with a nonconformity has it past OPEN. */
export const ExternalAuditResponseBody = VersionBody;
/** CLOSE: a recommendation recorded (here or before). */
export const ExternalAuditCloseBody = z.strictObject({
  ...versionField,
  recommendation: AuditRecommendation.optional(),
});
export type ExternalAuditCloseBody = z.input<typeof ExternalAuditCloseBody>;
export const ExternalAuditCancelBody = ReasonBody;

export const ExternalAuditView = ExternalAudit.safeExtend({
  allowedActions: z.array(ExternalAuditAction),
});
export type ExternalAuditView = z.infer<typeof ExternalAuditView>;

// ---------- nonconformities ----------

export const NcQuery = z.strictObject({
  ...isoListShape,
  unitId: csv(Id).optional(),
  state: csv(NcState).optional(),
  source: csv(NcSource).optional(),
  severity: csv(NcSeverity).optional(),
  standard: csv(IsoStandardCode).optional(),
  ownerId: PersonRef.optional(),
  approverId: PersonRef.optional(),
  /** true: only INCIDENT and NEAR_MISS. */
  incident: QueryBoolean.optional(),
  overdue: QueryBoolean.optional(),
});

/** Incident fields as sent: the same rules as stored (model §3.11). No injured person's details: those go in files. */
export const IncidentBody = z
  .strictObject({
    occurredAt: Incident.shape.occurredAt,
    location: Text.max(300),
    type: IncidentType,
    outcome: IncidentOutcome,
    personCategory: IncidentPersonCategory.nullable().default(null),
    lostDays: z.int().min(1).max(10_000).nullable().default(null),
    reportable: z.boolean(),
    statutoryInstanceId: Id.nullable().default(null),
    investigatorIds: ids(20).default([]),
    workerParticipation: z.boolean().default(false),
  })
  .superRefine((i, ctx) => {
    if (i.type === 'NEAR_MISS' && i.outcome !== 'NONE')
      issue(ctx, 'outcome', 'A near miss has outcome NONE');
    if ((i.outcome === 'LOST_TIME') !== (i.lostDays !== null)) {
      issue(ctx, 'lostDays', 'lostDays is set exactly for LOST_TIME');
    }
  });
export type IncidentBody = z.input<typeof IncidentBody>;

/** Sources a person raises by hand; audit sources come only from a MAJOR_NC or MINOR_NC finding. */
export const RaisableNcSource = NcSource.exclude(['INTERNAL_AUDIT', 'EXTERNAL_AUDIT']);

/**
 * RAISE, for a unit the actor can see. Sets `reportedById` (the actor) and `reportedOn` (today). An INCIDENT or
 * NEAR_MISS needs `incident` and a unit.
 */
export const NcRaiseBody = z
  .strictObject({
    managementSystemId: Id,
    source: RaisableNcSource,
    sourceInstanceId: Id.nullable().default(null),
    raisedFromRiskItemId: Id.nullable().default(null),
    severity: NcSeverity,
    standards: StandardList,
    clauseIds: ids(20).default([]),
    unitId: Id.nullable().default(null),
    description: LongText.max(4000),
    containment: Note.nullable().default(null),
    correction: Note.nullable().default(null),
    ownerId: Id,
    approverId: Id,
    dueOn: LocalDate,
    incident: IncidentBody.nullable().default(null),
  })
  .superRefine((n, ctx) => {
    if (n.ownerId === n.approverId) issue(ctx, 'approverId', 'The approver is not the owner');
    const incidentSource = n.source === 'INCIDENT' || n.source === 'NEAR_MISS';
    if (incidentSource !== (n.incident !== null)) {
      issue(ctx, 'incident', 'An INCIDENT or NEAR_MISS has incident fields, other sources none');
    }
    if (incidentSource && n.unitId === null) issue(ctx, 'unitId', 'An incident has a unit');
    if (n.incident !== null && (n.incident.type === 'NEAR_MISS') !== (n.source === 'NEAR_MISS')) {
      issue(ctx, 'incident', 'The incident type is NEAR_MISS exactly when the source is NEAR_MISS');
    }
  });
export type NcRaiseBody = z.input<typeof NcRaiseBody>;

/** The incident fields an update may change (the type follows the source and does not change). */
const IncidentPatch = z
  .strictObject({
    occurredAt: Incident.shape.occurredAt.optional(),
    location: Text.max(300).optional(),
    outcome: IncidentOutcome.optional(),
    personCategory: nullable(IncidentPersonCategory),
    lostDays: nullable(z.int().min(1).max(10_000)),
    reportable: z.boolean().optional(),
    statutoryInstanceId: nullable(Id),
    investigatorIds: ids(20).optional(),
    workerParticipation: z.boolean().optional(),
  })
  .superRefine(checkHasChanges);

/** The investigation fields the owner fills in before or with ADD_ROOT_CAUSE, SUBMIT and SUBMIT_NO_ACTION. */
const ncWorkShape = {
  containment: nullable(Note),
  correction: nullable(Note),
  disposition: nullable(NcDisposition),
  dispositionAuthorisedById: nullable(Id),
  rootCauseMethod: nullable(z.enum(['FIVE_WHYS', 'FISHBONE', 'OTHER'])),
  rootCause: nullable(Note),
  similarOccurrences: nullable(Note),
  relatedRiskItemIds: ids(50).optional(),
  updatedRiskItemIds: ids(50).optional(),
  riskReview: nullable(Note),
  systemChange: nullable(Note),
  changedDocumentIds: ids(50).optional(),
};

/**
 * Investigation field edits until CLOSED or CANCELLED (`isoNc.work`). A disposition and who authorised it are set no
 * later than ADD_ROOT_CAUSE. Owner, approver, dates and severity change through `NcReassignBody`.
 */
export const NcUpdateBody = z
  .strictObject({
    ...versionField,
    description: LongText.max(4000).optional(),
    standards: StandardList.optional(),
    clauseIds: ids(20).optional(),
    unitId: nullable(Id),
    sourceInstanceId: nullable(Id),
    ...ncWorkShape,
    incident: IncidentPatch.optional(),
  })
  .superRefine(hasChanges);
export type NcUpdateBody = z.input<typeof NcUpdateBody>;

/**
 * `isoNc.reassign` (FA, CO, CA), until CLOSED or CANCELLED, always with a reason: a new owner or approver (audited
 * REASSIGN), a moved `dueOn` or `effectivenessDueOn` (DUE_DATE_CHANGE; the effectiveness date moves once PLAN_ACTIONS
 * set it and is never cleared), or a new `severity` (UPDATE), which changes only while OPEN or ROOT_CAUSE_FOUND and
 * never on a nonconformity raised from an audit finding, whose type sets it.
 */
export const NcReassignBody = z
  .strictObject({
    ...versionField,
    ownerId: Id.optional(),
    approverId: Id.optional(),
    dueOn: LocalDate.optional(),
    effectivenessDueOn: LocalDate.optional(),
    severity: NcSeverity.optional(),
    reason: Reason,
  })
  .superRefine(hasChanges);
export type NcReassignBody = z.input<typeof NcReassignBody>;

/**
 * ADD_ROOT_CAUSE: containment, correction, root cause (and method) and similar occurrences, given here or before; an
 * INCIDENT or NEAR_MISS also needs related risk items or a risk review. Fields sent here are saved with the step.
 */
export const NcRootCauseBody = z.strictObject({ ...versionField, ...ncWorkShape });
export type NcRootCauseBody = z.input<typeof NcRootCauseBody>;

/** PLAN_ACTIONS: at least one OPEN action on the nonconformity; sets when effectiveness is checked. */
export const NcPlanActionsBody = z.strictObject({ ...versionField, effectivenessDueOn: LocalDate });
export type NcPlanActionsBody = z.input<typeof NcPlanActionsBody>;

/**
 * SUBMIT_NO_ACTION, for a minor case: refused for MAJOR, EXTERNAL_AUDIT, a LOST_TIME or FATALITY incident, and after a
 * VERIFY_NOT_EFFECTIVE.
 */
export const NcSubmitNoActionBody = z.strictObject({
  ...versionField,
  noActionReason: Note,
  riskReview: Note,
  systemChange: Note,
});
export type NcSubmitNoActionBody = z.input<typeof NcSubmitNoActionBody>;

/** SUBMIT: every action DONE or CANCELLED and at least one DONE; risk review and system change recorded. */
export const NcSubmitBody = z.strictObject({
  ...versionField,
  riskReview: Note.optional(),
  systemChange: Note.optional(),
});
export type NcSubmitBody = z.input<typeof NcSubmitBody>;

/** VERIFY_EFFECTIVE: not before `effectivenessDueOn`; closes the nonconformity. */
export const NcVerifyEffectiveBody = z.strictObject({ ...versionField, effectivenessNote: Note });
export type NcVerifyEffectiveBody = z.input<typeof NcVerifyEffectiveBody>;

function checkBackTo(
  b: { backTo: NcBackTo; effectivenessDueOn?: string },
  ctx: z.core.$RefinementCtx,
): void {
  if ((b.backTo === 'ACTIONS_PLANNED') !== (b.effectivenessDueOn !== undefined)) {
    issue(
      ctx,
      'effectivenessDueOn',
      'Back to ACTIONS_PLANNED needs a new effectivenessDueOn; back to OPEN takes none',
    );
  }
}

/** VERIFY_NOT_EFFECTIVE: back to OPEN (the root cause was wrong) or ACTIONS_PLANNED with a new effectiveness date. */
export const NcVerifyNotEffectiveBody = z
  .strictObject({
    ...versionField,
    reason: Reason,
    backTo: NcBackTo,
    effectivenessDueOn: LocalDate.optional(),
  })
  .superRefine(checkBackTo);
export type NcVerifyNotEffectiveBody = z.input<typeof NcVerifyNotEffectiveBody>;

export const NcCancelBody = ReasonBody;

/** REOPEN a CLOSED nonconformity (client admin). */
export const NcReopenBody = NcVerifyNotEffectiveBody;
export type NcReopenBody = NcVerifyNotEffectiveBody;

/** A nonconformity with its timing, the finding that raised it, and the actions the signed-in person may take. */
export const NonconformityView = Nonconformity.safeExtend({
  status: NonconformityStatus,
  findingId: Id.nullable(),
  allowedActions: z.array(NcAction.exclude(['RAISE'])),
});
export type NonconformityView = z.infer<typeof NonconformityView>;

// ---------- actions ----------

export const IsoActionQuery = z
  .strictObject({
    ...isoListShape,
    subjectType: IsoActionSubjectType.optional(),
    subjectId: Id.optional(),
    ownerId: PersonRef.optional(),
    state: csv(IsoActionState).optional(),
    overdue: QueryBoolean.optional(),
    /** On `dueOn`. */
    from: LocalDate.optional(),
    to: LocalDate.optional(),
  })
  .superRefine(checkRange)
  .refine((q) => q.subjectId === undefined || q.subjectType !== undefined, {
    path: ['subjectType'],
    message: 'subjectId needs subjectType',
  });

function checkActionSubjectFields(
  a: { subject?: { type: string }; controlHierarchy?: unknown; outputKey?: unknown },
  ctx: z.core.$RefinementCtx,
): void {
  const type = a.subject?.type;
  if (type === undefined) return;
  if (type !== 'RISK_ITEM' && a.controlHierarchy != null) {
    issue(ctx, 'controlHierarchy', 'Only an action on a risk item has a control hierarchy');
  }
  if (type !== 'MANAGEMENT_REVIEW' && a.outputKey != null) {
    issue(ctx, 'outputKey', 'Only an action on a management review carries out an output');
  }
}

/**
 * A new action on an open subject. A MAJOR_NC or MINOR_NC finding takes none (its actions go on its nonconformity) and a
 * GOOD_PRACTICE finding none (400 VALIDATION); `controlHierarchy` is required on a HAZARD item.
 */
export const IsoActionCreateBody = z
  .strictObject({
    subject: IsoActionSubject,
    text: LongText.max(2000),
    resources: LongText.max(2000).nullable().default(null),
    ownerId: Id,
    dueOn: LocalDate,
    controlHierarchy: ControlHierarchy.nullable().default(null),
    outputKey: ReviewOutputKey.nullable().default(null),
  })
  .superRefine(checkActionSubjectFields);
export type IsoActionCreateBody = z.input<typeof IsoActionCreateBody>;

/** While OPEN. A change of owner or due date is a reassignment or due-date change and needs a reason. */
export const IsoActionUpdateBody = z
  .strictObject({
    ...versionField,
    text: LongText.max(2000).optional(),
    resources: nullable(LongText.max(2000)),
    ownerId: Id.optional(),
    dueOn: LocalDate.optional(),
    effectivenessNote: nullable(Note),
    controlHierarchy: nullable(ControlHierarchy),
    outputKey: nullable(ReviewOutputKey),
    reason: Reason.optional(),
  })
  .superRefine(hasChanges)
  .superRefine(reasonWith(['ownerId', 'dueOn']));
export type IsoActionUpdateBody = z.input<typeof IsoActionUpdateBody>;

/** COMPLETE: `doneOn` not after today. On a risk item, adds a control from the action and asks for a re-rating. */
export const IsoActionCompleteBody = z.strictObject({
  ...versionField,
  doneOn: LocalDate,
  effectivenessNote: Note.optional(),
});
export type IsoActionCompleteBody = z.input<typeof IsoActionCompleteBody>;
export const IsoActionCancelBody = ReasonBody;
/** REOPEN (client admin): only while the subject is open. */
export const IsoActionReopenBody = ReasonBody;

export const IsoActionView = IsoAction.safeExtend({
  status: IsoDueStatus,
  allowedActions: z.array(IsoActionAction),
});
export type IsoActionView = z.infer<typeof IsoActionView>;

// ---------- management reviews ----------

export const ManagementReviewQuery = z
  .strictObject({
    ...isoListShape,
    state: csv(ManagementReviewState).optional(),
    /** On `plannedOn`. */
    from: LocalDate.optional(),
    to: LocalDate.optional(),
  })
  .superRefine(checkRange);

/** PLAN: its input and output rows are created with it, one per key of its standards. */
export const ManagementReviewPlanBody = z.strictObject({
  managementSystemId: Id,
  standards: StandardList,
  plannedOn: LocalDate,
  chairId: Id,
  attendeeIds: ids(100).default([]),
});
export type ManagementReviewPlanBody = z.input<typeof ManagementReviewPlanBody>;

/** Attendees and minutes until CLOSED or CANCELLED (`isoReview.write`). */
export const ManagementReviewUpdateBody = z
  .strictObject({
    ...versionField,
    attendeeIds: ids(100).optional(),
    minutes: nullable(LongText),
  })
  .superRefine(hasChanges);
export type ManagementReviewUpdateBody = z.input<typeof ManagementReviewUpdateBody>;

/**
 * `isoReview.plan` (FA, CO, CA) while PLANNED: its standards (rows of keys no longer wanted are archived, new keys
 * get rows), `plannedOn` (DUE_DATE_CHANGE) and `chairId` (REASSIGN); a new date or chair needs a reason.
 */
export const ManagementReviewReplanBody = z
  .strictObject({
    ...versionField,
    standards: StandardList.optional(),
    plannedOn: LocalDate.optional(),
    chairId: Id.optional(),
    reason: Reason.optional(),
  })
  .superRefine(hasChanges)
  .superRefine(reasonWith(['plannedOn', 'chairId']));
export type ManagementReviewReplanBody = z.input<typeof ManagementReviewReplanBody>;

export const ManagementReviewCancelBody = ReasonBody;
/** RECORD_HELD: `heldOn` not after today, attendees, and notes on every input row. */
export const ManagementReviewHeldBody = z.strictObject({
  ...versionField,
  heldOn: LocalDate,
  attendeeIds: ids(100).optional(),
  minutes: LongText.optional(),
});
export type ManagementReviewHeldBody = z.input<typeof ManagementReviewHeldBody>;
/** CLOSE: a decision on every output row and every review action DONE or CANCELLED. */
export const ManagementReviewCloseBody = VersionBody;

export const ManagementReviewView = ManagementReview.safeExtend({
  allowedActions: z.array(ManagementReviewAction.exclude(['PLAN'])),
});
export type ManagementReviewView = z.infer<typeof ManagementReviewView>;

/** Where an input or output key sits in each standard of the review. */
export const ReviewClauseRef = z.strictObject({
  standard: IsoStandardCode,
  clauseNumber: z.string().min(1),
  item: ClauseItem.nullable(),
});
export type ReviewClauseRef = z.infer<typeof ReviewClauseRef>;

/**
 * One input row with its key, title, clause references and, where its source is not MANUAL, the source's figures since
 * the last held review (M4 `reviewInputFigures`).
 */
export const ReviewInputView = ReviewInput.safeExtend({
  key: ReviewInputKey,
  title: Text.max(300),
  source: ReviewInputSource,
  clauseRefs: z.array(ReviewClauseRef).min(1),
  sourceFigures: ReviewInputFigures.nullable(),
});
export type ReviewInputView = z.infer<typeof ReviewInputView>;

export const ReviewOutputView = ReviewOutput.safeExtend({
  key: ReviewOutputKey,
  title: Text.max(300),
  clauseRefs: z.array(ReviewClauseRef).min(1),
});
export type ReviewOutputView = z.infer<typeof ReviewOutputView>;

/** Until the review is CLOSED or CANCELLED. */
export const ReviewInputUpdateBody = z.strictObject({
  ...versionField,
  notes: LongText.max(8000).nullable(),
});
export type ReviewInputUpdateBody = z.input<typeof ReviewInputUpdateBody>;

export const ReviewOutputUpdateBody = z.strictObject({
  ...versionField,
  decision: LongText.max(8000).nullable(),
});
export type ReviewOutputUpdateBody = z.input<typeof ReviewOutputUpdateBody>;

// ---------- files ----------

/** Same file-type and size rules as evidence (api-conventions.md §6). Only while the subject is open (model §6). */
export const IsoFileUploadUrlBody = EvidenceUploadUrlBody.safeExtend({ subject: IsoFileSubject });
export type IsoFileUploadUrlBody = z.input<typeof IsoFileUploadUrlBody>;

/** Confirms an upload; the file stays PENDING until the virus scan finishes. */
export const IsoFileConfirmBody = z.strictObject({
  subject: IsoFileSubject,
  uploadId: Id,
  fileName: EvidenceUploadUrlBody.shape.fileName,
  sha256: Sha256,
});
export type IsoFileConfirmBody = z.input<typeof IsoFileConfirmBody>;

export const IsoFileQuery = z.strictObject({
  subjectType: IsoFileSubjectType,
  subjectId: Id,
  includeRemoved: QueryBoolean.optional(),
});

export const IsoFileRemoveBody = z.strictObject({ reason: Reason });
export type IsoFileRemoveBody = z.input<typeof IsoFileRemoveBody>;

/** Largest ISO file accepted: the evidence limit. */
export const MAX_ISO_FILE_BYTES = MAX_EVIDENCE_BYTES;

// ---------- overview ----------

export const IsoOverviewQuery = z.strictObject({
  ...asOfQueryShape,
  managementSystemId: csv(Id).optional(),
});

/** One management system's ISO KPIs. Every number carries the ids behind it. */
export const IsoSystemOverview = z.strictObject({
  managementSystemId: Id,
  name: Name,
  standardIds: z.array(Id).min(1),
  clauseReadiness: ClauseReadiness,
  certificationReadiness: CertificationReadiness,
  climateGaps: z.array(ClimateGap),
  nonconformities: z.strictObject({
    open: IdCount,
    overdue: IdCount,
    awaitingVerification: IdCount,
    effectivenessOverdue: IdCount,
  }),
  actions: z.strictObject({ open: IdCount, overdue: IdCount }),
  documents: z.strictObject({ inReview: IdCount, reviewOverdue: IdCount }),
  risks: z.strictObject({ significant: IdCount, reviewOverdue: IdCount }),
  objectives: z.strictObject({ open: IdCount, offTrack: IdCount }),
  /** The programme of the client's current FY; null when there is none. */
  auditProgramme: AuditProgrammeCoverage.nullable(),
  managementReview: ManagementReviewDue,
  /** Issued certificates expiring within 90 days, and cycle dates overdue. */
  certificates: z.strictObject({ expiringSoon: IdCount, cycleOverdue: IdCount }),
  /** Incidents in the client's current FY. */
  incidents: IncidentCounts,
});
export type IsoSystemOverview = z.infer<typeof IsoSystemOverview>;

export const IsoOverview = z.strictObject({
  asOf: LocalDate,
  systems: z.array(IsoSystemOverview),
});
export type IsoOverview = z.infer<typeof IsoOverview>;

// ---------- exports ----------

/** The NC log and risk register take their list's filters; the PDFs name one record. */
export const ISO_EXPORT_FILTERS = {
  ISO_NC_LOG_XLSX: NcQuery.omit({ limit: true, cursor: true, count: true }),
  ISO_RISK_REGISTER_XLSX: RiskQuery.omit({ limit: true, cursor: true, count: true }),
  ISO_AUDIT_REPORT_PDF: z.strictObject({ internalAuditId: Id }),
  ISO_REVIEW_PACK_PDF: z.strictObject({ managementReviewId: Id }),
} as const satisfies Record<IsoExportKind, z.ZodType>;

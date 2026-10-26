import { z } from 'zod';
import { type EntityType, IsoEntityType, IsoStandardCode, ScanStatus } from '../enums.js';
import {
  baseShape,
  ClauseNumber,
  FyLabel,
  Id,
  Instant,
  LocalDate,
  LongText,
  Name,
  Sha256,
  Text,
  versionedShape,
} from '../primitives.js';
import { RecurrenceRule } from './library.js';
import { MAX_EVIDENCE_BYTES } from './work.js';

/**
 * The ISO management systems add-on (docs/iso/model.md §2-4, ADR M16-0002). The catalogue tables are the account's own
 * firm-wide copy, written only by the catalogue copy; every other record holds client data (`firmId` and `clientId`,
 * RLS, an isolation test). No standard's text is stored: clause numbers, titles and summaries in our own words only.
 */

// ---------- enums ----------

export const ManagementSystemStatus = z.enum([
  'PLANNING',
  'IMPLEMENTING',
  'CERTIFIED',
  'SUSPENDED',
  'WITHDRAWN',
]);
export type ManagementSystemStatus = z.infer<typeof ManagementSystemStatus>;

export const ContextItemKind = z.enum(['INTERNAL_ISSUE', 'EXTERNAL_ISSUE', 'INTERESTED_PARTY']);
export type ContextItemKind = z.infer<typeof ContextItemKind>;

/**
 * A checklist row's status. Readiness counts IMPLEMENTED as 1 and PARTIAL as 0.5; an approved NOT_APPLICABLE on a clause
 * that allows exclusion leaves the denominator (M4 `clauseReadiness`).
 */
export const ClauseStatus = z.enum(['NOT_STARTED', 'PARTIAL', 'IMPLEMENTED', 'NOT_APPLICABLE']);
export type ClauseStatus = z.infer<typeof ClauseStatus>;

/** A status a row can return to when its N/A request is rejected or withdrawn. */
export const ClauseWorkStatus = z.enum(['NOT_STARTED', 'PARTIAL', 'IMPLEMENTED']);
export type ClauseWorkStatus = z.infer<typeof ClauseWorkStatus>;

/** Where a clause N/A request stands (model §4.6). */
export const ClauseNaState = z.enum(['NONE', 'REQUESTED', 'APPROVED', 'REJECTED']);
export type ClauseNaState = z.infer<typeof ClauseNaState>;

export const ClauseNaAction = z.enum(['REQUEST_NA', 'APPROVE_NA', 'REJECT_NA', 'WITHDRAW_NA']);
export type ClauseNaAction = z.infer<typeof ClauseNaAction>;

/** No RECORD type: records are the files on ISO records and on activity instances, and are not revised. */
export const DocumentType = z.enum([
  'POLICY',
  'MANUAL',
  'PROCEDURE',
  'WORK_INSTRUCTION',
  'FORM',
  'EXTERNAL',
]);
export type DocumentType = z.infer<typeof DocumentType>;

export const DocumentStatus = z.enum(['ACTIVE', 'OBSOLETE']);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const DocumentAction = z.enum(['REVIEW', 'MAKE_OBSOLETE']);
export type DocumentAction = z.infer<typeof DocumentAction>;

/** A revision's state (model §4.2). The approved revision stays in force while the next is drafted. */
export const RevisionState = z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED']);
export type RevisionState = z.infer<typeof RevisionState>;

export const RevisionAction = z.enum([
  'DRAFT_REVISION',
  'SUBMIT',
  'APPROVE',
  'SEND_BACK',
  'RECORD_EDITION',
]);
export type RevisionAction = z.infer<typeof RevisionAction>;

/** One register, four kinds: 6.1 risks and opportunities, 14001 6.1.2 aspects, 45001 6.1.2 hazards. */
export const RiskKind = z.enum(['RISK', 'OPPORTUNITY', 'ASPECT', 'HAZARD']);
export type RiskKind = z.infer<typeof RiskKind>;

/** Life-cycle stages an environmental aspect is considered at (14001 6.1.2). */
export const LifeCycleStage = z.enum([
  'RAW_MATERIAL',
  'DESIGN',
  'PRODUCTION',
  'TRANSPORT',
  'USE',
  'END_OF_LIFE',
]);
export type LifeCycleStage = z.infer<typeof LifeCycleStage>;

/** Whether the organisation controls an aspect or can only influence it. */
export const AspectControlType = z.enum(['CONTROL', 'INFLUENCE']);
export type AspectControlType = z.infer<typeof AspectControlType>;

export const PersonsExposed = z.enum(['WORKER', 'CONTRACTOR', 'VISITOR', 'PUBLIC']);
export type PersonsExposed = z.infer<typeof PersonsExposed>;

/** Operating condition of an aspect or hazard. */
export const OperatingCondition = z.enum(['NORMAL', 'ABNORMAL', 'EMERGENCY']);
export type OperatingCondition = z.infer<typeof OperatingCondition>;

/** The hierarchy of controls (45001 8.1.2), most effective first. */
export const ControlHierarchy = z.enum([
  'ELIMINATION',
  'SUBSTITUTION',
  'ENGINEERING',
  'ADMINISTRATIVE',
  'PPE',
]);
export type ControlHierarchy = z.infer<typeof ControlHierarchy>;

export const ObjectiveDirection = z.enum(['INCREASE', 'DECREASE', 'MAINTAIN']);
export type ObjectiveDirection = z.infer<typeof ObjectiveDirection>;

export const ObjectiveOutcome = z.enum(['ACHIEVED', 'NOT_ACHIEVED']);
export type ObjectiveOutcome = z.infer<typeof ObjectiveOutcome>;

export const InternalAuditState = z.enum([
  'PLANNED',
  'IN_PROGRESS',
  'REPORTED',
  'CLOSED',
  'CANCELLED',
]);
export type InternalAuditState = z.infer<typeof InternalAuditState>;

export const InternalAuditAction = z.enum(['START', 'CANCEL', 'REPORT', 'CLOSE']);
export type InternalAuditAction = z.infer<typeof InternalAuditAction>;

export const ChecklistResult = z.enum(['CONFORMS', 'FINDING', 'NOT_AUDITED']);
export type ChecklistResult = z.infer<typeof ChecklistResult>;

export const ExternalAuditType = z.enum([
  'STAGE_1',
  'STAGE_2',
  'SURVEILLANCE_1',
  'SURVEILLANCE_2',
  'RECERTIFICATION',
  'SPECIAL',
  'TRANSITION',
]);
export type ExternalAuditType = z.infer<typeof ExternalAuditType>;

export const AuditRecommendation = z.enum([
  'RECOMMENDED',
  'RECOMMENDED_AFTER_CLOSURE',
  'NOT_RECOMMENDED',
]);
export type AuditRecommendation = z.infer<typeof AuditRecommendation>;

export const ExternalAuditState = z.enum(['PLANNED', 'HELD', 'RESPONDED', 'CLOSED', 'CANCELLED']);
export type ExternalAuditState = z.infer<typeof ExternalAuditState>;

export const ExternalAuditAction = z.enum(['RECORD_HELD', 'CANCEL', 'RECORD_RESPONSE', 'CLOSE']);
export type ExternalAuditAction = z.infer<typeof ExternalAuditAction>;

/** Only MAJOR_NC and MINOR_NC raise a nonconformity. */
export const FindingType = z.enum(['MAJOR_NC', 'MINOR_NC', 'OBSERVATION', 'OFI', 'GOOD_PRACTICE']);
export type FindingType = z.infer<typeof FindingType>;

/** Finding types that raise a nonconformity in the same transaction (model §3.9). */
export const NC_FINDING_TYPES = ['MAJOR_NC', 'MINOR_NC'] as const satisfies readonly FindingType[];

export const NcSource = z.enum([
  'INTERNAL_AUDIT',
  'EXTERNAL_AUDIT',
  'INCIDENT',
  'NEAR_MISS',
  'COMPLAINT',
  'PROCESS',
  'LEGAL',
  'OTHER',
]);
export type NcSource = z.infer<typeof NcSource>;

/** Sources that carry incident fields (model §3.11). */
export const INCIDENT_SOURCES = ['INCIDENT', 'NEAR_MISS'] as const satisfies readonly NcSource[];

export const NcSeverity = z.enum(['MAJOR', 'MINOR']);
export type NcSeverity = z.infer<typeof NcSeverity>;

export const RootCauseMethod = z.enum(['FIVE_WHYS', 'FISHBONE', 'OTHER']);
export type RootCauseMethod = z.infer<typeof RootCauseMethod>;

/** What was done with nonconforming outputs (9001 8.7). */
export const NcDisposition = z.enum([
  'CORRECTION',
  'SEGREGATION',
  'RETURN_OR_SUSPENSION',
  'CUSTOMER_INFORMED',
  'CONCESSION',
]);
export type NcDisposition = z.infer<typeof NcDisposition>;

/** Nonconformity states (model §4.1). M4 owns the transition table; M16 enforces it. */
export const NcState = z.enum([
  'OPEN',
  'ROOT_CAUSE_FOUND',
  'ACTIONS_PLANNED',
  'AWAITING_VERIFICATION',
  'CLOSED',
  'CANCELLED',
]);
export type NcState = z.infer<typeof NcState>;

export const NcAction = z.enum([
  'RAISE',
  'ADD_ROOT_CAUSE',
  'PLAN_ACTIONS',
  'SUBMIT_NO_ACTION',
  'SUBMIT',
  'VERIFY_EFFECTIVE',
  'VERIFY_NOT_EFFECTIVE',
  'CANCEL',
  'REOPEN',
]);
export type NcAction = z.infer<typeof NcAction>;

/** Where VERIFY_NOT_EFFECTIVE and REOPEN send a nonconformity. */
export const NcBackTo = z.enum(['OPEN', 'ACTIONS_PLANNED']);
export type NcBackTo = z.infer<typeof NcBackTo>;

export const IncidentType = z.enum([
  'INJURY',
  'ILL_HEALTH',
  'DANGEROUS_OCCURRENCE',
  'ENVIRONMENTAL_RELEASE',
  'FIRE',
  'PROPERTY_DAMAGE',
  'NEAR_MISS',
]);
export type IncidentType = z.infer<typeof IncidentType>;

export const IncidentOutcome = z.enum([
  'NONE',
  'FIRST_AID',
  'MEDICAL_TREATMENT',
  'RESTRICTED_WORK',
  'LOST_TIME',
  'FATALITY',
]);
export type IncidentOutcome = z.infer<typeof IncidentOutcome>;

export const IncidentPersonCategory = z.enum(['EMPLOYEE', 'CONTRACT_WORKER', 'VISITOR', 'PUBLIC']);
export type IncidentPersonCategory = z.infer<typeof IncidentPersonCategory>;

/** Every action is one of these (model §3.12); the UI names it by its subject. */
export const IsoActionSubjectType = z.enum([
  'NONCONFORMITY',
  'RISK_ITEM',
  'OBJECTIVE',
  'AUDIT_FINDING',
  'MANAGEMENT_REVIEW',
]);
export type IsoActionSubjectType = z.infer<typeof IsoActionSubjectType>;

export const IsoActionState = z.enum(['OPEN', 'DONE', 'CANCELLED']);
export type IsoActionState = z.infer<typeof IsoActionState>;

export const IsoActionAction = z.enum(['COMPLETE', 'CANCEL', 'REOPEN']);
export type IsoActionAction = z.infer<typeof IsoActionAction>;

export const ManagementReviewState = z.enum(['PLANNED', 'HELD', 'CLOSED', 'CANCELLED']);
export type ManagementReviewState = z.infer<typeof ManagementReviewState>;

export const ManagementReviewAction = z.enum(['PLAN', 'CANCEL', 'RECORD_HELD', 'CLOSE']);
export type ManagementReviewAction = z.infer<typeof ManagementReviewAction>;

/** Management review inputs as our own keys (docs/iso/catalogue.md §5); one key per input across the standards. */
export const ReviewInputKey = z.enum([
  'PREVIOUS_ACTIONS',
  'CONTEXT_CHANGES',
  'INTERESTED_PARTIES',
  'SIGNIFICANT_ASPECTS',
  'RISKS_AND_OPPORTUNITIES',
  'RISK_ACTIONS',
  'CUSTOMER_SATISFACTION',
  'OBJECTIVES',
  'PROCESS_PERFORMANCE',
  'NONCONFORMITIES',
  'INCIDENTS',
  'MONITORING_RESULTS',
  'COMPLIANCE_EVALUATION',
  'AUDIT_RESULTS',
  'EXTERNAL_PROVIDERS',
  'WORKER_CONSULTATION',
  'RESOURCES',
  'COMMUNICATIONS',
  'IMPROVEMENT_OPPORTUNITIES',
]);
export type ReviewInputKey = z.infer<typeof ReviewInputKey>;

/** Management review outputs as our own keys (docs/iso/catalogue.md §5). */
export const ReviewOutputKey = z.enum([
  'SUITABILITY',
  'IMPROVEMENT',
  'SYSTEM_CHANGES',
  'RESOURCE_NEEDS',
  'OBJECTIVES_NOT_MET',
  'INTEGRATION',
  'STRATEGIC_DIRECTION',
  'WORKER_COMMUNICATION',
]);
export type ReviewOutputKey = z.infer<typeof ReviewOutputKey>;

/** Which records pre-fill a review input (M4 `reviewInputFigures`); `MANUAL` inputs are written by hand. */
export const ReviewInputSource = z.enum([
  'PREVIOUS_ACTIONS',
  'CONTEXT',
  'RISKS',
  'OBJECTIVES',
  'NONCONFORMITIES',
  'INCIDENTS',
  'AUDIT_RESULTS',
  'COMPLIANCE_EVALUATION',
  'MANUAL',
]);
export type ReviewInputSource = z.infer<typeof ReviewInputSource>;

/** The ISO records a file can be attached to (model §6): the `iso_file` subject columns, by entity type. */
export const IsoFileSubjectType = IsoEntityType.extract([
  'clause_assessment',
  'document_revision',
  'risk_item',
  'objective_reading',
  'internal_audit',
  'audit_finding',
  'external_audit',
  'certification',
  'nonconformity',
  'iso_action',
  'management_review',
]);
export type IsoFileSubjectType = z.infer<typeof IsoFileSubjectType>;

// ---------- helpers ----------

/** Fields every ISO client record carries (model §3). */
const isoShape = { ...baseShape, ...versionedShape, clientId: Id };

/** Fields of the records that belong to a management system. */
const systemShape = { ...isoShape, managementSystemId: Id };

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

/** A list of distinct ids, at most `max`. */
const idList = (max: number) => z.array(Id).max(max).refine(unique, { message: 'Ids repeat' });

/** A list of distinct standards, at least one. */
export const StandardList = z
  .array(IsoStandardCode)
  .min(1)
  .max(3)
  .refine(unique, { message: 'Standards repeat' });

/** A rating on the fixed 1-5 scales of the risk matrix. */
export const RiskScale = z.int().min(1).max(5);

/** likelihood × severity: 1 to 25 (M4 `riskRating`). */
export const RiskRating = z.int().min(1).max(25);

/** Free text on ISO records: trimmed, non-empty, at most 4000 characters. */
const Note = LongText.max(4000);

function issue(ctx: z.core.$RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: 'custom', path: [path], message });
}

/** `field` is set exactly when `when` holds. */
function setExactlyWhen(
  ctx: z.core.$RefinementCtx,
  value: unknown,
  when: boolean,
  field: string,
  message: string,
): void {
  if ((value !== null) !== when) issue(ctx, field, message);
}

// ---------- catalogue (the account's copy, firm-wide) ----------

/** e.g. "2015+A1:2024". Editions are data: a revised standard is a new row, not a code change. */
export const IsoEdition = z
  .string()
  .regex(/^\d{4}(\+A\d+:\d{4})*$/, 'Expected an edition such as 2015+A1:2024');

/** One edition of a standard, in the account's copy of the catalogue (docs/iso/catalogue.md §6). */
export const IsoStandard = z.strictObject({
  ...baseShape,
  code: IsoStandardCode,
  edition: IsoEdition,
  /** e.g. "ISO 14001". */
  title: Name,
  /** Our words, e.g. "Environmental management". */
  topic: Name,
});
export type IsoStandard = z.infer<typeof IsoStandard>;

/**
 * A clause of one edition. `summary` is ours, never the standard's text. Only `assessable` clauses get a checklist row
 * and count in readiness; `exclusionAllowed` marks the ISO 9001 clauses a client may have approved as not applicable.
 */
export const IsoClause = z
  .strictObject({
    ...baseShape,
    standardId: Id,
    number: ClauseNumber,
    title: Text.max(200),
    summary: Text.max(1000),
    parentId: Id.nullable(),
    /** The shared-structure clause (4 to 10) the three standards have in common, e.g. "6.1"; null outside it. */
    hlsKey: ClauseNumber.nullable(),
    assessable: z.boolean(),
    exclusionAllowed: z.boolean(),
  })
  .refine((c) => !c.exclusionAllowed || c.assessable, {
    path: ['exclusionAllowed'],
    message: 'Only an assessable clause can be excluded',
  });
export type IsoClause = z.infer<typeof IsoClause>;

/** The item of a clause a review input or output answers, e.g. "c1" in 9.3.2 c1); null when the clause has no items. */
export const ClauseItem = z.string().regex(/^[a-z]\d?$/, 'Expected an item such as c1');

/** One standard's management review input (9.3), under our own key and title. */
export const IsoReviewInputDef = z.strictObject({
  ...baseShape,
  standardId: Id,
  key: ReviewInputKey,
  clauseNumber: ClauseNumber,
  item: ClauseItem.nullable(),
  title: Text.max(300),
  source: ReviewInputSource,
});
export type IsoReviewInputDef = z.infer<typeof IsoReviewInputDef>;

/** One standard's management review output (9.3), under our own key and title. */
export const IsoReviewOutputDef = z.strictObject({
  ...baseShape,
  standardId: Id,
  key: ReviewOutputKey,
  clauseNumber: ClauseNumber,
  item: ClauseItem.nullable(),
  title: Text.max(300),
});
export type IsoReviewOutputDef = z.infer<typeof IsoReviewOutputDef>;

// ---------- management system and context ----------

/**
 * 4.1-4.4: one client's management system, covering one or more standards (one edition each). An empty `unitIds`
 * means the units are not chosen yet; unit scope then treats the system as covering every unit of the client.
 */
export const ManagementSystem = z
  .strictObject({
    ...isoShape,
    name: Name,
    standardIds: z.array(Id).min(1).max(3).refine(unique, { message: 'Standards repeat' }),
    scopeStatement: LongText.max(8000).nullable(),
    unitIds: idList(500),
    status: ManagementSystemStatus,
    /** Months between management reviews (M4 `managementReviewDue`). */
    reviewIntervalMonths: z.int().min(1).max(36),
    /** The Amd 1:2024 climate decision for clause 4.1 of every standard of the system; null = not decided. */
    climateChangeRelevant: z.boolean().nullable(),
    climateChangeRationale: LongText.max(4000).nullable(),
    climateDecidedOn: LocalDate.nullable(),
  })
  .superRefine((m, ctx) => {
    const decided = m.climateChangeRelevant !== null;
    setExactlyWhen(
      ctx,
      m.climateChangeRationale,
      decided,
      'climateChangeRationale',
      'A climate decision has a rationale, and only a decision has one',
    );
    setExactlyWhen(
      ctx,
      m.climateDecidedOn,
      decided,
      'climateDecidedOn',
      'climateDecidedOn is set exactly when the climate decision is',
    );
  });
export type ManagementSystem = z.infer<typeof ManagementSystem>;

/** 4.1 issues and 4.2 interested parties. `needs` is for interested parties only. */
export const ContextItem = z
  .strictObject({
    ...systemShape,
    kind: ContextItemKind,
    text: LongText.max(2000),
    /** An interested party's needs and expectations, and which become compliance obligations. */
    needs: LongText.max(4000).nullable(),
    climateRelated: z.boolean(),
    reviewedOn: LocalDate.nullable(),
  })
  .refine((c) => c.kind === 'INTERESTED_PARTY' || c.needs === null, {
    path: ['needs'],
    message: 'Only an interested party has needs',
  });
export type ContextItem = z.infer<typeof ContextItem>;

/**
 * One checklist row: an assessable clause of a standard of the system. NOT_APPLICABLE is the status exactly while an
 * N/A request is REQUESTED or APPROVED, and only an APPROVED one counts as excluded (model §3.3, §4.6).
 */
export const ClauseAssessment = z
  .strictObject({
    ...systemShape,
    clauseId: Id,
    status: ClauseStatus,
    /** Why the clause does not apply; required while an N/A request is open or approved. */
    justification: LongText.max(4000).nullable(),
    naState: ClauseNaState,
    /** The status REJECT_NA restores; set while REQUESTED or APPROVED. */
    statusBeforeNa: ClauseWorkStatus.nullable(),
    naRequestedById: Id.nullable(),
    naDecidedById: Id.nullable(),
    naDecidedAt: Instant.nullable(),
    ownerId: Id.nullable(),
    notes: Note.nullable(),
    lastReviewedOn: LocalDate.nullable(),
  })
  .superRefine((a, ctx) => {
    const naOpen = a.naState === 'REQUESTED' || a.naState === 'APPROVED';
    if ((a.status === 'NOT_APPLICABLE') !== naOpen) {
      issue(
        ctx,
        'status',
        'NOT_APPLICABLE is the status exactly while N/A is REQUESTED or APPROVED',
      );
    }
    if (naOpen) {
      if (a.justification === null)
        issue(ctx, 'justification', 'An N/A request has a justification');
      if (a.statusBeforeNa === null)
        issue(ctx, 'statusBeforeNa', 'An N/A request keeps the status before it');
      if (a.naRequestedById === null)
        issue(ctx, 'naRequestedById', 'An N/A request has a requester');
    }
    if ((a.naDecidedById === null) !== (a.naDecidedAt === null)) {
      issue(ctx, 'naDecidedAt', 'naDecidedById and naDecidedAt are set together');
    }
    const decided = a.naState === 'APPROVED' || a.naState === 'REJECTED';
    if (decided && a.naDecidedById === null)
      issue(ctx, 'naDecidedById', 'A decided N/A has a decider');
    if (decided && a.naDecidedById !== null && a.naDecidedById === a.naRequestedById) {
      issue(ctx, 'naDecidedById', 'The requester does not decide their own N/A request');
    }
  });
export type ClauseAssessment = z.infer<typeof ClauseAssessment>;

// ---------- documents ----------

/** A document code, unique per client, e.g. "QP-07". */
export const DocumentCode = z.string().trim().min(1).max(50);

/**
 * 5.2 and 7.5: a controlled document. `currentRevisionId` is its latest APPROVED revision (null before the first).
 * `retention` is for FORM documents (7.5.3.2); `issuer` and `externalRef` for EXTERNAL ones.
 */
export const ControlledDocument = z
  .strictObject({
    ...systemShape,
    code: DocumentCode,
    title: Text.max(300),
    type: DocumentType,
    clauseIds: idList(50),
    status: DocumentStatus,
    currentRevisionId: Id.nullable(),
    ownerId: Id,
    approverId: Id,
    reviewDueOn: LocalDate.nullable(),
    lastReviewedOn: LocalDate.nullable(),
    /** How long records made on this form are kept, where, and how they are disposed of. */
    retention: LongText.max(2000).nullable(),
    issuer: Name.nullable(),
    externalRef: Text.max(200).nullable(),
  })
  .superRefine((d, ctx) => {
    if (d.type !== 'FORM' && d.retention !== null)
      issue(ctx, 'retention', 'Only a FORM has retention');
    if (d.type !== 'EXTERNAL') {
      if (d.issuer !== null) issue(ctx, 'issuer', 'Only an EXTERNAL document has an issuer');
      if (d.externalRef !== null) {
        issue(ctx, 'externalRef', 'Only an EXTERNAL document has an external reference');
      }
    }
  });
export type ControlledDocument = z.infer<typeof ControlledDocument>;

/**
 * One revision of a document. Its file is its `IsoFile`. An approved revision has `approvedAt`; a recorded edition of
 * an EXTERNAL document has no internal approver (`approvedById` null).
 */
export const DocumentRevision = z
  .strictObject({
    ...isoShape,
    documentId: Id,
    /** The client's own revision label, e.g. "B" or "2.0". */
    revision: Text.max(20),
    changeNote: LongText.max(2000).nullable(),
    state: RevisionState,
    preparedById: Id,
    approvedById: Id.nullable(),
    approvedAt: Instant.nullable(),
    /** The approver's reason for the last SEND_BACK; cleared on SUBMIT. */
    sendBackReason: LongText.max(2000).nullable(),
  })
  .superRefine((r, ctx) => {
    const approved = r.state === 'APPROVED' || r.state === 'SUPERSEDED';
    setExactlyWhen(
      ctx,
      r.approvedAt,
      approved,
      'approvedAt',
      'approvedAt is set exactly once approved',
    );
    if (!approved && r.approvedById !== null)
      issue(ctx, 'approvedById', 'Only an approved revision has an approver');
    if (r.approvedById !== null && r.approvedById === r.preparedById) {
      issue(ctx, 'approvedById', 'The approver is not the preparer');
    }
  });
export type DocumentRevision = z.infer<typeof DocumentRevision>;

// ---------- risks and controls ----------

/**
 * 6.1 risks and opportunities, 14001 aspects and 45001 hazards. `rating`, `residualRating` and `significant` are the
 * engine's results, stored when the item is written (model §1.7). For an OPPORTUNITY the second axis means benefit.
 */
export const RiskItem = z
  .strictObject({
    ...systemShape,
    kind: RiskKind,
    unitId: Id.nullable(),
    activity: Text.max(300),
    description: LongText.max(4000),
    /** ASPECT: the environmental impact; HAZARD: the harm. Required for both. */
    impact: LongText.max(2000).nullable(),
    lifeCycleStages: z.array(LifeCycleStage).refine(unique, { message: 'Stages repeat' }),
    controlType: AspectControlType.nullable(),
    routine: z.boolean().nullable(),
    personsExposed: z.array(PersonsExposed).refine(unique, { message: 'Groups repeat' }),
    condition: OperatingCondition.nullable(),
    /** The workers who took part in the assessment (45001 5.4 e). */
    assessedWith: LongText.max(2000).nullable(),
    likelihood: RiskScale,
    severity: RiskScale,
    /** After the planned treatment actions; cleared when none remain open. */
    residualLikelihood: RiskScale.nullable(),
    residualSeverity: RiskScale.nullable(),
    rating: RiskRating,
    residualRating: RiskRating.nullable(),
    significant: z.boolean(),
    significantOverride: z.boolean().nullable(),
    significanceReason: LongText.max(2000).nullable(),
    /** Statutory obligations the item relates to (14001 and 45001 6.1.3). */
    obligationIds: idList(50),
    climateRelated: z.boolean(),
    ownerId: Id,
    reviewDueOn: LocalDate.nullable(),
    lastReviewedOn: LocalDate.nullable(),
  })
  .superRefine((r, ctx) => {
    const aspect = r.kind === 'ASPECT';
    const hazard = r.kind === 'HAZARD';
    if ((aspect || hazard) && r.impact === null) issue(ctx, 'impact', `A ${r.kind} has an impact`);
    if (aspect !== r.lifeCycleStages.length > 0) {
      issue(
        ctx,
        'lifeCycleStages',
        'An ASPECT has at least one life-cycle stage, other kinds none',
      );
    }
    setExactlyWhen(
      ctx,
      r.controlType,
      aspect,
      'controlType',
      'controlType is set exactly for an ASPECT',
    );
    setExactlyWhen(ctx, r.routine, hazard, 'routine', 'routine is set exactly for a HAZARD');
    if (hazard !== r.personsExposed.length > 0) {
      issue(ctx, 'personsExposed', 'A HAZARD has at least one exposed group, other kinds none');
    }
    setExactlyWhen(
      ctx,
      r.condition,
      aspect || hazard,
      'condition',
      'condition is set exactly for an ASPECT or HAZARD',
    );
    if ((r.residualLikelihood === null) !== (r.residualSeverity === null)) {
      issue(ctx, 'residualSeverity', 'Residual likelihood and severity are set together');
    }
    setExactlyWhen(
      ctx,
      r.residualRating,
      r.residualLikelihood !== null,
      'residualRating',
      'residualRating is set exactly with the residual scores',
    );
    setExactlyWhen(
      ctx,
      r.significanceReason,
      r.significantOverride !== null,
      'significanceReason',
      'A significance override has a reason, and only an override has one',
    );
  });
export type RiskItem = z.infer<typeof RiskItem>;

/** A control in place on a risk item. Planned controls are treatment actions (`IsoAction` with `controlHierarchy`). */
export const RiskControl = z.strictObject({
  ...isoShape,
  riskItemId: Id,
  text: LongText.max(2000),
  /** Required on a HAZARD item (M16 checks; the control does not repeat its item's kind). */
  hierarchy: ControlHierarchy.nullable(),
  /** The treatment action whose completion put it in place. */
  sourceActionId: Id.nullable(),
});
export type RiskControl = z.infer<typeof RiskControl>;

// ---------- objectives ----------

/**
 * 6.2: an objective for one or more of its system's standards. Its plan (6.2.2) is its actions; its readings, taken
 * by `readingRule`, show how results are evaluated.
 */
export const Objective = z
  .strictObject({
    ...systemShape,
    standards: StandardList,
    text: Text.max(1000),
    target: z.number().finite(),
    unitOfMeasure: Text.max(50),
    baseline: z.number().finite().nullable(),
    direction: ObjectiveDirection,
    readingRule: RecurrenceRule,
    /** The risks, opportunities, aspects or hazards it addresses (14001 and 45001 6.2.1). */
    riskItemIds: idList(100),
    ownerId: Id,
    dueOn: LocalDate,
    closedOn: LocalDate.nullable(),
    outcome: ObjectiveOutcome.nullable(),
  })
  .superRefine((o, ctx) => {
    setExactlyWhen(
      ctx,
      o.outcome,
      o.closedOn !== null,
      'outcome',
      'A closed objective has an outcome',
    );
  });
export type Objective = z.infer<typeof Objective>;

export const ObjectiveReading = z
  .strictObject({
    ...isoShape,
    objectiveId: Id,
    periodStart: LocalDate,
    periodEnd: LocalDate,
    value: z.number().finite(),
    note: LongText.max(2000).nullable(),
    recordedById: Id,
  })
  .refine((r) => r.periodEnd >= r.periodStart, {
    path: ['periodEnd'],
    message: 'periodEnd must not be before periodStart',
  });
export type ObjectiveReading = z.infer<typeof ObjectiveReading>;

// ---------- internal audits ----------

/** 9.2: the audit programme of one FY (the client's FY). One per system and FY. */
export const AuditProgramme = z.strictObject({
  ...systemShape,
  fy: FyLabel,
  notes: Note.nullable(),
});
export type AuditProgramme = z.infer<typeof AuditProgramme>;

/** People named on an audit who are also its auditees: they need an independence note (9.2.2). */
export function selfAuditors(audit: {
  leadAuditorId: string;
  auditorIds: readonly string[];
  auditeeIds: readonly string[];
}): string[] {
  return [audit.leadAuditorId, ...audit.auditorIds].filter((id) => audit.auditeeIds.includes(id));
}

const AFTER_REPORT: readonly InternalAuditState[] = ['REPORTED', 'CLOSED'];

/**
 * An internal audit. An empty `unitIds` means its management system's units (unit scope), but only named units count
 * as covered (M4 `auditProgrammeCoverage`). A person who is both auditor (or lead) and auditee needs `independenceNote`.
 */
export const InternalAudit = z
  .strictObject({
    ...isoShape,
    programmeId: Id,
    title: Text.max(300),
    plannedStart: LocalDate,
    plannedEnd: LocalDate,
    clauseIds: idList(300),
    unitIds: idList(500),
    leadAuditorId: Id,
    auditorIds: idList(20),
    auditeeIds: idList(100),
    /** Who the results are reported to (9.2.2 c). At least one before REPORT. */
    reportedToIds: idList(20),
    independenceNote: LongText.max(2000).nullable(),
    state: InternalAuditState,
    summary: LongText.max(8000).nullable(),
    reportedOn: LocalDate.nullable(),
    cancelReason: LongText.max(2000).nullable(),
  })
  .superRefine((a, ctx) => {
    if (a.plannedEnd < a.plannedStart) issue(ctx, 'plannedEnd', 'The audit ends after it starts');
    if (a.auditorIds.includes(a.leadAuditorId)) {
      issue(ctx, 'auditorIds', 'The lead auditor is not listed again');
    }
    if (selfAuditors(a).length > 0 && a.independenceNote === null) {
      issue(
        ctx,
        'independenceNote',
        'An auditor who is also an auditee needs an independence note',
      );
    }
    const reported = AFTER_REPORT.includes(a.state);
    setExactlyWhen(
      ctx,
      a.reportedOn,
      reported,
      'reportedOn',
      'reportedOn is set exactly once REPORTED',
    );
    if (reported && a.summary === null) issue(ctx, 'summary', 'A reported audit has a summary');
    if (reported && a.reportedToIds.length === 0) {
      issue(ctx, 'reportedToIds', 'A reported audit names who it was reported to');
    }
    setExactlyWhen(
      ctx,
      a.cancelReason,
      a.state === 'CANCELLED',
      'cancelReason',
      'cancelReason is set exactly when CANCELLED',
    );
  });
export type InternalAudit = z.infer<typeof InternalAudit>;

/** One row of an internal audit's checklist. A FINDING row links its finding. */
export const AuditChecklistItem = z
  .strictObject({
    ...isoShape,
    internalAuditId: Id,
    clauseId: Id,
    unitId: Id.nullable(),
    question: LongText.max(2000),
    auditorNote: Note.nullable(),
    /** Null until answered. */
    result: ChecklistResult.nullable(),
    findingId: Id.nullable(),
    notAuditedReason: LongText.max(2000).nullable(),
  })
  .superRefine((c, ctx) => {
    setExactlyWhen(
      ctx,
      c.findingId,
      c.result === 'FINDING',
      'findingId',
      'A FINDING row links its finding',
    );
    setExactlyWhen(
      ctx,
      c.notAuditedReason,
      c.result === 'NOT_AUDITED',
      'notAuditedReason',
      'A NOT_AUDITED row has a reason, and only it has one',
    );
  });
export type AuditChecklistItem = z.infer<typeof AuditChecklistItem>;

// ---------- certification and external audits ----------

/**
 * A certificate for one standard of a system, from one certification body. Before it is issued it has no number,
 * issue or expiry date. An empty `unitIds` means the system's units; a null `scopeText` the system's scope.
 */
export const Certification = z
  .strictObject({
    ...systemShape,
    standardId: Id,
    body: Name,
    certificateNumber: Text.max(100).nullable(),
    issuedOn: LocalDate.nullable(),
    expiresOn: LocalDate.nullable(),
    scopeText: LongText.max(4000).nullable(),
    unitIds: idList(500),
  })
  .superRefine((c, ctx) => {
    const issued = c.issuedOn !== null;
    setExactlyWhen(
      ctx,
      c.expiresOn,
      issued,
      'expiresOn',
      'issuedOn and expiresOn are set together',
    );
    setExactlyWhen(
      ctx,
      c.certificateNumber,
      issued,
      'certificateNumber',
      'An issued certificate has a number, and only an issued one',
    );
    if (c.issuedOn !== null && c.expiresOn !== null && c.expiresOn <= c.issuedOn) {
      issue(ctx, 'expiresOn', 'expiresOn must be after issuedOn');
    }
  });
export type Certification = z.infer<typeof Certification>;

/** A certification body's visit; one integrated visit can cover several standards. */
export const ExternalAudit = z
  .strictObject({
    ...systemShape,
    standardIds: z.array(Id).min(1).max(3).refine(unique, { message: 'Standards repeat' }),
    type: ExternalAuditType,
    body: Name,
    /** The body's auditor, as text: not a Person. */
    leadAuditorName: Name.nullable(),
    startOn: LocalDate,
    endOn: LocalDate,
    recommendation: AuditRecommendation.nullable(),
    /** The body's deadline for the corrective-action response; null if none. */
    responseDueOn: LocalDate.nullable(),
    state: ExternalAuditState,
    cancelReason: LongText.max(2000).nullable(),
  })
  .superRefine((a, ctx) => {
    if (a.endOn < a.startOn) issue(ctx, 'endOn', 'The audit ends after it starts');
    if (a.state === 'CLOSED' && a.recommendation === null) {
      issue(ctx, 'recommendation', 'A closed external audit has a recommendation');
    }
    setExactlyWhen(
      ctx,
      a.cancelReason,
      a.state === 'CANCELLED',
      'cancelReason',
      'cancelReason is set exactly when CANCELLED',
    );
  });
export type ExternalAudit = z.infer<typeof ExternalAudit>;

/**
 * A finding of an internal audit or of an external audit: exactly one. A MAJOR_NC or MINOR_NC finding raised its
 * nonconformity in the same transaction; other types raise none.
 */
export const AuditFinding = z
  .strictObject({
    ...isoShape,
    internalAuditId: Id.nullable(),
    externalAuditId: Id.nullable(),
    type: FindingType,
    clauseIds: idList(20),
    unitId: Id.nullable(),
    description: LongText.max(4000),
    nonconformityId: Id.nullable(),
  })
  .superRefine((f, ctx) => {
    if ((f.internalAuditId === null) === (f.externalAuditId === null)) {
      issue(ctx, 'internalAuditId', 'A finding belongs to exactly one internal or external audit');
    }
    setExactlyWhen(
      ctx,
      f.nonconformityId,
      (NC_FINDING_TYPES as readonly FindingType[]).includes(f.type),
      'nonconformityId',
      'A MAJOR_NC or MINOR_NC finding links its nonconformity, other types none',
    );
  });
export type AuditFinding = z.infer<typeof AuditFinding>;

// ---------- nonconformities and incidents ----------

/**
 * Incident fields of an INCIDENT or NEAR_MISS nonconformity (model §3.11). They hold no injured person's name, health
 * or medical detail: that goes only in files (root non-negotiable 6).
 */
export const Incident = z
  .strictObject({
    occurredAt: Instant,
    location: Text.max(300),
    type: IncidentType,
    outcome: IncidentOutcome,
    personCategory: IncidentPersonCategory.nullable(),
    lostDays: z.int().min(1).max(10_000).nullable(),
    reportable: z.boolean(),
    /** The register instance for the statutory accident notice, when the user links one. */
    statutoryInstanceId: Id.nullable(),
    investigatorIds: idList(20),
    /** A non-managerial worker took part in the investigation (45001 5.4). */
    workerParticipation: z.boolean(),
  })
  .superRefine((i, ctx) => {
    if (i.type === 'NEAR_MISS' && i.outcome !== 'NONE')
      issue(ctx, 'outcome', 'A near miss has outcome NONE');
    setExactlyWhen(
      ctx,
      i.lostDays,
      i.outcome === 'LOST_TIME',
      'lostDays',
      'lostDays is set exactly for LOST_TIME',
    );
  });
export type Incident = z.infer<typeof Incident>;

const ROOT_CAUSE_ON: readonly NcState[] = [
  'ROOT_CAUSE_FOUND',
  'ACTIONS_PLANNED',
  'AWAITING_VERIFICATION',
  'CLOSED',
];
const SUBMITTED_ON: readonly NcState[] = ['AWAITING_VERIFICATION', 'CLOSED'];

/**
 * 10.2: a nonconformity, maker-checker like an instance (its owner and approver are different people). `number` counts
 * per client from 1.
 */
export const Nonconformity = z
  .strictObject({
    ...systemShape,
    number: z.int().min(1),
    source: NcSource,
    /** The statutory or ISO activity instance that raised it, e.g. a missed filing or a failed drill. */
    sourceInstanceId: Id.nullable(),
    raisedFromRiskItemId: Id.nullable(),
    severity: NcSeverity,
    standards: StandardList,
    clauseIds: idList(20),
    unitId: Id.nullable(),
    description: LongText.max(4000),
    reportedById: Id,
    reportedOn: LocalDate,
    /** For equipment found unfit, includes the check on earlier results (9001 7.1.5.2). */
    containment: Note.nullable(),
    correction: Note.nullable(),
    disposition: NcDisposition.nullable(),
    dispositionAuthorisedById: Id.nullable(),
    rootCauseMethod: RootCauseMethod.nullable(),
    rootCause: Note.nullable(),
    /** Whether similar nonconformities exist or could occur, and where. */
    similarOccurrences: Note.nullable(),
    relatedRiskItemIds: idList(50),
    updatedRiskItemIds: idList(50),
    /** "None needed" is an answer. */
    riskReview: Note.nullable(),
    systemChange: Note.nullable(),
    changedDocumentIds: idList(50),
    noActionReason: Note.nullable(),
    ownerId: Id,
    approverId: Id,
    dueOn: LocalDate,
    effectivenessDueOn: LocalDate.nullable(),
    effectivenessNote: Note.nullable(),
    /** True once verified effective; false after a VERIFY_NOT_EFFECTIVE; else null. */
    effective: z.boolean().nullable(),
    closedOn: LocalDate.nullable(),
    cancelReason: LongText.max(2000).nullable(),
    state: NcState,
    incident: Incident.nullable(),
  })
  .superRefine((n, ctx) => {
    if (n.ownerId === n.approverId) issue(ctx, 'approverId', 'The approver is not the owner');
    if (n.dueOn < n.reportedOn) issue(ctx, 'dueOn', 'dueOn must not be before reportedOn');
    setExactlyWhen(
      ctx,
      n.dispositionAuthorisedById,
      n.disposition !== null,
      'dispositionAuthorisedById',
      'A disposition names who authorised it (9001 8.7.2), and only a disposition does',
    );
    const incidentSource = (INCIDENT_SOURCES as readonly NcSource[]).includes(n.source);
    setExactlyWhen(
      ctx,
      n.incident,
      incidentSource,
      'incident',
      'An INCIDENT or NEAR_MISS nonconformity has incident fields, other sources none',
    );
    if (incidentSource && n.unitId === null) issue(ctx, 'unitId', 'An incident has a unit');
    if (n.incident !== null && (n.incident.type === 'NEAR_MISS') !== (n.source === 'NEAR_MISS')) {
      issue(ctx, 'incident', 'The incident type is NEAR_MISS exactly when the source is NEAR_MISS');
    }
    if (ROOT_CAUSE_ON.includes(n.state)) {
      for (const field of [
        'containment',
        'correction',
        'rootCauseMethod',
        'rootCause',
        'similarOccurrences',
      ] as const) {
        if (n[field] === null) issue(ctx, field, `${n.state} needs ${field}`);
      }
    }
    if (SUBMITTED_ON.includes(n.state)) {
      for (const field of ['riskReview', 'systemChange'] as const) {
        if (n[field] === null) issue(ctx, field, `${n.state} needs ${field}`);
      }
    }
    setExactlyWhen(
      ctx,
      n.closedOn,
      n.state === 'CLOSED',
      'closedOn',
      'closedOn is set exactly when CLOSED',
    );
    if (n.state === 'CLOSED') {
      if (n.effective !== true)
        issue(ctx, 'effective', 'A CLOSED nonconformity was verified effective');
      if (n.effectivenessNote === null)
        issue(ctx, 'effectivenessNote', 'A CLOSED nonconformity has an effectiveness note');
    }
    if (n.closedOn !== null && n.closedOn < n.reportedOn) {
      issue(ctx, 'closedOn', 'closedOn must not be before reportedOn');
    }
    setExactlyWhen(
      ctx,
      n.cancelReason,
      n.state === 'CANCELLED',
      'cancelReason',
      'cancelReason is set exactly when CANCELLED',
    );
  });
export type Nonconformity = z.infer<typeof Nonconformity>;

// ---------- actions ----------

/** What an action is for: exactly one record (model §3.12). */
export const IsoActionSubject = z.strictObject({ type: IsoActionSubjectType, id: Id });
export type IsoActionSubject = z.infer<typeof IsoActionSubject>;

/**
 * One action entity for every subject: a corrective action (NC), treatment action (risk item), objective plan,
 * improvement action (finding) or review action (management review).
 */
export const IsoAction = z
  .strictObject({
    ...isoShape,
    subject: IsoActionSubject,
    text: LongText.max(2000),
    resources: LongText.max(2000).nullable(),
    ownerId: Id,
    dueOn: LocalDate,
    doneOn: LocalDate.nullable(),
    state: IsoActionState,
    effectivenessNote: Note.nullable(),
    cancelReason: LongText.max(2000).nullable(),
    /** Risk items only; required on a HAZARD item (M16 checks). */
    controlHierarchy: ControlHierarchy.nullable(),
    /** Management reviews only: the review output it carries out. */
    outputKey: ReviewOutputKey.nullable(),
  })
  .superRefine((a, ctx) => {
    setExactlyWhen(ctx, a.doneOn, a.state === 'DONE', 'doneOn', 'doneOn is set exactly when DONE');
    setExactlyWhen(
      ctx,
      a.cancelReason,
      a.state === 'CANCELLED',
      'cancelReason',
      'cancelReason is set exactly when CANCELLED',
    );
    if (a.subject.type !== 'RISK_ITEM' && a.controlHierarchy !== null) {
      issue(ctx, 'controlHierarchy', 'Only an action on a risk item has a control hierarchy');
    }
    if (a.subject.type !== 'MANAGEMENT_REVIEW' && a.outputKey !== null) {
      issue(ctx, 'outputKey', 'Only an action on a management review carries out an output');
    }
  });
export type IsoAction = z.infer<typeof IsoAction>;

// ---------- management review ----------

/** 9.3: a management review of some or all of its system's standards. */
export const ManagementReview = z
  .strictObject({
    ...systemShape,
    standards: StandardList,
    plannedOn: LocalDate,
    heldOn: LocalDate.nullable(),
    chairId: Id,
    attendeeIds: idList(100),
    minutes: LongText.nullable(),
    state: ManagementReviewState,
    cancelReason: LongText.max(2000).nullable(),
  })
  .superRefine((r, ctx) => {
    setExactlyWhen(
      ctx,
      r.heldOn,
      r.state === 'HELD' || r.state === 'CLOSED',
      'heldOn',
      'heldOn is set exactly once HELD',
    );
    setExactlyWhen(
      ctx,
      r.cancelReason,
      r.state === 'CANCELLED',
      'cancelReason',
      'cancelReason is set exactly when CANCELLED',
    );
  });
export type ManagementReview = z.infer<typeof ManagementReview>;

/** One figure of a review input: a camelCase key, its value and the ids behind it (empty for a score). */
export const ReviewFigure = z.strictObject({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'Expected a camelCase key'),
  value: z.number().finite(),
  ids: z.array(Id),
});
export type ReviewFigure = z.infer<typeof ReviewFigure>;

/**
 * `reviewInputFigures` (model §5.4): one input source's figures between `since` and `asOf`, both days included
 * (`since` never after `asOf`), over the review's whole system; none for MANUAL. A PLANNED review's are computed as of
 * today; a held review's are the copy its input row stored at RECORD_HELD, counted up to its `heldOn` (§3.13).
 */
export const ReviewInputFigures = z
  .strictObject({
    source: ReviewInputSource,
    since: LocalDate,
    asOf: LocalDate,
    figures: z.array(ReviewFigure),
  })
  .refine((f) => f.since <= f.asOf, { message: 'since is after asOf', path: ['since'] });
export type ReviewInputFigures = z.infer<typeof ReviewInputFigures>;

/**
 * What one figure key of `reviewInputFigures` means for its readers: `entityType`, the audit-trail entity type its ids
 * name (an ISO type is also its table's name; `instance` is a compliance instance), null for a score with no ids; and
 * `countsIds`, whether its value is the number of its ids. It is not for `lostDays` (a sum of days),
 * `verifiedNotEffective` (a number of steps, with each NC once) or a score, so a screen that says "N (M you can open)"
 * reads M from the ids only when `countsIds` is true.
 */
export interface ReviewFigureKeyInfo {
  entityType: EntityType | null;
  countsIds: boolean;
}

/** A figure whose value is the number of its ids, all of `entityType`. */
const counts = <T extends EntityType>(entityType: T) => ({ entityType, countsIds: true }) as const;

/**
 * Every figure key `reviewInputFigures` emits, by source (model §5.4), with what it means (`ReviewFigureKeyInfo`). The
 * engine emits each key of its source on every call, except `statutoryScore` when nothing is due in the window and the
 * `significant<Kind>` keys of RISKS for a kind the input's key does not read (`reviewRiskKinds`), and every key it
 * emits is listed here. A stored figure keeps its key for good (9001 7.5.3), so keys are only ever added:
 * a key whose meaning changes gets a new name. M17 and M10 word every key listed; M3's `isoVisibleIds` (ISO-2h) takes
 * each figure's entity type from here.
 */
export const REVIEW_FIGURE_KEYS = {
  PREVIOUS_ACTIONS: {
    actionsOpen: counts('iso_action'),
    actionsOverdue: counts('iso_action'),
    actionsDone: counts('iso_action'),
    actionsCancelled: counts('iso_action'),
  },
  CONTEXT: {
    issuesAdded: counts('context_item'),
    issuesChanged: counts('context_item'),
    interestedPartiesAdded: counts('context_item'),
    interestedPartiesChanged: counts('context_item'),
    contextItemsRemoved: counts('context_item'),
    climateDecided: counts('management_system'),
    climateRelevant: counts('management_system'),
    climateDecidedInPeriod: counts('management_system'),
  },
  RISKS: {
    itemsAdded: counts('risk_item'),
    itemsRerated: counts('risk_item'),
    // Only for the kinds the input's key reads (`reviewRiskKinds`).
    significantRisk: counts('risk_item'),
    significantOpportunity: counts('risk_item'),
    significantAspect: counts('risk_item'),
    significantHazard: counts('risk_item'),
    treatmentActionsDone: counts('iso_action'),
    treatmentActionsOpen: counts('iso_action'),
  },
  OBJECTIVES: {
    objectivesOpen: counts('objective'),
    onTrack: counts('objective'),
    offTrack: counts('objective'),
    withoutReading: counts('objective'),
    achieved: counts('objective'),
    notAchieved: counts('objective'),
    readingsRecorded: counts('objective_reading'),
  },
  NONCONFORMITIES: {
    raised: counts('nonconformity'),
    closed: counts('nonconformity'),
    raisedMajor: counts('nonconformity'),
    raisedMinor: counts('nonconformity'),
    raisedInternalAudit: counts('nonconformity'),
    raisedExternalAudit: counts('nonconformity'),
    raisedIncident: counts('nonconformity'),
    raisedNearMiss: counts('nonconformity'),
    raisedComplaint: counts('nonconformity'),
    raisedProcess: counts('nonconformity'),
    raisedLegal: counts('nonconformity'),
    raisedOther: counts('nonconformity'),
    closedMajor: counts('nonconformity'),
    closedMinor: counts('nonconformity'),
    closedInternalAudit: counts('nonconformity'),
    closedExternalAudit: counts('nonconformity'),
    closedIncident: counts('nonconformity'),
    closedNearMiss: counts('nonconformity'),
    closedComplaint: counts('nonconformity'),
    closedProcess: counts('nonconformity'),
    closedLegal: counts('nonconformity'),
    closedOther: counts('nonconformity'),
    verifiedNotEffective: { entityType: 'nonconformity', countsIds: false },
    open: counts('nonconformity'),
    correctiveActionsOverdue: counts('iso_action'),
  },
  INCIDENTS: {
    incidents: counts('nonconformity'),
    typeInjury: counts('nonconformity'),
    typeIllHealth: counts('nonconformity'),
    typeDangerousOccurrence: counts('nonconformity'),
    typeEnvironmentalRelease: counts('nonconformity'),
    typeFire: counts('nonconformity'),
    typePropertyDamage: counts('nonconformity'),
    typeNearMiss: counts('nonconformity'),
    outcomeNone: counts('nonconformity'),
    outcomeFirstAid: counts('nonconformity'),
    outcomeMedicalTreatment: counts('nonconformity'),
    outcomeRestrictedWork: counts('nonconformity'),
    outcomeLostTime: counts('nonconformity'),
    outcomeFatality: counts('nonconformity'),
    lostDays: { entityType: 'nonconformity', countsIds: false },
  },
  AUDIT_RESULTS: {
    internalAuditsReported: counts('internal_audit'),
    externalAuditsHeld: counts('external_audit'),
    findingsMajorNc: counts('audit_finding'),
    findingsMinorNc: counts('audit_finding'),
    findingsObservation: counts('audit_finding'),
    findingsOfi: counts('audit_finding'),
    findingsGoodPractice: counts('audit_finding'),
  },
  COMPLIANCE_EVALUATION: {
    evaluationsDue: counts('instance'),
    evaluationsDone: counts('instance'),
    latestEvaluation: counts('instance'),
    statutoryInstancesDue: counts('instance'),
    statutoryScore: { entityType: null, countsIds: false },
  },
} as const satisfies Record<
  Exclude<ReviewInputSource, 'MANUAL'>,
  Record<string, ReviewFigureKeyInfo>
>;

/** A figure key of one source, as `REVIEW_FIGURE_KEYS` lists it. */
export type ReviewFigureKey<
  S extends keyof typeof REVIEW_FIGURE_KEYS = keyof typeof REVIEW_FIGURE_KEYS,
> = S extends keyof typeof REVIEW_FIGURE_KEYS ? keyof (typeof REVIEW_FIGURE_KEYS)[S] : never;

/**
 * The risk kinds a RISKS input reads (model §5.4, catalogue §5): `SIGNIFICANT_ASPECTS` aspects only;
 * `RISKS_AND_OPPORTUNITIES` risks and opportunities, and hazards when ISO 45001 is among the input's standards (the
 * review's standards that ask for it); `RISK_ACTIONS` (9001 only) risks and opportunities. So a 14001 review's two RISKS
 * rows never count the same item. Any other key reads no risk items. In `RiskKind` order; the caller gathers only these
 * kinds (M3, ISO-2h), and the figures have a `significant<Kind>` key for these kinds only.
 */
export function reviewRiskKinds(
  key: ReviewInputKey,
  standards: readonly IsoStandardCode[],
): RiskKind[] {
  if (key === 'SIGNIFICANT_ASPECTS') return ['ASPECT'];
  if (key === 'RISKS_AND_OPPORTUNITIES' && standards.includes('ISO_45001')) {
    return ['RISK', 'OPPORTUNITY', 'HAZARD'];
  }
  return key === 'RISKS_AND_OPPORTUNITIES' || key === 'RISK_ACTIONS' ? ['RISK', 'OPPORTUNITY'] : [];
}

/**
 * One input row of a review: one per input key of its standards (a key shared by several appears once). A held
 * review's figures are a record, not a cache (model §1.7, §3.13): at RECORD_HELD each live row whose source is not
 * MANUAL stores `sourceFigures` (the whole system, no unit scope), `figuresStoredAt` (the step's time) and
 * `figuresEngineVersion` (`ENGINE_VERSION`), all three at once, and they never change after. A row stored before
 * 1.8.2 has none of them, so they parse as null when absent.
 */
export const ReviewInput = z
  .strictObject({
    ...isoShape,
    managementReviewId: Id,
    inputDefId: Id,
    notes: LongText.max(8000).nullable(),
    sourceFigures: ReviewInputFigures.nullable().default(null),
    figuresStoredAt: Instant.nullable().default(null),
    figuresEngineVersion: Text.max(40).nullable().default(null),
  })
  .refine(
    (r) =>
      (r.sourceFigures === null) === (r.figuresStoredAt === null) &&
      (r.sourceFigures === null) === (r.figuresEngineVersion === null),
    {
      path: ['sourceFigures'],
      message: 'sourceFigures, figuresStoredAt and figuresEngineVersion are stored together',
    },
  );
export type ReviewInput = z.infer<typeof ReviewInput>;

/** One output row of a review: one per output key of its standards. */
export const ReviewOutput = z.strictObject({
  ...isoShape,
  managementReviewId: Id,
  outputDefId: Id,
  decision: LongText.max(8000).nullable(),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

// ---------- files ----------

/** What an ISO file is attached to: exactly one ISO record (model §6). */
export const IsoFileSubject = z.strictObject({ type: IsoFileSubjectType, id: Id });
export type IsoFileSubject = z.infer<typeof IsoFileSubject>;

const isoFileFields = {
  ...baseShape,
  clientId: Id,
  fileName: Text.max(255),
  mimeType: Text.max(255),
  sizeBytes: z.int().min(1).max(MAX_EVIDENCE_BYTES),
  sha256: Sha256,
  scanStatus: ScanStatus,
  uploadedById: Id,
  uploadedAt: Instant,
  /** Why it was removed; set with `archivedAt`. */
  removeReason: LongText.max(2000).nullable(),
};

/** The `iso_file` subject columns, one per subject type. */
export const ISO_FILE_SUBJECT_COLUMNS = {
  clause_assessment: 'clauseAssessmentId',
  document_revision: 'documentRevisionId',
  risk_item: 'riskItemId',
  objective_reading: 'objectiveReadingId',
  internal_audit: 'internalAuditId',
  audit_finding: 'auditFindingId',
  external_audit: 'externalAuditId',
  certification: 'certificationId',
  nonconformity: 'nonconformityId',
  iso_action: 'isoActionId',
  management_review: 'managementReviewId',
} as const satisfies Record<IsoFileSubjectType, string>;

/**
 * A stored ISO file: one nullable column per subject, exactly one set (`CHECK num_nonnulls = 1` in M3). `storageKey`
 * is never returned; the API returns `IsoFileView`. Same scan, CLEAN-only download and 5-minute URLs as evidence.
 */
export const IsoFile = z
  .strictObject({
    ...isoFileFields,
    ...(Object.fromEntries(
      Object.values(ISO_FILE_SUBJECT_COLUMNS).map((column) => [column, Id.nullable()]),
    ) as Record<(typeof ISO_FILE_SUBJECT_COLUMNS)[IsoFileSubjectType], z.ZodNullable<typeof Id>>),
    storageKey: Text,
  })
  .superRefine((f, ctx) => {
    const set = Object.values(ISO_FILE_SUBJECT_COLUMNS).filter((column) => f[column] !== null);
    if (set.length !== 1) issue(ctx, 'clauseAssessmentId', 'An ISO file has exactly one subject');
    setExactlyWhen(
      ctx,
      f.removeReason,
      f.archivedAt !== null,
      'removeReason',
      'A removed file has a reason',
    );
  });
export type IsoFile = z.infer<typeof IsoFile>;

/** An ISO file as the API returns it: no `storageKey`, and its subject as `{ type, id }`. */
export const IsoFileView = z
  .strictObject({ ...isoFileFields, subject: IsoFileSubject })
  .refine((f) => (f.removeReason === null) === (f.archivedAt === null), {
    path: ['removeReason'],
    message: 'A removed file has a reason',
  });
export type IsoFileView = z.infer<typeof IsoFileView>;

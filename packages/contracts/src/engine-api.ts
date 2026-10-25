import type { DerivedStatus, HolidayPolicy, IsoStandardCode, TimelineType } from './enums.js';
import type {
  IsoNotificationInput,
  IsoReminderSchedule,
  PlannedIsoNotification,
} from './defaults.js';
import type {
  AuditChecklistItem,
  Certification,
  ClauseAssessment,
  ContextItem,
  ControlledDocument,
  ExternalAudit,
  InternalAudit,
  IsoAction,
  IsoClause,
  IsoStandard,
  ManagementReview,
  Nonconformity,
  Objective,
  ObjectiveReading,
  ReviewInput,
  ReviewInputKey,
  ReviewInputSource,
  RiskItem,
} from './schemas/iso.js';
import type {
  AuditProgrammeCoverage,
  CertificationCycle,
  CertificationReadiness,
  ClauseReadiness,
  ClimateGap,
  IncidentCounts,
  IsoDueStatus,
  ManagementReviewDue,
  NonconformityStatus,
  ObjectiveProgress,
  ReviewInputFigures,
} from './schemas/iso-results.js';
import type { LocalDate } from './primitives.js';
import type { GeneratedPeriod, InferredRule, RecurrenceRule } from './schemas/library.js';
import type { PlannedNotification, ScoreInput, ScoreResult } from './schemas/scores.js';
import type { FirmSettings, IsoRiskRule, ReminderSettings } from './schemas/tenancy.js';
import type { InstanceStatusInput } from './schemas/work.js';
import type { FyLabel, Id } from './primitives.js';

/**
 * Signatures of the engine functions other modules call (docs/contracts/domain-model.md §4).
 * M4 implements them in packages/engine and can check its exports with `satisfies EngineApi`.
 */

export interface EngineCalendar {
  fyStartMonth: number;
  holidayPolicy: HolidayPolicy;
}

export interface DerivedStatusResult {
  status: DerivedStatus;
  /** Days past the due date when OVERDUE, else null. */
  overdueDays: number | null;
  /** True for a SUBMITTED instance whose due date has passed. */
  submittedOverdue: boolean;
}

/** What planNotifications reads: the instance's status fields, its id and who to remind. */
export type NotificationInput = InstanceStatusInput & { id: Id; ownerId: Id; approverId: Id };

export interface EngineApi {
  generateInstances(
    rule: RecurrenceRule,
    range: { from: LocalDate; to: LocalDate },
    cal: EngineCalendar,
  ): GeneratedPeriod[];
  inferRule(dueDates: LocalDate[], timelineType: TimelineType, cal: EngineCalendar): InferredRule;
  deriveStatus(
    i: InstanceStatusInput,
    asOf: LocalDate,
    s: { dueSoonDays: number },
  ): DerivedStatusResult;
  computeScore(items: ScoreInput[], asOf: LocalDate, s: FirmSettings): ScoreResult;
  planNotifications(
    i: NotificationInput,
    s: ReminderSettings,
    asOf: LocalDate,
  ): PlannedNotification[];
  ENGINE_VERSION: string;
}

/** The state machines `isoTransition` holds (docs/iso/model.md §4). */
export type IsoMachine =
  | 'NONCONFORMITY'
  | 'DOCUMENT_REVISION'
  | 'DOCUMENT'
  | 'INTERNAL_AUDIT'
  | 'EXTERNAL_AUDIT'
  | 'MANAGEMENT_REVIEW'
  | 'CLAUSE_NA'
  | 'ISO_ACTION';

/**
 * `isoTransition`'s answer: the next state, an action the state does not allow (the API's 409 INVALID_TRANSITION), or
 * the guard that failed with the fields it names (400 VALIDATION, or 422 REASON_REQUIRED when the field is a reason).
 */
export type IsoTransitionResult =
  | { ok: true; to: string }
  | { ok: false; error: 'INVALID_TRANSITION' }
  | { ok: false; error: 'GUARD'; guard: string; fields: string[] };

/** What the system-level functions read about a management system. */
export interface IsoSystemInput {
  id: Id;
  standardIds: Id[];
  unitIds: Id[];
  scopeStatement: string | null;
  climateChangeRelevant: boolean | null;
  reviewIntervalMonths: number;
  /** The system's `createdAt` as a date in the client's time zone, from the engine's date helper. */
  createdOn: LocalDate;
}

/** The records `certificationReadiness` reads, all of one management system. */
export interface CertificationReadinessData {
  standards: Pick<IsoStandard, 'id' | 'code'>[];
  clauses: Pick<IsoClause, 'id' | 'standardId' | 'number' | 'assessable' | 'exclusionAllowed'>[];
  assessments: Pick<ClauseAssessment, 'clauseId' | 'status' | 'naState'>[];
  audits: Pick<InternalAudit, 'id' | 'state' | 'reportedOn' | 'unitIds'>[];
  checklistItems: Pick<AuditChecklistItem, 'internalAuditId' | 'clauseId' | 'unitId' | 'result'>[];
  reviews: Pick<ManagementReview, 'id' | 'state' | 'heldOn' | 'standards'>[];
  reviewInputs: (Pick<ReviewInput, 'managementReviewId' | 'notes'> & {
    key: ReviewInputKey;
    standard: IsoStandardCode;
  })[];
  documents: Pick<
    ControlledDocument,
    'id' | 'type' | 'status' | 'currentRevisionId' | 'clauseIds'
  >[];
  objectives: Pick<Objective, 'id' | 'standards' | 'closedOn'>[];
  /** Actions whose subject is an objective. */
  objectiveActions: Pick<IsoAction, 'id' | 'subject' | 'state'>[];
  riskItems: Pick<RiskItem, 'id' | 'kind' | 'archivedAt'>[];
}

/**
 * The ISO engine functions (docs/iso/model.md §5), beside `EngineApi` so adding them never breaks the engine's
 * `satisfies EngineApi`. M4 exports them as one object that `satisfies IsoEngineApi`. Pure, with explicit dates.
 */
export interface IsoEngineApi {
  /** likelihood × severity on the fixed 1-5 scales: 1 to 25. */
  riskRating(likelihood: number, severity: number): number;
  /** The rating reaches `rule.significantAt`, or (if the rule says so) an obligation is linked; an override wins. */
  isSignificant(
    item: Pick<RiskItem, 'rating' | 'obligationIds' | 'significantOverride'>,
    rule: IsoRiskRule,
  ): boolean;
  clauseReadiness(
    assessments: Pick<ClauseAssessment, 'clauseId' | 'status' | 'naState'>[],
    clauses: Pick<IsoClause, 'id' | 'standardId' | 'assessable' | 'exclusionAllowed'>[],
  ): ClauseReadiness;
  certificationReadiness(
    system: IsoSystemInput,
    data: CertificationReadinessData,
    asOf: LocalDate,
  ): CertificationReadiness;
  objectiveProgress(
    readings: Pick<ObjectiveReading, 'periodStart' | 'periodEnd' | 'value'>[],
    objective: Pick<
      Objective,
      'id' | 'target' | 'baseline' | 'direction' | 'readingRule' | 'dueOn'
    > & {
      /** The objective's `createdAt` as a date in the client's time zone, from the engine's date helper. */
      createdOn: LocalDate;
    },
    asOf: LocalDate,
    /** Reading periods follow the client's financial year (`readingRule`, as `generateInstances`). */
    cal: Pick<EngineCalendar, 'fyStartMonth'>,
  ): ObjectiveProgress;
  auditProgrammeCoverage(
    audits: Pick<InternalAudit, 'id' | 'state' | 'unitIds'>[],
    checklistItems: Pick<
      AuditChecklistItem,
      'internalAuditId' | 'clauseId' | 'unitId' | 'result'
    >[],
    system: Pick<IsoSystemInput, 'unitIds'>,
    /** `excluded`: the clause has an approved N/A in this system, so it needs no coverage. */
    clauses: (Pick<IsoClause, 'id' | 'assessable'> & { excluded: boolean })[],
    fy: FyLabel,
  ): AuditProgrammeCoverage;
  incidentCounts(
    ncs: Pick<Nonconformity, 'id' | 'incident'>[],
    period: { from: LocalDate; to: LocalDate },
    timeZone: string,
  ): IncidentCounts;
  climateDeterminationGaps(
    system: Pick<IsoSystemInput, 'climateChangeRelevant'>,
    contextItems: Pick<ContextItem, 'climateRelated' | 'archivedAt'>[],
    riskItems: Pick<RiskItem, 'climateRelated' | 'archivedAt'>[],
  ): ClimateGap[];
  /**
   * The transition tables of model §4. `facts` are what the guards read (field values and counts M16 gathers), named
   * as the guard columns name them.
   */
  isoTransition(
    machine: IsoMachine,
    from: string,
    action: string,
    facts: Readonly<Record<string, unknown>>,
  ): IsoTransitionResult;
  nonconformityStatus(
    nc: Pick<Nonconformity, 'state' | 'dueOn' | 'effectivenessDueOn'>,
    actions: Pick<IsoAction, 'state' | 'dueOn'>[],
    asOf: LocalDate,
    s: { dueSoonDays: number },
  ): NonconformityStatus;
  actionStatus(
    action: Pick<IsoAction, 'state' | 'dueOn'>,
    asOf: LocalDate,
    s: { dueSoonDays: number },
  ): IsoDueStatus;
  certificationCycle(
    certification: Pick<Certification, 'id' | 'standardId' | 'issuedOn' | 'expiresOn'>,
    externalAudits: Pick<ExternalAudit, 'id' | 'type' | 'state' | 'standardIds' | 'endOn'>[],
    asOf: LocalDate,
  ): CertificationCycle;
  managementReviewDue(
    system: Pick<IsoSystemInput, 'createdOn' | 'reviewIntervalMonths'> & {
      standards: IsoStandardCode[];
    },
    reviews: Pick<ManagementReview, 'state' | 'heldOn' | 'standards'>[],
    asOf: LocalDate,
    s: { dueSoonDays: number },
  ): ManagementReviewDue;
  reviewDue(
    reviewDueOn: LocalDate | null,
    asOf: LocalDate,
    s: { dueSoonDays: number },
  ): IsoDueStatus;
  planIsoNotifications(
    items: IsoNotificationInput[],
    schedule: IsoReminderSchedule,
    asOf: LocalDate,
  ): PlannedIsoNotification[];
  /**
   * The figures of one review input source between `since` (the last held review covering the input's standards, or
   * the system's `createdOn`) and `asOf`. `data` is the system's records the source reads; MANUAL has none.
   */
  reviewInputFigures(
    source: ReviewInputSource,
    data: Readonly<Record<string, unknown>>,
    since: LocalDate,
    asOf: LocalDate,
  ): ReviewInputFigures;
}

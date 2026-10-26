import type {
  DerivedStatus,
  HolidayPolicy,
  IsoStandardCode,
  TimelineType,
  WorkflowState,
} from './enums.js';
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
  FindingType,
  InternalAudit,
  IsoAction,
  IsoClause,
  IsoStandard,
  ManagementReview,
  ManagementSystem,
  Nonconformity,
  Objective,
  ObjectiveReading,
  ReviewInput,
  ReviewInputFigures,
  ReviewInputKey,
  ReviewInputSource,
  RiskItem,
  RiskKind,
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
 * A record's creation and archive days for `reviewInputFigures`, on every row it reads: its `createdAt` and
 * `archivedAt` as client-local days (`localDateIn`). A record counts from its creation day; one archived after as-of
 * still counts as live.
 */
export interface ReviewFigureDays {
  createdOn: LocalDate;
  archivedOn: LocalDate | null;
}

/**
 * The client-local day (`localDateIn` of its `at`) of one audited event of a record, for the window counts that have
 * no date field of their own (docs/iso/model.md §5.4). The caller passes the events of the window.
 */
export interface ReviewFigureEventDay {
  entityId: Id;
  on: LocalDate;
}

/**
 * An action as the figures read it. `settledOn` is the client-local day of its latest COMPLETE or CANCEL step (the
 * latest when it was reopened and settled again, so COMPLETE, REOPEN, COMPLETE counts by the later COMPLETE), set for
 * every DONE or CANCELLED action and null for an OPEN one. Its settled day is the later of `doneOn` and `settledOn` when
 * DONE, and `settledOn` when CANCELLED; it counts as OPEN on as-of until that day (docs/iso/model.md §5.4).
 */
export type ReviewFigureAction = Pick<IsoAction, 'id' | 'subject' | 'state' | 'dueOn' | 'doneOn'> &
  ReviewFigureDays & { settledOn: LocalDate | null };

/**
 * The records each review input source reads (docs/iso/model.md §5.4): those of the review's system that the source
 * reads, for the input's standards, archived ones included, with no unit scope. The caller picks them: the risk kinds
 * the input's key reads (`reviewRiskKinds`), and the findings whose clauses' standards overlap the input's. The engine
 * reads each record as it is now, except where one of its dates gives its state on as-of; the event-day lists give the
 * window counts that have no date field of their own. A date a user enters is placed by the later of that date and the
 * day of the step that set it (the `...StepOn` and `settledOn` days, each the latest such step), so a record entered
 * after one review is recorded, but dated before it, counts in the next one; each climate decision is placed by its
 * own event's day. MANUAL reads nothing.
 */
export interface ReviewFigureData {
  /**
   * The review actions of every earlier held review that covers one of the input's standards: those open on as-of,
   * and those DONE or CANCELLED with their settled day in the window (one settled before `since` was reported before).
   */
  PREVIOUS_ACTIONS: { actions: ReviewFigureAction[] };
  CONTEXT: {
    contextItems: (Pick<ContextItem, 'id' | 'kind'> & ReviewFigureDays)[];
    /** The days of the context items' UPDATE events (changed). */
    contextChanges: ReviewFigureEventDay[];
    /** `climateChangeRelevant` is read as it is now. */
    system: Pick<ManagementSystem, 'id' | 'climateChangeRelevant' | 'climateDecidedOn'>;
    /**
     * The days of the climate decisions: every management system UPDATE whose `after` names `climateChangeRelevant`,
     * `climateChangeRationale` or `climateDecidedOn` (only the climate route writes them, and only the fields it
     * changes, so a new rationale alone is one), each a decision on its own day (`climateDecidedOn` is never later).
     * A system decided when it was seeded or loaded, with no decision in its trail or a first one that does not move
     * `climateChangeRelevant` from null, also has that decision, on the later of the `climateDecidedOn` it was seeded
     * with and its creation day (model §5.4). `climateDecided` counts from the first on or before as-of, since a
     * decision never returns to undecided; `climateDecidedInPeriod` when one falls in the window.
     */
    climateDecisions: ReviewFigureEventDay[];
  };
  RISKS: {
    /**
     * The kinds the input's key reads (`reviewRiskKinds`), in `RiskKind` order: the figures have a `significant<Kind>`
     * key for these kinds only, so a 14001 review's two RISKS rows never count, or show a zero for, each other's items.
     */
    kinds: RiskKind[];
    /** Only the items of `kinds`. */
    riskItems: (Pick<RiskItem, 'id' | 'kind' | 'significant'> & ReviewFigureDays)[];
    /**
     * The days of the risk items' UPDATE events whose `after` names `likelihood`, `severity`, `residualLikelihood` or
     * `residualSeverity` (re-rated). The automatic clearing of a residual rating by a treatment action is not one.
     */
    ratingChanges: ReviewFigureEventDay[];
    treatmentActions: ReviewFigureAction[];
  };
  OBJECTIVES: {
    /**
     * `closeStepOn`: the day of its CLOSE step, null while open. A closed objective is placed by the later of that day
     * and `closedOn`, and counts as open on as-of until then.
     */
    objectives: (Pick<
      Objective,
      'id' | 'target' | 'baseline' | 'direction' | 'readingRule' | 'dueOn' | 'closedOn' | 'outcome'
    > &
      ReviewFigureDays & {
        closeStepOn: LocalDate | null;
        readings: (Pick<ObjectiveReading, 'id' | 'periodStart' | 'periodEnd' | 'value'> &
          ReviewFigureDays)[];
      })[];
    calendar: Pick<EngineCalendar, 'fyStartMonth'>;
  };
  NONCONFORMITIES: {
    /**
     * An NC counts, and is raised, from its counting day: the later of `createdOn` and `reportedOn`. Its `closedOn` is
     * the day of the step that closed it, so it needs no step day.
     */
    nonconformities: (Pick<
      Nonconformity,
      'id' | 'state' | 'severity' | 'source' | 'reportedOn' | 'closedOn'
    > &
      ReviewFigureDays)[];
    /** The days of the NCs' TRANSITION events whose `after.action` is `VERIFY_NOT_EFFECTIVE`. */
    notEffectiveSteps: ReviewFigureEventDay[];
    /** Their actions; only those of an NC open on as-of count as overdue. */
    correctiveActions: ReviewFigureAction[];
  };
  INCIDENTS: {
    /**
     * The incident NCs, cancelled ones left out. Each is placed by its NC's counting day (the later of `createdOn` and
     * `reportedOn`); its `occurredAt` day is never later (model §3.11).
     */
    nonconformities: (Pick<Nonconformity, 'id' | 'state' | 'reportedOn' | 'incident'> &
      ReviewFigureDays)[];
    /** The client's time zone, for `occurredAt`, as `incidentCounts` takes it. */
    timeZone: string;
  };
  AUDIT_RESULTS: {
    /** `reportStepOn`: the day of its REPORT step, null before it. Placed by the later of that and `reportedOn`. */
    internalAudits: (Pick<InternalAudit, 'id' | 'state' | 'reportedOn'> &
      ReviewFigureDays & { reportStepOn: LocalDate | null })[];
    /**
     * `heldStepOn`: the day of its RECORD_HELD step, or of a later UPDATE whose `after` names `endOn`; null before it
     * is held. Placed by the later of that and `endOn`.
     */
    externalAudits: (Pick<ExternalAudit, 'id' | 'state' | 'endOn'> &
      ReviewFigureDays & { heldStepOn: LocalDate | null })[];
    /**
     * The findings of the audits above whose clauses' standards overlap the input's (a finding with no clauses follows
     * its audit). `auditId`: the internal or external audit it belongs to. Each is placed by the later of its audit's
     * day and its own `createdOn`, whether or not its audit counts in the window.
     */
    findings: ({ id: Id; auditId: Id; type: FindingType } & ReviewFigureDays)[];
  };
  /** The instances' workflow is read as it is now, as the core score's as-of is. */
  COMPLIANCE_EVALUATION: {
    evaluations: ({
      id: Id;
      dueDate: LocalDate;
      workflowState: WorkflowState;
      completedOn: LocalDate | null;
    } & ReviewFigureDays)[];
    statutoryItems: (ScoreInput & ReviewFigureDays)[];
    settings: FirmSettings;
  };
  MANUAL: Record<string, never>;
}

/**
 * `IsoEngineApi.reviewInputFigures` typed per source: the data of the source it is called for, and no other's. M4
 * implements this shape (ISO-3b), which satisfies the 1.8.2 signature, and M0 then narrows `IsoEngineApi` to it.
 */
export type TypedReviewInputFigures = <S extends ReviewInputSource>(
  source: S,
  data: ReviewFigureData[S],
  since: LocalDate,
  asOf: LocalDate,
) => ReviewInputFigures;

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
   * One input source's figures between `since` and `asOf`, both days included, each number with the ids behind it
   * (docs/iso/model.md §5.4). The caller sets the window: `asOf` is the client-local today for a PLANNED review and the
   * review's `heldOn` when RECORD_HELD stores the figures; `since` is, for each standard of the input, the later of the
   * system's `createdOn` and the `heldOn` of the last other HELD or CLOSED review of the system covering it on or
   * before `asOf`, the earliest across the input's standards, and never after `asOf`. A HELD or CLOSED review's
   * figures are the stored copy (`ReviewInput.sourceFigures`), never computed again.
   *
   * `data` is `ReviewFigureData[source]`. The signature keeps 1.8.1's untyped `data` until M4 takes that shape
   * (ISO-3b), so ISO-3's engine still satisfies it; M0 then narrows it to `TypedReviewInputFigures` (README
   * decision 52).
   */
  reviewInputFigures(
    source: ReviewInputSource,
    data: Readonly<Record<string, unknown>>,
    since: LocalDate,
    asOf: LocalDate,
  ): ReviewInputFigures;
}

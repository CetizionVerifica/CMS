import {
  IncidentOutcome,
  IncidentType,
  type AuditChecklistItem,
  type AuditProgrammeCoverage,
  type CertificationReadiness,
  type CertificationReadinessData,
  type ClauseAssessment,
  type ClauseReadiness,
  type ClimateGap,
  type ContextItem,
  type EngineCalendar,
  type FyLabel,
  type GateResult,
  type Id,
  type IdCount,
  type IncidentCounts,
  type InternalAudit,
  type IsoClause,
  type IsoRiskRule,
  type IsoStandardCode,
  type IsoSystemInput,
  type LocalDate,
  type Nonconformity,
  type Objective,
  type ObjectiveProgress,
  type ObjectiveReading,
  type ReadinessScore,
  type RiskItem,
} from '@canopy/contracts';
import { addDays, addMonthsToDate, compareDates, daysBetween, localDateIn } from './dates.js';
import { generateInstances } from './recurrence.js';

/**
 * ISO scores and gates (docs/iso/model.md §5.1; ADR M4-0001). Every number comes with the ids behind it.
 */

/** Percentage rounded half up to one decimal, as `computeScore` rounds. */
function percent(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 1000 + 1e-9) / 10;
}

const idCount = (ids: readonly Id[]): IdCount => {
  const unique = [...new Set(ids)];
  return { count: unique.length, ids: unique };
};

/** Clause numbers in reading order: "4.2" before "4.10", "5.2" before "5.2.1". */
export function compareClauseNumbers(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

// ---------- risks ----------

/** `riskRating`: likelihood × severity on the fixed 1-5 scales, 1 to 25. */
export function riskRating(likelihood: number, severity: number): number {
  for (const value of [likelihood, severity]) {
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new RangeError(`Risk scales run 1-5, got ${value}`);
    }
  }
  return likelihood * severity;
}

/**
 * `isSignificant`: a set override wins; otherwise the rating (with existing controls) reaches `significantAt`, or the
 * rule makes a link to a statutory obligation significant.
 */
export function isSignificant(
  item: Pick<RiskItem, 'rating' | 'obligationIds' | 'significantOverride'>,
  rule: IsoRiskRule,
): boolean {
  if (item.significantOverride !== null) return item.significantOverride;
  return (
    item.rating >= rule.significantAt ||
    (rule.legalLinkMakesSignificant && item.obligationIds.length > 0)
  );
}

// ---------- clause readiness ----------

type AssessmentRow = Pick<ClauseAssessment, 'clauseId' | 'status' | 'naState'>;
type ReadinessClause = Pick<IsoClause, 'id' | 'standardId' | 'assessable' | 'exclusionAllowed'>;

function readinessOf(
  clauses: readonly ReadinessClause[],
  rowOf: ReadonlyMap<Id, AssessmentRow>,
): ReadinessScore {
  const result: ReadinessScore = {
    score: null,
    implemented: [],
    partial: [],
    notStarted: [],
    naPending: [],
    excluded: [],
  };
  for (const clause of clauses) {
    const row = rowOf.get(clause.id);
    if (row?.naState === 'APPROVED' && clause.exclusionAllowed) result.excluded.push(clause.id);
    else if (row?.naState === 'REQUESTED') result.naPending.push(clause.id);
    else if (row?.status === 'IMPLEMENTED') result.implemented.push(clause.id);
    else if (row?.status === 'PARTIAL') result.partial.push(clause.id);
    else result.notStarted.push(clause.id);
  }
  const counted =
    result.implemented.length +
    result.partial.length +
    result.notStarted.length +
    result.naPending.length;
  if (counted > 0) {
    result.score = percent(result.implemented.length + 0.5 * result.partial.length, counted);
  }
  return result;
}

/**
 * `clauseReadiness`: assessable clauses only, IMPLEMENTED 1, PARTIAL 0.5. An approved N/A on a clause that allows
 * exclusion leaves the denominator; a requested N/A counts as not started (`naPending`), and any other N/A, or a
 * clause with no row, scores 0. Per standard (in the order the clauses name them) and for the whole system.
 */
export function clauseReadiness(
  assessments: readonly AssessmentRow[],
  clauses: readonly ReadinessClause[],
): ClauseReadiness {
  const rowOf = new Map(assessments.map((a) => [a.clauseId, a]));
  const assessable = clauses.filter((c) => c.assessable);
  const standardIds = [...new Set(assessable.map((c) => c.standardId))];
  return {
    overall: readinessOf(assessable, rowOf),
    byStandard: standardIds.map((standardId) => ({
      standardId,
      ...readinessOf(
        assessable.filter((c) => c.standardId === standardId),
        rowOf,
      ),
    })),
  };
}

// ---------- audit coverage ----------

type CoverageAudit = Pick<InternalAudit, 'id' | 'state' | 'unitIds'>;
type CoverageItem = Pick<AuditChecklistItem, 'internalAuditId' | 'clauseId' | 'unitId' | 'result'>;

const REPORTED_AUDIT: readonly string[] = ['REPORTED', 'CLOSED'];

/**
 * What `audits` cover: a clause when a CONFORMS or FINDING row of a REPORTED or CLOSED audit names it (NOT_AUDITED
 * covers nothing); a unit when such a row names it, or the row has no unit and its audit lists the unit.
 */
function covered(audits: readonly CoverageAudit[], items: readonly CoverageItem[]) {
  const reported = new Map(
    audits.filter((a) => REPORTED_AUDIT.includes(a.state)).map((a) => [a.id, a.unitIds]),
  );
  const clauses = new Set<Id>();
  const units = new Set<Id>();
  for (const item of items) {
    const auditUnits = reported.get(item.internalAuditId);
    if (auditUnits === undefined || (item.result !== 'CONFORMS' && item.result !== 'FINDING')) {
      continue;
    }
    clauses.add(item.clauseId);
    for (const unit of item.unitId === null ? auditUnits : [item.unitId]) units.add(unit);
  }
  return { clauses, units };
}

/**
 * `auditProgrammeCoverage` for one FY's programme (`audits` are its audits): the assessable, not-excluded clauses and
 * the system's units its REPORTED and CLOSED audits leave uncovered, in the order given, and the "audit programme
 * progress" counts (planned = not cancelled).
 */
export function auditProgrammeCoverage(
  audits: readonly CoverageAudit[],
  checklistItems: readonly CoverageItem[],
  system: Pick<IsoSystemInput, 'unitIds'>,
  clauses: readonly (Pick<IsoClause, 'id' | 'assessable'> & { excluded: boolean })[],
  fy: FyLabel,
): AuditProgrammeCoverage {
  const done = covered(audits, checklistItems);
  return {
    fy,
    uncoveredClauseIds: clauses
      .filter((c) => c.assessable && !c.excluded && !done.clauses.has(c.id))
      .map((c) => c.id),
    uncoveredUnitIds: system.unitIds.filter((u) => !done.units.has(u)),
    planned: idCount(audits.filter((a) => a.state !== 'CANCELLED').map((a) => a.id)),
    reported: idCount(audits.filter((a) => REPORTED_AUDIT.includes(a.state)).map((a) => a.id)),
    cancelled: idCount(audits.filter((a) => a.state === 'CANCELLED').map((a) => a.id)),
  };
}

// ---------- certification readiness ----------

/** Risk kinds that meet the RISKS gate per standard (6.1). */
export const ISO_RISK_GATE_KINDS: Readonly<Record<IsoStandardCode, readonly RiskItem['kind'][]>> = {
  ISO_9001: ['RISK', 'OPPORTUNITY'],
  ISO_14001: ['ASPECT'],
  ISO_45001: ['HAZARD'],
};

export const NO_REVIEW_IN_WINDOW =
  'No management review held in the 12 months up to the as-of date';
export const NO_OBJECTIVE = 'No objective for this standard';

const gate = (name: GateResult['gate'], missing: string[]): GateResult => ({
  gate: name,
  met: missing.length === 0,
  missing,
});

const HELD_REVIEW: readonly string[] = ['HELD', 'CLOSED'];

/**
 * `certificationReadiness`: per standard of the system, the stage-1 gates from its records. The window is the 12
 * months up to `asOf`: after `asOf` − 12 months, up to and including `asOf`.
 */
export function certificationReadiness(
  system: IsoSystemInput,
  data: CertificationReadinessData,
  asOf: LocalDate,
): CertificationReadiness {
  const yearAgo = addMonthsToDate(asOf, -12);
  const within = (date: LocalDate | null) =>
    date !== null && compareDates(date, yearAgo) > 0 && compareDates(date, asOf) <= 0;
  const approvedNa = new Set(
    data.assessments.filter((a) => a.naState === 'APPROVED').map((a) => a.clauseId),
  );
  const done = covered(
    data.audits.filter((a) => within(a.reportedOn)),
    data.checklistItems,
  );
  const liveRisks = data.riskItems.filter((r) => r.archivedAt === null);
  const planned = new Set(
    data.objectiveActions
      .filter((a) => a.subject.type === 'OBJECTIVE' && a.state !== 'CANCELLED')
      .map((a) => a.subject.id),
  );
  const standards = system.standardIds
    .map((id) => data.standards.find((s) => s.id === id))
    .filter((s) => s !== undefined);

  return {
    standards: standards.map((standard) => {
      const clauses = data.clauses
        .filter((c) => c.standardId === standard.id)
        .sort((a, b) => compareClauseNumbers(a.number, b.number));

      const auditGate = gate('INTERNAL_AUDIT', [
        ...clauses
          .filter(
            (c) =>
              c.assessable &&
              !(c.exclusionAllowed && approvedNa.has(c.id)) &&
              !done.clauses.has(c.id),
          )
          .map((c) => c.number),
        ...system.unitIds.filter((u) => !done.units.has(u)),
      ]);

      const reviews = data.reviews
        .filter(
          (r) =>
            HELD_REVIEW.includes(r.state) &&
            within(r.heldOn) &&
            r.standards.includes(standard.code),
        )
        .sort((a, b) => compareDates(b.heldOn!, a.heldOn!));
      const unnoted = (reviewId: Id) =>
        data.reviewInputs
          .filter(
            (i) =>
              i.managementReviewId === reviewId &&
              i.standard === standard.code &&
              (i.notes === null || i.notes.trim() === ''),
          )
          .map((i) => i.key);
      const reviewGate = gate(
        'MANAGEMENT_REVIEW',
        reviews.length === 0
          ? [NO_REVIEW_IN_WINDOW]
          : reviews.some((r) => unnoted(r.id).length === 0)
            ? []
            : unnoted(reviews[0]!.id),
      );

      const scopeGate = gate('SCOPE', [
        ...(system.scopeStatement === null || system.scopeStatement.trim() === ''
          ? ['scopeStatement']
          : []),
        ...(system.unitIds.length === 0 ? ['unitIds'] : []),
      ]);

      // Clause 5.2 or a sub-clause of it (ISO 9001 splits it into 5.2.1 and 5.2.2).
      const policyClauses = new Set(
        clauses.filter((c) => c.number === '5.2' || c.number.startsWith('5.2.')).map((c) => c.id),
      );
      const policyGate = gate(
        'POLICY',
        data.documents.some(
          (d) =>
            d.type === 'POLICY' &&
            d.status === 'ACTIVE' &&
            d.currentRevisionId !== null &&
            d.clauseIds.some((id) => policyClauses.has(id)),
        )
          ? []
          : ['5.2'],
      );

      const objectives = data.objectives.filter((o) => o.standards.includes(standard.code));
      const objectivesGate = gate(
        'OBJECTIVES',
        objectives.length === 0
          ? [NO_OBJECTIVE]
          : objectives.filter((o) => o.closedOn === null && !planned.has(o.id)).map((o) => o.id),
      );

      const kinds = ISO_RISK_GATE_KINDS[standard.code];
      const risksGate = gate(
        'RISKS',
        liveRisks.some((r) => kinds.includes(r.kind)) ? [] : [...kinds],
      );

      const gates = [auditGate, reviewGate, scopeGate, policyGate, objectivesGate, risksGate];
      return { standardId: standard.id, gates, ready: gates.every((g) => g.met) };
    }),
  };
}

// ---------- objectives ----------

type ObjectiveFields = Pick<
  Objective,
  'id' | 'target' | 'baseline' | 'direction' | 'readingRule' | 'dueOn'
> & {
  /** The objective's `createdAt` as a date in the client's time zone (`localDateIn`). */
  createdOn: LocalDate;
};
type Reading = Pick<ObjectiveReading, 'periodStart' | 'periodEnd' | 'value'>;

const DEFAULT_FY: Pick<EngineCalendar, 'fyStartMonth'> = { fyStartMonth: 4 };

/** Whether `value` meets the target in the objective's direction (MAINTAIN: equal to it). */
function meets(objective: ObjectiveFields, value: number): boolean {
  if (objective.direction === 'INCREASE') return value >= objective.target;
  if (objective.direction === 'DECREASE') return value <= objective.target;
  return Math.abs(value - objective.target) <= 1e-9 * Math.max(1, Math.abs(objective.target));
}

/**
 * `objectiveProgress`. The latest reading is the one with the latest `periodEnd` on or before `asOf` (pass a closed
 * objective's `closedOn` as `asOf` to measure it as it closed).
 * - `progressPercent`: the share of the way from baseline to target, 0-100; MAINTAIN, or a target equal to the
 *   baseline, is 100 when the reading meets the target, else 0; null without a baseline or a reading.
 * - `onTrack`: with a baseline, INCREASE and DECREASE compare the reading with the straight line from the baseline on
 *   `createdOn` to the target on `dueOn`, at the reading's `periodEnd`; without one, and for MAINTAIN, the reading
 *   must meet the target. Null without a reading.
 * - `missedReadings`: periods of `readingRule` that ended on or after `createdOn`, start by `dueOn`, fell due before
 *   `asOf`, and that no reading overlaps. `cal` gives the client's FY start for quarter and half-year rules.
 */
export function objectiveProgress(
  readings: readonly Reading[],
  objective: ObjectiveFields,
  asOf: LocalDate,
  cal: Pick<EngineCalendar, 'fyStartMonth'> = DEFAULT_FY,
): ObjectiveProgress {
  const latest = readings
    .filter((r) => compareDates(r.periodEnd, asOf) <= 0)
    .sort(
      (a, b) =>
        compareDates(a.periodEnd, b.periodEnd) || compareDates(a.periodStart, b.periodStart),
    )
    .at(-1);
  const { baseline, target, createdOn } = objective;

  let progressPercent: number | null = null;
  let onTrack: boolean | null = null;
  if (latest !== undefined) {
    const met = meets(objective, latest.value);
    if (baseline !== null) {
      progressPercent =
        objective.direction === 'MAINTAIN' || target === baseline
          ? met
            ? 100
            : 0
          : Math.min(100, Math.max(0, percent(latest.value - baseline, target - baseline)));
    }
    if (baseline === null || objective.direction === 'MAINTAIN') {
      onTrack = met;
    } else {
      const span = daysBetween(createdOn, objective.dueOn);
      const share =
        span <= 0 ? 1 : Math.min(1, Math.max(0, daysBetween(createdOn, latest.periodEnd) / span));
      const expected = baseline + (target - baseline) * share;
      onTrack =
        objective.direction === 'INCREASE' ? latest.value >= expected : latest.value <= expected;
    }
  }

  const lastDue = addDays(asOf, -1);
  const periods =
    compareDates(createdOn, lastDue) <= 0
      ? generateInstances(
          objective.readingRule,
          { from: createdOn, to: lastDue },
          // Reading periods never move for holidays.
          { fyStartMonth: cal.fyStartMonth, holidayPolicy: 'NONE' },
        )
      : [];
  const missedReadings = periods
    .filter(
      (p) =>
        compareDates(p.periodEnd, createdOn) >= 0 &&
        compareDates(p.periodStart, objective.dueOn) <= 0 &&
        !readings.some(
          (r) =>
            compareDates(r.periodStart, p.periodEnd) <= 0 &&
            compareDates(r.periodEnd, p.periodStart) >= 0,
        ),
    )
    .map((p) => ({ periodStart: p.periodStart, periodEnd: p.periodEnd }));

  return {
    objectiveId: objective.id,
    latestValue: latest?.value ?? null,
    latestPeriodEnd: latest?.periodEnd ?? null,
    progressPercent,
    onTrack,
    missedReadings,
  };
}

// ---------- incidents and climate ----------

/**
 * `incidentCounts`: incident NCs whose `occurredAt` falls in `period` (both days included) by its date in `timeZone`,
 * in total, by every type and by every outcome (zeros included). The caller leaves cancelled NCs out.
 */
export function incidentCounts(
  ncs: readonly Pick<Nonconformity, 'id' | 'incident'>[],
  period: { from: LocalDate; to: LocalDate },
  timeZone: string,
): IncidentCounts {
  const inPeriod = ncs.flatMap((n) => {
    if (n.incident === null) return [];
    const on = localDateIn(n.incident.occurredAt, timeZone);
    return compareDates(on, period.from) >= 0 && compareDates(on, period.to) <= 0
      ? [{ id: n.id, incident: n.incident }]
      : [];
  });
  return {
    from: period.from,
    to: period.to,
    total: idCount(inPeriod.map((n) => n.id)),
    byType: IncidentType.options.map((type) => ({
      type,
      ...idCount(inPeriod.filter((n) => n.incident.type === type).map((n) => n.id)),
    })),
    byOutcome: IncidentOutcome.options.map((outcome) => ({
      outcome,
      ...idCount(inPeriod.filter((n) => n.incident.outcome === outcome).map((n) => n.id)),
    })),
  };
}

/**
 * `climateDeterminationGaps` (Amd 1:2024 to clause 4.1): UNDECIDED while the decision is null; when relevant,
 * RELEVANT_NO_RISK without a live climate-related risk item of any kind and RELEVANT_NO_ISSUE without a live
 * climate-related context item.
 */
export function climateDeterminationGaps(
  system: Pick<IsoSystemInput, 'climateChangeRelevant'>,
  contextItems: readonly Pick<ContextItem, 'climateRelated' | 'archivedAt'>[],
  riskItems: readonly Pick<RiskItem, 'climateRelated' | 'archivedAt'>[],
): ClimateGap[] {
  if (system.climateChangeRelevant === null) return ['UNDECIDED'];
  if (!system.climateChangeRelevant) return [];
  const live = (r: { climateRelated: boolean; archivedAt: string | null }) =>
    r.climateRelated && r.archivedAt === null;
  const gaps: ClimateGap[] = [];
  if (!riskItems.some(live)) gaps.push('RELEVANT_NO_RISK');
  if (!contextItems.some(live)) gaps.push('RELEVANT_NO_ISSUE');
  return gaps;
}

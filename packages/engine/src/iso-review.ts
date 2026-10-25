import {
  FindingType,
  NcSeverity,
  NcSource,
  type ContextItem,
  type EngineCalendar,
  type ExternalAudit,
  type FirmSettings,
  type Id,
  type InternalAudit,
  type IsoAction,
  type LocalDate,
  type ManagementSystem,
  type Nonconformity,
  type Objective,
  type ObjectiveReading,
  type ReviewFigure,
  type ReviewInputFigures,
  type ReviewInputSource,
  type RiskItem,
  type ScoreInput,
  type WorkflowState,
} from '@canopy/contracts';
import { compareDates } from './dates.js';
import { incidentCounts, objectiveProgress } from './iso-score.js';
import { computeScore } from './score.js';

/**
 * Management review input figures (docs/iso/model.md §5.4; ADR M4-0001). The caller passes, per source, the records of
 * the review's system that the source reads, already narrowed to what the reader may see and to the input's
 * standards, with every timestamp turned into a client-local date by `localDateIn`. The engine counts them between
 * `since` and `asOf`, both days included.
 */

type Day = LocalDate;

/** PREVIOUS_ACTIONS: the actions of earlier held reviews of the input's standards. */
export type PreviousActionsData = {
  actions: Pick<IsoAction, 'id' | 'state' | 'dueOn'>[];
};

/** CONTEXT: the system's context items, archived ones included, and its climate decision. */
export type ContextData = {
  contextItems: (Pick<ContextItem, 'id' | 'kind'> & {
    createdOn: Day;
    updatedOn: Day;
    archivedOn: Day | null;
  })[];
  system: Pick<ManagementSystem, 'id' | 'climateChangeRelevant' | 'climateDecidedOn'>;
};

/** RISKS: live risk items, the days a rating field changed (from the audit trail), and treatment actions. */
export type RisksData = {
  riskItems: (Pick<RiskItem, 'id' | 'kind' | 'significant'> & { createdOn: Day })[];
  ratingChanges: { riskItemId: Id; on: Day }[];
  treatmentActions: Pick<IsoAction, 'id' | 'state' | 'doneOn'>[];
};

/** OBJECTIVES: the input standards' objectives with their readings. */
export type ObjectivesData = {
  objectives: (Pick<
    Objective,
    'id' | 'target' | 'baseline' | 'direction' | 'readingRule' | 'dueOn' | 'closedOn' | 'outcome'
  > & {
    createdOn: Day;
    readings: (Pick<ObjectiveReading, 'id' | 'periodStart' | 'periodEnd' | 'value'> & {
      recordedOn: Day;
    })[];
  })[];
  calendar?: EngineCalendar;
};

/** NONCONFORMITIES: the input standards' NCs, their VERIFY_NOT_EFFECTIVE steps and their corrective actions. */
export type NonconformitiesData = {
  nonconformities: Pick<
    Nonconformity,
    'id' | 'state' | 'severity' | 'source' | 'reportedOn' | 'closedOn'
  >[];
  notEffectiveSteps: { nonconformityId: Id; on: Day }[];
  correctiveActions: Pick<IsoAction, 'id' | 'state' | 'dueOn'>[];
};

/** INCIDENTS: the input standards' incident NCs (not cancelled) and the client's time zone. */
export type IncidentsData = {
  nonconformities: Pick<Nonconformity, 'id' | 'incident'>[];
  timeZone: string;
};

/** AUDIT_RESULTS: the system's internal and external audits and their findings. */
export type AuditResultsData = {
  internalAudits: Pick<InternalAudit, 'id' | 'state' | 'reportedOn'>[];
  externalAudits: Pick<ExternalAudit, 'id' | 'state' | 'endOn'>[];
  findings: { id: Id; auditId: Id; type: FindingType }[];
};

/** COMPLIANCE_EVALUATION: the evaluation activity's instances on the system's units, and its STATUTE instances. */
export type ComplianceEvaluationData = {
  evaluations: {
    id: Id;
    dueDate: Day;
    workflowState: WorkflowState;
    completedOn: Day | null;
  }[];
  statutoryItems: ScoreInput[];
  settings: FirmSettings;
};

export type ReviewFigureData =
  | PreviousActionsData
  | ContextData
  | RisksData
  | ObjectivesData
  | NonconformitiesData
  | IncidentsData
  | AuditResultsData
  | ComplianceEvaluationData
  | Record<string, never>;

interface Window {
  since: Day;
  asOf: Day;
}

const within = (w: Window, date: Day | null): boolean =>
  date !== null && compareDates(date, w.since) >= 0 && compareDates(date, w.asOf) <= 0;

const figure = (key: string, ids: readonly Id[]): ReviewFigure => ({
  key,
  value: ids.length,
  ids: [...ids],
});

const ids = (rows: readonly { id: Id }[]): Id[] => rows.map((r) => r.id);

/** `prefix` and an enum value as one camelCase key: ('raised', 'INTERNAL_AUDIT') is 'raisedInternalAudit'. */
export function figureKey(prefix: string, value: string): string {
  return (
    prefix +
    value
      .toLowerCase()
      .replace(/(^|_)([a-z0-9])/g, (_m, _sep: string, c: string) => c.toUpperCase())
  );
}

function previousActions(d: PreviousActionsData, w: Window): ReviewFigure[] {
  const open = d.actions.filter((a) => a.state === 'OPEN');
  return [
    figure('actionsOpen', ids(open)),
    figure('actionsOverdue', ids(open.filter((a) => compareDates(a.dueOn, w.asOf) < 0))),
    figure('actionsDone', ids(d.actions.filter((a) => a.state === 'DONE'))),
    figure('actionsCancelled', ids(d.actions.filter((a) => a.state === 'CANCELLED'))),
  ];
}

function context(d: ContextData, w: Window): ReviewFigure[] {
  const live = d.contextItems.filter((c) => c.archivedOn === null);
  const added = live.filter((c) => within(w, c.createdOn));
  const changed = live.filter((c) => !added.includes(c) && within(w, c.updatedOn));
  const party = (c: { kind: string }) => c.kind === 'INTERESTED_PARTY';
  const { system } = d;
  return [
    figure('issuesAdded', ids(added.filter((c) => !party(c)))),
    figure('issuesChanged', ids(changed.filter((c) => !party(c)))),
    figure('interestedPartiesAdded', ids(added.filter(party))),
    figure('interestedPartiesChanged', ids(changed.filter(party))),
    figure('contextItemsRemoved', ids(d.contextItems.filter((c) => within(w, c.archivedOn)))),
    figure('climateDecided', system.climateChangeRelevant === null ? [] : [system.id]),
    figure('climateRelevant', system.climateChangeRelevant === true ? [system.id] : []),
    figure('climateDecidedInPeriod', within(w, system.climateDecidedOn) ? [system.id] : []),
  ];
}

function risks(d: RisksData, w: Window): ReviewFigure[] {
  const added = d.riskItems.filter((i) => within(w, i.createdOn));
  const rerated = new Set(d.ratingChanges.filter((c) => within(w, c.on)).map((c) => c.riskItemId));
  const significant = d.riskItems.filter((i) => i.significant);
  return [
    figure('itemsAdded', ids(added)),
    figure('itemsRerated', ids(d.riskItems.filter((i) => !added.includes(i) && rerated.has(i.id)))),
    ...(['RISK', 'OPPORTUNITY', 'ASPECT', 'HAZARD'] as const).map((kind) =>
      figure(figureKey('significant', kind), ids(significant.filter((i) => i.kind === kind))),
    ),
    figure(
      'treatmentActionsDone',
      ids(d.treatmentActions.filter((a) => a.state === 'DONE' && within(w, a.doneOn))),
    ),
    figure('treatmentActionsOpen', ids(d.treatmentActions.filter((a) => a.state === 'OPEN'))),
  ];
}

function objectives(d: ObjectivesData, w: Window): ReviewFigure[] {
  const open = d.objectives.filter((o) => o.closedOn === null);
  const track = new Map(
    open.map((o) => [o.id, objectiveProgress(o.readings, o, w.asOf, d.calendar).onTrack]),
  );
  const closed = d.objectives.filter((o) => within(w, o.closedOn));
  const recorded = d.objectives.flatMap((o) =>
    o.readings.filter((r) => compareDates(r.periodEnd, w.asOf) <= 0 && within(w, r.recordedOn)),
  );
  return [
    figure('objectivesOpen', ids(open)),
    figure('onTrack', ids(open.filter((o) => track.get(o.id) === true))),
    figure('offTrack', ids(open.filter((o) => track.get(o.id) === false))),
    figure('withoutReading', ids(open.filter((o) => track.get(o.id) === null))),
    figure('achieved', ids(closed.filter((o) => o.outcome === 'ACHIEVED'))),
    figure('notAchieved', ids(closed.filter((o) => o.outcome === 'NOT_ACHIEVED'))),
    figure('readingsRecorded', ids(recorded)),
  ];
}

function nonconformities(d: NonconformitiesData, w: Window): ReviewFigure[] {
  const raised = d.nonconformities.filter((n) => within(w, n.reportedOn));
  const closed = d.nonconformities.filter((n) => within(w, n.closedOn));
  const notEffective = d.notEffectiveSteps.filter((s) => within(w, s.on));
  const by = (prefix: string, rows: typeof raised) => [
    ...NcSeverity.options.map((s) =>
      figure(figureKey(prefix, s), ids(rows.filter((n) => n.severity === s))),
    ),
    ...NcSource.options.map((s) =>
      figure(figureKey(prefix, s), ids(rows.filter((n) => n.source === s))),
    ),
  ];
  return [
    figure('raised', ids(raised)),
    figure('closed', ids(closed)),
    ...by('raised', raised),
    ...by('closed', closed),
    {
      key: 'verifiedNotEffective',
      value: notEffective.length,
      ids: [...new Set(notEffective.map((s) => s.nonconformityId))],
    },
    figure(
      'open',
      ids(d.nonconformities.filter((n) => n.state !== 'CLOSED' && n.state !== 'CANCELLED')),
    ),
    figure(
      'correctiveActionsOverdue',
      ids(
        d.correctiveActions.filter((a) => a.state === 'OPEN' && compareDates(a.dueOn, w.asOf) < 0),
      ),
    ),
  ];
}

function incidents(d: IncidentsData, w: Window): ReviewFigure[] {
  const counts = incidentCounts(d.nonconformities, { from: w.since, to: w.asOf }, d.timeZone);
  const counted = new Set(counts.total.ids);
  const lostTime = d.nonconformities.filter(
    (n) => counted.has(n.id) && n.incident?.lostDays != null,
  );
  return [
    { key: 'incidents', value: counts.total.count, ids: counts.total.ids },
    ...counts.byType.map((t) => ({
      key: figureKey('type', t.type),
      value: t.count,
      ids: t.ids,
    })),
    ...counts.byOutcome.map((o) => ({
      key: figureKey('outcome', o.outcome),
      value: o.count,
      ids: o.ids,
    })),
    {
      key: 'lostDays',
      value: lostTime.reduce((sum, n) => sum + n.incident!.lostDays!, 0),
      ids: ids(lostTime),
    },
  ];
}

const TOOK_PLACE: readonly string[] = ['HELD', 'RESPONDED', 'CLOSED'];

function auditResults(d: AuditResultsData, w: Window): ReviewFigure[] {
  const internal = d.internalAudits.filter(
    (a) => (a.state === 'REPORTED' || a.state === 'CLOSED') && within(w, a.reportedOn),
  );
  const external = d.externalAudits.filter(
    (a) => TOOK_PLACE.includes(a.state) && within(w, a.endOn),
  );
  const auditIds = new Set([...ids(internal), ...ids(external)]);
  const findings = d.findings.filter((f) => auditIds.has(f.auditId));
  return [
    figure('internalAuditsReported', ids(internal)),
    figure('externalAuditsHeld', ids(external)),
    ...FindingType.options.map((t) =>
      figure(figureKey('findings', t), ids(findings.filter((f) => f.type === t))),
    ),
  ];
}

function complianceEvaluation(d: ComplianceEvaluationData, w: Window): ReviewFigure[] {
  const latest = d.evaluations
    .filter((i) => compareDates(i.dueDate, w.asOf) <= 0)
    .sort((a, b) => compareDates(b.dueDate, a.dueDate))[0];
  const statutory = d.statutoryItems.filter((i) => within(w, i.dueDate));
  const { score } = computeScore(statutory, w.asOf, d.settings);
  return [
    figure('evaluationsDue', ids(d.evaluations.filter((i) => within(w, i.dueDate)))),
    figure(
      'evaluationsDone',
      ids(d.evaluations.filter((i) => i.workflowState === 'APPROVED' && within(w, i.completedOn))),
    ),
    figure('latestEvaluation', latest === undefined ? [] : [latest.id]),
    figure(
      'statutoryInstancesDue',
      statutory.map((i) => i.instanceId),
    ),
    ...(score === null ? [] : [{ key: 'statutoryScore', value: score, ids: [] }]),
  ];
}

function figuresOf(source: ReviewInputSource, data: ReviewFigureData, w: Window): ReviewFigure[] {
  switch (source) {
    case 'PREVIOUS_ACTIONS':
      return previousActions(data as PreviousActionsData, w);
    case 'CONTEXT':
      return context(data as ContextData, w);
    case 'RISKS':
      return risks(data as RisksData, w);
    case 'OBJECTIVES':
      return objectives(data as ObjectivesData, w);
    case 'NONCONFORMITIES':
      return nonconformities(data as NonconformitiesData, w);
    case 'INCIDENTS':
      return incidents(data as IncidentsData, w);
    case 'AUDIT_RESULTS':
      return auditResults(data as AuditResultsData, w);
    case 'COMPLIANCE_EVALUATION':
      return complianceEvaluation(data as ComplianceEvaluationData, w);
    case 'MANUAL':
      return [];
  }
}

/**
 * `reviewInputFigures`: one input source's figures between `since` (the last held review covering the input's
 * standards, or the system's `createdOn`) and `asOf`. `data` has the shape named for the source above; MANUAL has
 * none and gets no figures.
 */
export function reviewInputFigures(
  source: ReviewInputSource,
  data: ReviewFigureData,
  since: LocalDate,
  asOf: LocalDate,
): ReviewInputFigures {
  if (compareDates(since, asOf) > 0) {
    throw new RangeError(`since is after asOf: ${since} > ${asOf}`);
  }
  return { source, since, asOf, figures: figuresOf(source, data, { since, asOf }) };
}

import { DEFAULT_FIRM_SETTINGS, ReviewInputFigures, type FirmSettings } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import {
  asLocalDate as d,
  figureKey,
  reviewInputFigures,
  type AuditResultsData,
  type ComplianceEvaluationData,
  type ContextData,
  type IncidentsData,
  type NonconformitiesData,
  type ObjectivesData,
  type PreviousActionsData,
  type ReviewFigureData,
  type RisksData,
} from '../src/index.js';
import { u } from './iso-ids.js';

// A system created on 2025-04-01 whose first review is held on 2026-03-31: `since` is its creation day.
const since = '2025-04-01';
const asOf = '2026-03-31';

function figures(
  source: Parameters<typeof reviewInputFigures>[0],
  data: ReviewFigureData,
  from = since,
  to = asOf,
) {
  const result = ReviewInputFigures.parse(reviewInputFigures(source, data, d(from), d(to)));
  expect(result).toMatchObject({ source, since: from, asOf: to });
  return Object.fromEntries(result.figures.map((f) => [f.key, f.ids.length > 0 ? f.ids : f.value]));
}

describe('reviewInputFigures (model §5.4)', () => {
  it('figureKey joins a prefix and an enum value in camelCase', () => {
    expect(figureKey('raised', 'INTERNAL_AUDIT')).toBe('raisedInternalAudit');
    expect(figureKey('findings', 'MAJOR_NC')).toBe('findingsMajorNc');
  });

  it('refuses a since after as-of; MANUAL has no figures', () => {
    expect(() => reviewInputFigures('MANUAL', {}, d('2026-04-01'), d(asOf))).toThrow(RangeError);
    expect(reviewInputFigures('MANUAL', {}, d(since), d(asOf))).toEqual({
      source: 'MANUAL',
      since,
      asOf,
      figures: [],
    });
  });

  it('PREVIOUS_ACTIONS: by state, and the open ones past due', () => {
    const data: PreviousActionsData = {
      actions: [
        { id: u('a-open'), state: 'OPEN', dueOn: d('2026-03-30') },
        { id: u('a-open-today'), state: 'OPEN', dueOn: d(asOf) },
        { id: u('a-done'), state: 'DONE', dueOn: d('2026-01-31') },
        { id: u('a-cancelled'), state: 'CANCELLED', dueOn: d('2025-12-31') },
      ],
    };
    expect(figures('PREVIOUS_ACTIONS', data)).toEqual({
      actionsOpen: [u('a-open'), u('a-open-today')],
      actionsOverdue: [u('a-open')],
      actionsDone: [u('a-done')],
      actionsCancelled: [u('a-cancelled')],
    });
  });

  it('CONTEXT: added, changed and removed in the window, and the climate decision', () => {
    const item = (
      name: string,
      kind: string,
      createdOn: string,
      updatedOn: string,
      archivedOn: string | null = null,
    ) => ({
      id: u(name),
      kind: kind as 'INTERNAL_ISSUE',
      createdOn: d(createdOn),
      updatedOn: d(updatedOn),
      archivedOn: archivedOn === null ? null : d(archivedOn),
    });
    const data: ContextData = {
      contextItems: [
        item('c-new', 'EXTERNAL_ISSUE', '2025-04-01', '2025-06-01'),
        item('c-old-changed', 'INTERNAL_ISSUE', '2025-03-31', '2026-03-31'),
        item('c-old', 'INTERNAL_ISSUE', '2024-01-01', '2025-03-31'),
        item('p-new', 'INTERESTED_PARTY', '2026-02-28', '2026-02-28'),
        item('p-changed', 'INTERESTED_PARTY', '2024-02-29', '2025-09-01'),
        item('c-removed', 'INTERNAL_ISSUE', '2024-01-01', '2025-05-01', '2025-05-01'),
        item('c-removed-before', 'INTERNAL_ISSUE', '2024-01-01', '2025-03-31', '2025-03-31'),
      ],
      system: { id: u('system'), climateChangeRelevant: true, climateDecidedOn: d('2025-05-15') },
    };
    expect(figures('CONTEXT', data)).toEqual({
      issuesAdded: [u('c-new')],
      issuesChanged: [u('c-old-changed')],
      interestedPartiesAdded: [u('p-new')],
      interestedPartiesChanged: [u('p-changed')],
      contextItemsRemoved: [u('c-removed')],
      climateDecided: [u('system')],
      climateRelevant: [u('system')],
      climateDecidedInPeriod: [u('system')],
    });
    const undecided = {
      ...data,
      system: { id: u('system'), climateChangeRelevant: null, climateDecidedOn: null },
    };
    expect(figures('CONTEXT', undecided)).toMatchObject({
      climateDecided: 0,
      climateRelevant: 0,
      climateDecidedInPeriod: 0,
    });
    const notRelevant = {
      ...data,
      system: { id: u('system'), climateChangeRelevant: false, climateDecidedOn: d('2024-12-01') },
    };
    expect(figures('CONTEXT', notRelevant)).toMatchObject({
      climateDecided: [u('system')],
      climateRelevant: 0,
      climateDecidedInPeriod: 0,
    });
  });

  it('RISKS: added or re-rated in the window, significant by kind, treatment actions done in it and open', () => {
    const data: RisksData = {
      riskItems: [
        { id: u('r-new'), kind: 'HAZARD', significant: true, createdOn: d('2025-10-01') },
        { id: u('r-rerated'), kind: 'ASPECT', significant: true, createdOn: d('2024-10-01') },
        { id: u('r-old'), kind: 'RISK', significant: false, createdOn: d('2024-10-01') },
      ],
      ratingChanges: [
        { riskItemId: u('r-rerated'), on: d('2026-01-15') },
        { riskItemId: u('r-new'), on: d('2026-01-15') },
        { riskItemId: u('r-old'), on: d('2025-03-31') },
      ],
      treatmentActions: [
        { id: u('t-done'), state: 'DONE', doneOn: d('2025-12-01') },
        { id: u('t-done-before'), state: 'DONE', doneOn: d('2025-03-01') },
        { id: u('t-open'), state: 'OPEN', doneOn: null },
      ],
    };
    expect(figures('RISKS', data)).toEqual({
      itemsAdded: [u('r-new')],
      itemsRerated: [u('r-rerated')],
      significantRisk: 0,
      significantOpportunity: 0,
      significantAspect: [u('r-rerated')],
      significantHazard: [u('r-new')],
      treatmentActionsDone: [u('t-done')],
      treatmentActionsOpen: [u('t-open')],
    });
  });

  it('OBJECTIVES: open ones by objectiveProgress, closed in the window by outcome, readings recorded', () => {
    const objective = (name: string, over: Partial<ObjectivesData['objectives'][number]> = {}) => ({
      id: u(name),
      target: 10,
      baseline: null,
      direction: 'DECREASE' as const,
      readingRule: { kind: 'ONGOING_REVIEW' as const, every: 'QUARTER' as const },
      dueOn: d('2026-03-31'),
      closedOn: null,
      outcome: null,
      createdOn: d('2025-04-01'),
      readings: [],
      ...over,
    });
    const reading = (name: string, periodEnd: string, value: number, recordedOn: string) => ({
      id: u(name),
      periodStart: d('2025-04-01'),
      periodEnd: d(periodEnd),
      value,
      recordedOn: d(recordedOn),
    });
    const data: ObjectivesData = {
      objectives: [
        objective('o-on', { readings: [reading('rd-1', '2025-06-30', 8, '2025-07-02')] }),
        objective('o-off', { readings: [reading('rd-2', '2025-06-30', 12, '2025-03-31')] }),
        objective('o-none', { readings: [reading('rd-future', '2026-06-30', 1, '2026-03-31')] }),
        objective('o-met', { closedOn: d('2026-03-31'), outcome: 'ACHIEVED' }),
        objective('o-missed', { closedOn: d('2025-06-30'), outcome: 'NOT_ACHIEVED' }),
        objective('o-closed-before', { closedOn: d('2025-03-31'), outcome: 'ACHIEVED' }),
      ],
      calendar: { fyStartMonth: 4, holidayPolicy: 'NONE' },
    };
    expect(figures('OBJECTIVES', data)).toEqual({
      objectivesOpen: [u('o-on'), u('o-off'), u('o-none')],
      onTrack: [u('o-on')],
      offTrack: [u('o-off')],
      withoutReading: [u('o-none')],
      achieved: [u('o-met')],
      notAchieved: [u('o-missed')],
      readingsRecorded: [u('rd-1')],
    });
    expect(figures('OBJECTIVES', { objectives: [] })).toMatchObject({ objectivesOpen: 0 });
  });

  it('NONCONFORMITIES: raised and closed by severity and source, not-effective steps, open ones and overdue actions', () => {
    const nc = (name: string, over: Partial<NonconformitiesData['nonconformities'][number]>) => ({
      id: u(name),
      state: 'OPEN' as const,
      severity: 'MINOR' as const,
      source: 'PROCESS' as const,
      reportedOn: d('2025-06-01'),
      closedOn: null,
      ...over,
    });
    const data: NonconformitiesData = {
      nonconformities: [
        nc('nc-open', {}),
        nc('nc-closed', {
          state: 'CLOSED',
          severity: 'MAJOR',
          source: 'INTERNAL_AUDIT',
          reportedOn: d('2025-03-01'),
          closedOn: d('2025-04-01'),
        }),
        nc('nc-cancelled', { state: 'CANCELLED', reportedOn: d('2025-02-01') }),
      ],
      notEffectiveSteps: [
        { nonconformityId: u('nc-open'), on: d('2025-08-01') },
        { nonconformityId: u('nc-open'), on: d('2025-10-01') },
        { nonconformityId: u('nc-closed'), on: d('2025-03-15') },
      ],
      correctiveActions: [
        { id: u('ca-late'), state: 'OPEN', dueOn: d('2026-03-30') },
        { id: u('ca-done'), state: 'DONE', dueOn: d('2025-07-01') },
        { id: u('ca-today'), state: 'OPEN', dueOn: d(asOf) },
      ],
    };
    const result = figures('NONCONFORMITIES', data);
    expect(result).toMatchObject({
      raised: [u('nc-open')],
      closed: [u('nc-closed')],
      raisedMinor: [u('nc-open')],
      raisedMajor: 0,
      raisedProcess: [u('nc-open')],
      closedMajor: [u('nc-closed')],
      closedInternalAudit: [u('nc-closed')],
      verifiedNotEffective: [u('nc-open')],
      open: [u('nc-open')],
      correctiveActionsOverdue: [u('ca-late')],
    });
    // Two steps on one NC count twice; the ids list it once.
    const steps = reviewInputFigures('NONCONFORMITIES', data, d(since), d(asOf)).figures.find(
      (f) => f.key === 'verifiedNotEffective',
    );
    expect(steps).toEqual({ key: 'verifiedNotEffective', value: 2, ids: [u('nc-open')] });
    expect(Object.keys(result)).toHaveLength(2 + 2 * (2 + 8) + 3);
  });

  it('INCIDENTS: incidentCounts over the window by the client-local day, and lost days', () => {
    const incident = (occurredAt: string, outcome: string, lostDays: number | null) => ({
      occurredAt,
      location: 'Yard',
      type: 'INJURY' as const,
      outcome: outcome as 'LOST_TIME',
      personCategory: 'EMPLOYEE' as const,
      lostDays,
      reportable: lostDays !== null,
      statutoryInstanceId: null,
      investigatorIds: [],
      workerParticipation: true,
    });
    const data: IncidentsData = {
      nonconformities: [
        { id: u('i-lost'), incident: incident('2025-12-01T05:00:00Z', 'LOST_TIME', 4) },
        { id: u('i-aid'), incident: incident('2026-03-31T18:00:00Z', 'FIRST_AID', null) },
        { id: u('i-before'), incident: incident('2025-03-31T17:00:00Z', 'LOST_TIME', 9) },
        { id: u('i-none'), incident: null },
      ],
      timeZone: 'Asia/Kolkata',
    };
    const result = figures('INCIDENTS', data);
    expect(result).toMatchObject({
      // 22:30 on 31 March 2025 in Kolkata is before the window; 23:30 on 31 March 2026 is its last day.
      incidents: [u('i-lost'), u('i-aid')],
      typeInjury: [u('i-lost'), u('i-aid')],
      typeNearMiss: 0,
      outcomeLostTime: [u('i-lost')],
      outcomeFirstAid: [u('i-aid')],
      lostDays: [u('i-lost')],
    });
    const lost = reviewInputFigures('INCIDENTS', data, d(since), d(asOf)).figures.find(
      (f) => f.key === 'lostDays',
    );
    expect(lost!.value).toBe(4);
  });

  it('AUDIT_RESULTS: internal audits reported and external audits held in the window, their findings by type', () => {
    const data: AuditResultsData = {
      internalAudits: [
        { id: u('ia-reported'), state: 'REPORTED', reportedOn: d('2025-09-30') },
        { id: u('ia-closed-before'), state: 'CLOSED', reportedOn: d('2025-03-31') },
        { id: u('ia-running'), state: 'IN_PROGRESS', reportedOn: null },
      ],
      externalAudits: [
        { id: u('ea-held'), state: 'RESPONDED', endOn: d('2026-02-28') },
        { id: u('ea-planned'), state: 'PLANNED', endOn: d('2026-01-31') },
      ],
      findings: [
        { id: u('f-1'), auditId: u('ia-reported'), type: 'MINOR_NC' },
        { id: u('f-2'), auditId: u('ea-held'), type: 'OFI' },
        { id: u('f-3'), auditId: u('ia-closed-before'), type: 'MAJOR_NC' },
      ],
    };
    expect(figures('AUDIT_RESULTS', data)).toEqual({
      internalAuditsReported: [u('ia-reported')],
      externalAuditsHeld: [u('ea-held')],
      findingsMajorNc: 0,
      findingsMinorNc: [u('f-1')],
      findingsObservation: 0,
      findingsOfi: [u('f-2')],
      findingsGoodPractice: 0,
    });
  });

  it('COMPLIANCE_EVALUATION: the evaluation instances and the STATUTE-only score of the window', () => {
    const settings: FirmSettings = DEFAULT_FIRM_SETTINGS as FirmSettings;
    const scoreItem = (name: string, dueDate: string, completedOn: string | null) => ({
      instanceId: u(name),
      criticality: 'HIGH' as const,
      dueDate: d(dueDate),
      workflowState: completedOn === null ? ('OPEN' as const) : ('APPROVED' as const),
      pendingKind: null,
      completedOn: completedOn === null ? null : d(completedOn),
    });
    const data: ComplianceEvaluationData = {
      evaluations: [
        {
          id: u('ev-done'),
          dueDate: d('2025-09-30'),
          workflowState: 'APPROVED',
          completedOn: d('2025-09-29'),
        },
        { id: u('ev-latest'), dueDate: d('2026-03-31'), workflowState: 'OPEN', completedOn: null },
        { id: u('ev-next'), dueDate: d('2026-09-30'), workflowState: 'OPEN', completedOn: null },
      ],
      statutoryItems: [
        scoreItem('s-on-time', '2025-05-07', '2025-05-07'),
        scoreItem('s-late', '2025-06-07', '2025-06-09'),
        scoreItem('s-before', '2025-03-07', null),
      ],
      settings,
    };
    expect(figures('COMPLIANCE_EVALUATION', data)).toEqual({
      evaluationsDue: [u('ev-done'), u('ev-latest')],
      evaluationsDone: [u('ev-done')],
      latestEvaluation: [u('ev-latest')],
      statutoryInstancesDue: [u('s-on-time'), u('s-late')],
      statutoryScore: 75,
    });
    const empty = figures('COMPLIANCE_EVALUATION', {
      evaluations: [],
      statutoryItems: [],
      settings,
    });
    expect(empty).toEqual({
      evaluationsDue: 0,
      evaluationsDone: 0,
      latestEvaluation: 0,
      statutoryInstancesDue: 0,
    });
  });

  it('a later review counts from the last one held: since moves the window', () => {
    const data: PreviousActionsData = {
      actions: [{ id: u('a-x'), state: 'DONE', dueOn: d('2026-01-01') }],
    };
    expect(figures('PREVIOUS_ACTIONS', data, '2026-03-31', '2026-03-31')).toMatchObject({
      actionsDone: [u('a-x')],
    });
    const risks: RisksData = {
      riskItems: [{ id: u('r-x'), kind: 'RISK', significant: false, createdOn: d('2026-03-30') }],
      ratingChanges: [],
      treatmentActions: [],
    };
    expect(figures('RISKS', risks, '2026-03-31', '2026-03-31')).toMatchObject({ itemsAdded: 0 });
  });
});

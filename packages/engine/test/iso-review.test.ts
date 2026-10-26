import {
  DEFAULT_FIRM_SETTINGS,
  REVIEW_FIGURE_KEYS,
  ReviewInputFigures,
  type FirmSettings,
  type ReviewFigureAction,
  type ReviewFigureData,
  type ReviewInputSource,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { asLocalDate as d, figureKey, reviewInputFigures } from '../src/index.js';
import { u } from './iso-ids.js';

// A system created on 2025-04-01 whose first review is held on 2026-03-31: `since` is its creation day. The data is
// read later (in June 2026), so records created, archived, closed or done after 2026-03-31 test the as-of reads.
const since = '2025-04-01';
const asOf = '2026-03-31';

function figures<S extends ReviewInputSource>(
  source: S,
  data: ReviewFigureData[S],
  from = since,
  to = asOf,
) {
  const result = ReviewInputFigures.parse(reviewInputFigures(source, data, d(from), d(to)));
  expect(result).toMatchObject({ source, since: from, asOf: to });
  return Object.fromEntries(result.figures.map((f) => [f.key, f.ids.length > 0 ? f.ids : f.value]));
}

/** A record's creation and archive days. */
const days = (createdOn: string, archivedOn: string | null = null) => ({
  createdOn: d(createdOn),
  archivedOn: archivedOn === null ? null : d(archivedOn),
});

const action = (
  name: string,
  subjectId: string,
  over: Partial<Omit<ReviewFigureAction, 'id' | 'subject'>> = {},
): ReviewFigureAction => ({
  id: u(name),
  subject: { type: 'NONCONFORMITY', id: subjectId },
  state: 'OPEN',
  dueOn: d('2026-06-30'),
  doneOn: null,
  settledOn: null,
  ...days('2025-05-01'),
  ...over,
});

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

  it('PREVIOUS_ACTIONS: open and overdue on as-of; done and cancelled by their settled day in the window', () => {
    const r = u('review-1');
    const data: ReviewFigureData['PREVIOUS_ACTIONS'] = {
      actions: [
        action('a-late', r, { dueOn: d('2026-03-30') }),
        action('a-due-today', r, { dueOn: d(asOf) }),
        // Done after as-of: open on as-of, and overdue then.
        action('a-done-after', r, {
          state: 'DONE',
          dueOn: d('2026-02-28'),
          doneOn: d('2026-04-10'),
          settledOn: d('2026-04-10'),
        }),
        // doneOn backdated into the window, but completed after as-of: open on as-of.
        action('a-backdated', r, {
          state: 'DONE',
          doneOn: d('2026-03-01'),
          settledOn: d('2026-04-02'),
        }),
        action('a-done', r, {
          state: 'DONE',
          doneOn: d('2025-09-01'),
          settledOn: d('2025-09-02'),
        }),
        // Settled before since: reported to an earlier review, not counted again.
        action('a-settled-before', r, {
          state: 'DONE',
          doneOn: d('2025-03-20'),
          settledOn: d('2025-03-20'),
          ...days('2025-01-10'),
        }),
        action('a-cancelled', r, { state: 'CANCELLED', settledOn: d('2025-11-11') }),
        // Created after as-of: not there yet.
        action('a-new', r, { ...days('2026-04-05'), dueOn: d('2026-01-01') }),
        // Archived on or before as-of: counts nowhere; archived later: still live.
        action('a-archived', r, { ...days('2025-05-01', '2026-03-31') }),
        action('a-archived-later', r, { ...days('2025-05-01', '2026-04-01') }),
      ],
    };
    expect(figures('PREVIOUS_ACTIONS', data)).toEqual({
      actionsOpen: [
        u('a-late'),
        u('a-due-today'),
        u('a-done-after'),
        u('a-backdated'),
        u('a-archived-later'),
      ],
      actionsOverdue: [u('a-late'), u('a-done-after')],
      actionsDone: [u('a-done')],
      actionsCancelled: [u('a-cancelled')],
    });
  });

  it('an action completed, reopened and completed again counts by its later COMPLETE', () => {
    const r = u('review-1');
    // First COMPLETE on 2025-03-15 (before since), REOPEN, then COMPLETE again on 2025-06-15: settledOn is the latest.
    const data: ReviewFigureData['PREVIOUS_ACTIONS'] = {
      actions: [
        action('a-twice', r, {
          state: 'DONE',
          doneOn: d('2025-03-15'),
          settledOn: d('2025-06-15'),
          ...days('2025-01-10'),
        }),
      ],
    };
    expect(figures('PREVIOUS_ACTIONS', data)).toMatchObject({ actionsDone: [u('a-twice')] });
    // Before the later COMPLETE it was still open.
    expect(figures('PREVIOUS_ACTIONS', data, since, '2025-06-14')).toMatchObject({
      actionsOpen: [u('a-twice')],
      actionsDone: 0,
    });
  });

  it('CONTEXT: added, changed and removed by their days; the climate decision by its decisions', () => {
    const item = (name: string, kind: string, created: string, archived: string | null = null) => ({
      id: u(name),
      kind: kind as 'INTERNAL_ISSUE',
      ...days(created, archived),
    });
    const data: ReviewFigureData['CONTEXT'] = {
      contextItems: [
        item('c-issue-new', 'INTERNAL_ISSUE', '2025-06-01'),
        item('c-issue-old', 'EXTERNAL_ISSUE', '2025-03-01'),
        item('c-party-new', 'INTERESTED_PARTY', '2025-07-01'),
        item('c-party-old', 'INTERESTED_PARTY', '2025-03-01'),
        item('c-removed', 'INTERNAL_ISSUE', '2025-04-01', '2025-12-01'),
        item('c-removed-after', 'EXTERNAL_ISSUE', '2025-03-01', '2026-05-01'),
        item('c-after', 'INTERNAL_ISSUE', '2026-04-01'),
        item('c-made-and-removed-after', 'INTERNAL_ISSUE', '2026-04-02', '2026-04-03'),
      ],
      contextChanges: [
        { entityId: u('c-issue-old'), on: d('2025-10-01') },
        { entityId: u('c-party-old'), on: d('2025-08-01') },
        // Changed after as-of: not in the window.
        { entityId: u('c-removed-after'), on: d('2026-04-15') },
        // A new item's own edit counts it as added, not changed.
        { entityId: u('c-issue-new'), on: d('2025-06-10') },
      ],
      // Relevant now (decided again on 2026-04-20, after as-of), first decided on 2025-04-15: still decided on as-of.
      system: {
        id: u('sys'),
        climateChangeRelevant: true,
        climateDecidedOn: d('2026-04-20'),
      },
      climateDecisions: [
        { entityId: u('sys'), on: d('2026-04-20') },
        { entityId: u('sys'), on: d('2025-04-15') },
      ],
    };
    expect(figures('CONTEXT', data)).toEqual({
      issuesAdded: [u('c-issue-new')],
      issuesChanged: [u('c-issue-old')],
      interestedPartiesAdded: [u('c-party-new')],
      interestedPartiesChanged: [u('c-party-old')],
      contextItemsRemoved: [u('c-removed')],
      climateDecided: [u('sys')],
      climateRelevant: [u('sys')],
      climateDecidedInPeriod: [u('sys')],
    });
    // A later review: the only decision in its window came after its as-of.
    expect(figures('CONTEXT', data, '2026-01-01', asOf)).toMatchObject({
      climateDecided: [u('sys')],
      climateDecidedInPeriod: 0,
    });
    // Before the first decision: undecided, whatever the system says now.
    expect(figures('CONTEXT', data, since, '2025-04-14')).toMatchObject({
      climateDecided: 0,
      climateRelevant: 0,
      climateDecidedInPeriod: 0,
    });
  });

  it('RISKS: added and re-rated by their days, significant for the kinds given, treatment actions by settled day', () => {
    const item = (
      name: string,
      kind: string,
      significant: boolean,
      created: string,
      archived: string | null = null,
    ) => ({
      id: u(name),
      kind: kind as 'RISK',
      significant,
      ...days(created, archived),
    });
    const treatment = (name: string, item: string, over: Partial<ReviewFigureAction> = {}) =>
      action(name, u(item), over);
    const data: ReviewFigureData['RISKS'] = {
      kinds: ['RISK', 'OPPORTUNITY', 'HAZARD'],
      riskItems: [
        item('r-new', 'RISK', true, '2025-05-01'),
        item('r-old', 'RISK', false, '2025-03-01'),
        item('o-sig', 'OPPORTUNITY', true, '2025-03-01'),
        item('h-sig', 'HAZARD', true, '2025-03-01'),
        item('r-after', 'RISK', true, '2026-04-02'),
        item('r-archived', 'RISK', true, '2025-04-01', '2026-01-01'),
      ],
      ratingChanges: [
        { entityId: u('r-old'), on: d('2025-12-01') },
        { entityId: u('r-new'), on: d('2025-12-01') },
        { entityId: u('o-sig'), on: d('2026-04-10') },
      ],
      treatmentActions: [
        treatment('t-done', 'r-old', {
          state: 'DONE',
          doneOn: d('2025-11-01'),
          settledOn: d('2025-11-01'),
        }),
        treatment('t-done-after', 'r-old', {
          state: 'DONE',
          doneOn: d('2026-04-03'),
          settledOn: d('2026-04-03'),
        }),
        treatment('t-open', 'h-sig'),
        // Its item is not live on as-of, or not one of the kinds read.
        treatment('t-of-new-item', 'r-after', { ...days('2026-04-02') }),
        treatment('t-of-archived', 'r-archived'),
      ],
    };
    expect(figures('RISKS', data)).toEqual({
      itemsAdded: [u('r-new')],
      itemsRerated: [u('r-old')],
      significantRisk: [u('r-new')],
      significantOpportunity: [u('o-sig')],
      significantHazard: [u('h-sig')],
      treatmentActionsDone: [u('t-done')],
      treatmentActionsOpen: [u('t-done-after'), u('t-open')],
    });
    // A 14001 SIGNIFICANT_ASPECTS row: aspects only, and no key for the other kinds.
    const aspects = figures('RISKS', {
      kinds: ['ASPECT'],
      riskItems: [item('a-sig', 'ASPECT', true, '2025-05-01')],
      ratingChanges: [],
      treatmentActions: [],
    });
    expect(aspects).toEqual({
      itemsAdded: [u('a-sig')],
      itemsRerated: 0,
      significantAspect: [u('a-sig')],
      treatmentActionsDone: 0,
      treatmentActionsOpen: 0,
    });
    expect(aspects).not.toHaveProperty('significantRisk');
  });

  it('OBJECTIVES: open on as-of until the close is placed; readings created by as-of; readings recorded in the window', () => {
    const objective = (
      name: string,
      over: Partial<ReviewFigureData['OBJECTIVES']['objectives'][number]> = {},
    ): ReviewFigureData['OBJECTIVES']['objectives'][number] => ({
      id: u(name),
      target: 10,
      baseline: null,
      direction: 'DECREASE',
      readingRule: { kind: 'ONGOING_REVIEW', every: 'QUARTER' },
      dueOn: d('2026-12-31'),
      closedOn: null,
      outcome: null,
      closeStepOn: null,
      readings: [],
      ...days('2025-04-01'),
      ...over,
    });
    const reading = (name: string, periodEnd: string, value: number, created: string) => ({
      id: u(name),
      periodStart: d('2025-04-01'),
      periodEnd: d(periodEnd),
      value,
      ...days(created),
    });
    const data: ReviewFigureData['OBJECTIVES'] = {
      objectives: [
        objective('o-on', { readings: [reading('rd-on', '2025-06-30', 8, '2025-07-02')] }),
        // Its on-track reading was created after as-of, so on as-of it had only the off-track one.
        objective('o-off', {
          readings: [
            reading('rd-off', '2025-06-30', 12, '2025-07-05'),
            reading('rd-late', '2025-12-31', 7, '2026-04-02'),
          ],
        }),
        // A reading for a future period, recorded in the window: counted as recorded, not read for on-track.
        objective('o-none', { readings: [reading('rd-future', '2026-06-30', 1, '2026-03-31')] }),
        objective('o-met', {
          closedOn: d('2026-03-31'),
          closeStepOn: d('2026-03-31'),
          outcome: 'ACHIEVED',
        }),
        objective('o-missed', {
          closedOn: d('2025-06-30'),
          closeStepOn: d('2025-07-01'),
          outcome: 'NOT_ACHIEVED',
        }),
        // Closed after as-of with closedOn before it: still open on as-of.
        objective('o-closed-after', {
          closedOn: d('2026-03-15'),
          closeStepOn: d('2026-04-03'),
          outcome: 'ACHIEVED',
        }),
        objective('o-closed-before', {
          closedOn: d('2025-03-31'),
          closeStepOn: d('2025-03-31'),
          outcome: 'ACHIEVED',
          ...days('2025-01-01'),
        }),
        objective('o-created-after', { ...days('2026-04-01') }),
      ],
      calendar: { fyStartMonth: 4 },
    };
    expect(figures('OBJECTIVES', data)).toEqual({
      objectivesOpen: [u('o-on'), u('o-off'), u('o-none'), u('o-closed-after')],
      onTrack: [u('o-on')],
      offTrack: [u('o-off')],
      withoutReading: [u('o-none'), u('o-closed-after')],
      achieved: [u('o-met')],
      notAchieved: [u('o-missed')],
      readingsRecorded: [u('rd-on'), u('rd-off'), u('rd-future')],
    });
    expect(figures('OBJECTIVES', { objectives: [], calendar: { fyStartMonth: 4 } })).toMatchObject({
      objectivesOpen: 0,
    });
  });

  it('NONCONFORMITIES: placed by the counting day; open on as-of; overdue actions only of NCs open then', () => {
    const nc = (
      name: string,
      over: Partial<ReviewFigureData['NONCONFORMITIES']['nonconformities'][number]>,
    ): ReviewFigureData['NONCONFORMITIES']['nonconformities'][number] => ({
      id: u(name),
      state: 'OPEN',
      severity: 'MINOR',
      source: 'PROCESS',
      reportedOn: d('2025-06-01'),
      closedOn: null,
      ...days('2025-06-01'),
      ...over,
    });
    const data: ReviewFigureData['NONCONFORMITIES'] = {
      nonconformities: [
        nc('nc-open', {}),
        nc('nc-closed', {
          state: 'CLOSED',
          severity: 'MAJOR',
          source: 'INTERNAL_AUDIT',
          reportedOn: d('2025-03-01'),
          closedOn: d('2025-04-01'),
          ...days('2025-03-01'),
        }),
        nc('nc-cancelled', {
          state: 'CANCELLED',
          reportedOn: d('2025-02-01'),
          ...days('2025-02-01'),
        }),
        // Closed after as-of: open on as-of.
        nc('nc-closed-after', { state: 'CLOSED', closedOn: d('2026-04-20') }),
        // Reported before as-of but raised after it: not there on as-of.
        nc('nc-raised-after', { reportedOn: d('2026-03-01'), ...days('2026-04-02') }),
        // Raised in the window with a reportedOn backdated before since: counts as raised on its creation day.
        nc('nc-backdated', {
          source: 'COMPLAINT',
          reportedOn: d('2025-01-15'),
          ...days('2025-05-10'),
        }),
        nc('nc-archived', { ...days('2025-06-01', '2026-02-01') }),
      ],
      notEffectiveSteps: [
        { entityId: u('nc-open'), on: d('2025-08-01') },
        { entityId: u('nc-open'), on: d('2025-10-01') },
        { entityId: u('nc-closed'), on: d('2025-03-15') },
        { entityId: u('nc-open'), on: d('2026-04-05') },
        { entityId: u('nc-raised-after'), on: d('2026-03-30') },
      ],
      correctiveActions: [
        action('ca-late', u('nc-open'), { dueOn: d('2026-03-30') }),
        action('ca-today', u('nc-open'), { dueOn: d(asOf) }),
        action('ca-done', u('nc-open'), {
          state: 'DONE',
          dueOn: d('2025-07-01'),
          doneOn: d('2025-07-01'),
          settledOn: d('2025-07-01'),
        }),
        // Done after as-of: overdue on as-of.
        action('ca-done-after', u('nc-closed-after'), {
          state: 'DONE',
          dueOn: d('2026-02-01'),
          doneOn: d('2026-04-15'),
          settledOn: d('2026-04-15'),
        }),
        // An overdue OPEN action on a cancelled NC is not counted.
        action('ca-of-cancelled', u('nc-cancelled'), { dueOn: d('2025-03-01') }),
        action('ca-of-closed', u('nc-closed'), { dueOn: d('2025-03-20') }),
      ],
    };
    const result = figures('NONCONFORMITIES', data);
    expect(result).toMatchObject({
      raised: [u('nc-open'), u('nc-closed-after'), u('nc-backdated')],
      closed: [u('nc-closed')],
      raisedMinor: [u('nc-open'), u('nc-closed-after'), u('nc-backdated')],
      raisedMajor: 0,
      raisedProcess: [u('nc-open'), u('nc-closed-after')],
      raisedComplaint: [u('nc-backdated')],
      closedMajor: [u('nc-closed')],
      closedInternalAudit: [u('nc-closed')],
      verifiedNotEffective: [u('nc-open')],
      open: [u('nc-open'), u('nc-closed-after'), u('nc-backdated')],
      correctiveActionsOverdue: [u('ca-late'), u('ca-done-after')],
    });
    // Two steps on one NC in the window count twice; the ids list it once.
    const steps = reviewInputFigures('NONCONFORMITIES', data, d(since), d(asOf)).figures.find(
      (f) => f.key === 'verifiedNotEffective',
    );
    expect(steps).toEqual({ key: 'verifiedNotEffective', value: 2, ids: [u('nc-open')] });
  });

  it("INCIDENTS: placed by the NC's counting day, cancelled ones left out, grouped with lost days", () => {
    const nc = (
      name: string,
      inc: ReturnType<typeof incident> | null,
      created: string,
      reportedOn: string,
      over: Partial<ReviewFigureData['INCIDENTS']['nonconformities'][number]> = {},
    ): ReviewFigureData['INCIDENTS']['nonconformities'][number] => ({
      id: u(name),
      state: 'OPEN',
      reportedOn: d(reportedOn),
      incident: inc,
      ...days(created),
      ...over,
    });
    const data: ReviewFigureData['INCIDENTS'] = {
      nonconformities: [
        nc('i-lost', incident('2025-12-01T05:00:00Z', 'LOST_TIME', 4), '2025-12-01', '2025-12-01'),
        // 23:30 on 31 March 2026 in Kolkata, raised that day: the window's last day.
        nc(
          'i-aid',
          incident('2026-03-31T18:00:00Z', 'FIRST_AID', null),
          '2026-03-31',
          '2026-03-31',
        ),
        // Occurred before since, but its NC was raised in the window: counted.
        nc('i-early', incident('2025-03-20T05:00:00Z', 'LOST_TIME', 2), '2025-04-02', '2025-03-20'),
        // Occurred and reported before as-of, raised after it: not counted.
        nc(
          'i-raised-after',
          incident('2026-03-30T05:00:00Z', 'FIRST_AID', null),
          '2026-04-01',
          '2026-03-30',
        ),
        nc(
          'i-cancelled',
          incident('2025-09-01T05:00:00Z', 'FIRST_AID', null),
          '2025-09-01',
          '2025-09-01',
          {
            state: 'CANCELLED',
          },
        ),
        nc(
          'i-archived',
          incident('2025-09-01T05:00:00Z', 'NONE', null),
          '2025-09-01',
          '2025-09-01',
          {
            archivedOn: d('2026-01-01'),
          },
        ),
        nc('i-none', null, '2025-09-01', '2025-09-01'),
      ],
      timeZone: 'Asia/Kolkata',
    };
    const result = figures('INCIDENTS', data);
    expect(result).toMatchObject({
      incidents: [u('i-lost'), u('i-aid'), u('i-early')],
      typeInjury: [u('i-lost'), u('i-aid'), u('i-early')],
      typeNearMiss: 0,
      outcomeLostTime: [u('i-lost'), u('i-early')],
      outcomeFirstAid: [u('i-aid')],
      outcomeNone: 0,
      lostDays: [u('i-lost'), u('i-early')],
    });
    const lost = reviewInputFigures('INCIDENTS', data, d(since), d(asOf)).figures.find(
      (f) => f.key === 'lostDays',
    );
    expect(lost!.value).toBe(6);
  });

  it("AUDIT_RESULTS: audits placed by the later of their date and step; findings by the later of their audit's day and their own", () => {
    const data: ReviewFigureData['AUDIT_RESULTS'] = {
      internalAudits: [
        {
          id: u('ia-reported'),
          state: 'REPORTED',
          reportedOn: d('2025-09-30'),
          reportStepOn: d('2025-10-01'),
          ...days('2025-08-01'),
        },
        {
          id: u('ia-closed-before'),
          state: 'CLOSED',
          reportedOn: d('2025-03-31'),
          reportStepOn: d('2025-03-31'),
          ...days('2025-02-01'),
        },
        // reportedOn backdated into the window, REPORT step after as-of: not yet reported on as-of.
        {
          id: u('ia-reported-after'),
          state: 'REPORTED',
          reportedOn: d('2026-03-20'),
          reportStepOn: d('2026-04-03'),
          ...days('2026-03-01'),
        },
        {
          id: u('ia-running'),
          state: 'IN_PROGRESS',
          reportedOn: null,
          reportStepOn: null,
          ...days('2026-01-01'),
        },
      ],
      externalAudits: [
        {
          id: u('ea-held'),
          state: 'RESPONDED',
          endOn: d('2026-02-28'),
          heldStepOn: d('2026-03-02'),
          ...days('2025-12-01'),
        },
        // Recorded HELD after as-of with endOn before it: not counted.
        {
          id: u('ea-held-after'),
          state: 'HELD',
          endOn: d('2026-03-25'),
          heldStepOn: d('2026-04-05'),
          ...days('2026-01-01'),
        },
        // Placed before since (by an earlier review).
        {
          id: u('ea-before'),
          state: 'CLOSED',
          endOn: d('2025-03-10'),
          heldStepOn: d('2025-03-12'),
          ...days('2025-01-01'),
        },
        {
          id: u('ea-planned'),
          state: 'PLANNED',
          endOn: d('2026-01-31'),
          heldStepOn: null,
          ...days('2025-10-01'),
        },
      ],
      findings: [
        { id: u('f-1'), auditId: u('ia-reported'), type: 'MINOR_NC', ...days('2025-09-15') },
        { id: u('f-2'), auditId: u('ea-held'), type: 'OFI', ...days('2026-03-02') },
        { id: u('f-3'), auditId: u('ia-closed-before'), type: 'MAJOR_NC', ...days('2025-03-20') },
        // Created after since on an audit placed before it: counted, though its audit is not.
        { id: u('f-late'), auditId: u('ea-before'), type: 'OBSERVATION', ...days('2025-06-01') },
        {
          id: u('f-of-held-after'),
          auditId: u('ea-held-after'),
          type: 'MINOR_NC',
          ...days('2026-03-26'),
        },
        {
          id: u('f-of-planned'),
          auditId: u('ea-planned'),
          type: 'GOOD_PRACTICE',
          ...days('2025-11-01'),
        },
        { id: u('f-created-after'), auditId: u('ia-reported'), type: 'OFI', ...days('2026-04-02') },
      ],
    };
    expect(figures('AUDIT_RESULTS', data)).toEqual({
      internalAuditsReported: [u('ia-reported')],
      externalAuditsHeld: [u('ea-held')],
      findingsMajorNc: 0,
      findingsMinorNc: [u('f-1')],
      findingsObservation: [u('f-late')],
      findingsOfi: [u('f-2')],
      findingsGoodPractice: 0,
    });
  });

  it('COMPLIANCE_EVALUATION: the evaluation instances and the STATUTE-only score of the window', () => {
    const settings: FirmSettings = DEFAULT_FIRM_SETTINGS as FirmSettings;
    const scoreItem = (
      name: string,
      dueDate: string,
      completedOn: string | null,
      created = '2025-01-01',
    ) => ({
      instanceId: u(name),
      criticality: 'HIGH' as const,
      dueDate: d(dueDate),
      workflowState: completedOn === null ? ('OPEN' as const) : ('APPROVED' as const),
      pendingKind: null,
      completedOn: completedOn === null ? null : d(completedOn),
      ...days(created),
    });
    const evaluation = (
      name: string,
      dueDate: string,
      completedOn: string | null,
      created = '2025-01-01',
    ) => ({
      id: u(name),
      dueDate: d(dueDate),
      workflowState: completedOn === null ? ('OPEN' as const) : ('APPROVED' as const),
      completedOn: completedOn === null ? null : d(completedOn),
      ...days(created),
    });
    const data: ReviewFigureData['COMPLIANCE_EVALUATION'] = {
      evaluations: [
        evaluation('ev-done', '2025-09-30', '2025-09-29'),
        evaluation('ev-latest', '2026-03-31', null),
        evaluation('ev-next', '2026-09-30', null),
        evaluation('ev-added-after', '2026-03-15', null, '2026-04-02'),
      ],
      statutoryItems: [
        scoreItem('s-on-time', '2025-05-07', '2025-05-07'),
        scoreItem('s-late', '2025-06-07', '2025-06-09'),
        scoreItem('s-before', '2025-03-07', null),
        scoreItem('s-added-after', '2025-08-07', null, '2026-04-02'),
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
    expect(
      figures('COMPLIANCE_EVALUATION', { evaluations: [], statutoryItems: [], settings }),
    ).toEqual({
      evaluationsDue: 0,
      evaluationsDone: 0,
      latestEvaluation: 0,
      statutoryInstancesDue: 0,
    });
  });

  it("every key the engine emits is in REVIEW_FIGURE_KEYS, and it emits each of its source's keys", () => {
    const settings: FirmSettings = DEFAULT_FIRM_SETTINGS as FirmSettings;
    const empty: { [S in Exclude<ReviewInputSource, 'MANUAL'>]: ReviewFigureData[S] } = {
      PREVIOUS_ACTIONS: { actions: [] },
      CONTEXT: {
        contextItems: [],
        contextChanges: [],
        system: { id: u('sys'), climateChangeRelevant: null, climateDecidedOn: null },
        climateDecisions: [],
      },
      RISKS: {
        kinds: ['RISK', 'OPPORTUNITY', 'ASPECT', 'HAZARD'],
        riskItems: [],
        ratingChanges: [],
        treatmentActions: [],
      },
      OBJECTIVES: { objectives: [], calendar: { fyStartMonth: 4 } },
      NONCONFORMITIES: { nonconformities: [], notEffectiveSteps: [], correctiveActions: [] },
      INCIDENTS: { nonconformities: [], timeZone: 'Asia/Kolkata' },
      AUDIT_RESULTS: { internalAudits: [], externalAudits: [], findings: [] },
      COMPLIANCE_EVALUATION: {
        evaluations: [],
        statutoryItems: [
          {
            instanceId: u('s'),
            criticality: 'HIGH',
            dueDate: d('2025-05-07'),
            workflowState: 'APPROVED',
            pendingKind: null,
            completedOn: d('2025-05-07'),
            ...days('2025-01-01'),
          },
        ],
        settings,
      },
    };
    for (const source of Object.keys(empty) as (keyof typeof empty)[]) {
      const keys = reviewInputFigures(source, empty[source], d(since), d(asOf)).figures.map(
        (f) => f.key,
      );
      expect(keys.sort(), source).toEqual(Object.keys(REVIEW_FIGURE_KEYS[source]).sort());
    }
  });

  it('a later review counts from the last one held: since moves the window', () => {
    const data: ReviewFigureData['PREVIOUS_ACTIONS'] = {
      actions: [
        action('a-x', u('review-1'), {
          state: 'DONE',
          dueOn: d('2026-01-01'),
          doneOn: d('2026-03-31'),
          settledOn: d('2026-03-31'),
        }),
      ],
    };
    expect(figures('PREVIOUS_ACTIONS', data, '2026-03-31', '2026-03-31')).toMatchObject({
      actionsDone: [u('a-x')],
    });
    expect(figures('PREVIOUS_ACTIONS', data, '2026-04-01', '2026-06-30')).toMatchObject({
      actionsDone: 0,
      actionsOpen: 0,
    });
  });
});

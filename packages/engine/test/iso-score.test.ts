import {
  AuditProgrammeCoverage,
  CertificationReadiness,
  ClauseReadiness,
  DEFAULT_ISO_RISK_RULE,
  IncidentCounts,
  ObjectiveProgress,
  type CertificationReadinessData,
  type IsoSystemInput,
  type RecurrenceRule,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import {
  asLocalDate as d,
  auditProgrammeCoverage,
  certificationReadiness,
  clauseReadiness,
  climateDeterminationGaps,
  compareClauseNumbers,
  incidentCounts,
  isSignificant,
  NO_OBJECTIVE,
  NO_REVIEW_IN_WINDOW,
  objectiveProgress,
  riskRating,
} from '../src/index.js';
import { u } from './iso-ids.js';

describe('riskRating and isSignificant (model §5.1)', () => {
  it('multiplies the 1-5 scales into 1-25', () => {
    expect(riskRating(1, 1)).toBe(1);
    expect(riskRating(3, 4)).toBe(12);
    expect(riskRating(5, 5)).toBe(25);
  });
  it('refuses values off the scale', () => {
    for (const [l, s] of [
      [0, 3],
      [3, 6],
      [2.5, 2],
    ]) {
      expect(() => riskRating(l!, s!)).toThrow(RangeError);
    }
  });
  const item = (
    rating: number,
    obligationIds: string[] = [],
    significantOverride: boolean | null = null,
  ) => ({
    rating,
    obligationIds,
    significantOverride,
  });
  it('the default rule: significant from 12, or with a legal link', () => {
    expect(DEFAULT_ISO_RISK_RULE).toEqual({ significantAt: 12, legalLinkMakesSignificant: true });
    expect(isSignificant(item(11), DEFAULT_ISO_RISK_RULE)).toBe(false);
    expect(isSignificant(item(12), DEFAULT_ISO_RISK_RULE)).toBe(true);
    expect(isSignificant(item(2, [u('obligation')]), DEFAULT_ISO_RISK_RULE)).toBe(true);
  });
  it('a rule without the legal link ignores it; an override wins both ways', () => {
    const rule = { significantAt: 15, legalLinkMakesSignificant: false };
    expect(isSignificant(item(12, [u('obligation')]), rule)).toBe(false);
    expect(isSignificant(item(25, [], false), DEFAULT_ISO_RISK_RULE)).toBe(false);
    expect(isSignificant(item(1, [], true), DEFAULT_ISO_RISK_RULE)).toBe(true);
  });
});

describe('compareClauseNumbers', () => {
  it('reads clause numbers as numbers', () => {
    expect(['4.10', '10', '4.2', '5.2.1', '5.2'].sort(compareClauseNumbers)).toEqual([
      '4.2',
      '4.10',
      '5.2',
      '5.2.1',
      '10',
    ]);
  });
});

describe('clauseReadiness (model §5.1)', () => {
  const q = u('std-9001');
  const e = u('std-14001');
  const clause = (
    name: string,
    standardId: string,
    over: { assessable?: boolean; exclusionAllowed?: boolean } = {},
  ) => ({
    id: u(name),
    standardId,
    assessable: true,
    exclusionAllowed: false,
    ...over,
  });
  const row = (name: string, status: string, naState = 'NONE') => ({
    clauseId: u(name),
    status: status as 'IMPLEMENTED',
    naState: naState as 'NONE',
  });
  const clauses = [
    clause('q-4.1', q),
    clause('q-4.2', q),
    clause('q-8.3', q, { exclusionAllowed: true }),
    clause('q-7.1.5', q, { exclusionAllowed: true }),
    clause('q-4', q, { assessable: false }),
    clause('e-6.1', e),
    clause('e-6.2', e),
    clause('e-9.1', e),
  ];
  it('IMPLEMENTED 1, PARTIAL 0.5; an approved exclusion leaves the denominator; a requested one counts 0', () => {
    const result = ClauseReadiness.parse(
      clauseReadiness(
        [
          row('q-4.1', 'IMPLEMENTED'),
          row('q-4.2', 'PARTIAL'),
          row('q-8.3', 'NOT_APPLICABLE', 'APPROVED'),
          row('q-7.1.5', 'NOT_APPLICABLE', 'REQUESTED'),
          row('e-6.1', 'NOT_APPLICABLE', 'APPROVED'),
          row('e-6.2', 'IMPLEMENTED'),
        ],
        clauses,
      ),
    );
    expect(result.byStandard[0]).toEqual({
      standardId: q,
      score: 50,
      implemented: [u('q-4.1')],
      partial: [u('q-4.2')],
      notStarted: [],
      naPending: [u('q-7.1.5')],
      excluded: [u('q-8.3')],
    });
    // An approved N/A on a clause that allows no exclusion scores 0; a clause with no row is not started.
    expect(result.byStandard[1]).toEqual({
      standardId: e,
      score: 33.3,
      implemented: [u('e-6.2')],
      partial: [],
      notStarted: [u('e-6.1'), u('e-9.1')],
      naPending: [],
      excluded: [],
    });
    // 2.5 of 6 counted clauses.
    expect(result.overall.score).toBe(41.7);
  });
  it('a rejected N/A counts by its restored status; a withdrawn one scores again as not started', () => {
    const one = [
      clause('q-8.3', q, { exclusionAllowed: true }),
      clause('q-1', q, { assessable: false }),
    ];
    expect(clauseReadiness([row('q-8.3', 'IMPLEMENTED', 'REJECTED')], one).overall).toMatchObject({
      score: 100,
      implemented: [u('q-8.3')],
    });
    expect(clauseReadiness([row('q-8.3', 'NOT_STARTED', 'NONE')], one).overall).toMatchObject({
      score: 0,
      notStarted: [u('q-8.3')],
      excluded: [],
    });
  });
  it('a score is null when no clause counts', () => {
    const result = clauseReadiness(
      [row('q-8.3', 'NOT_APPLICABLE', 'APPROVED')],
      [clause('q-8.3', q, { exclusionAllowed: true })],
    );
    expect(result.overall.score).toBeNull();
    expect(clauseReadiness([], []).byStandard).toEqual([]);
  });
});

describe('auditProgrammeCoverage (model §5.1)', () => {
  const unitA = u('unit-a');
  const unitB = u('unit-b');
  const audit = (name: string, state: string, unitIds: string[]) => ({
    id: u(name),
    state: state as 'REPORTED',
    unitIds,
  });
  const item = (
    auditName: string,
    clause: string,
    unitId: string | null,
    result: string | null,
  ) => ({
    internalAuditId: u(auditName),
    clauseId: u(clause),
    unitId,
    result: result as 'CONFORMS',
  });
  const clauses = [
    { id: u('c-4.1'), assessable: true, excluded: false },
    { id: u('c-6.1'), assessable: true, excluded: false },
    { id: u('c-8.3'), assessable: true, excluded: true },
    { id: u('c-4'), assessable: false, excluded: false },
  ];
  it('a NOT_AUDITED row covers nothing; a row of an audit not yet reported covers nothing', () => {
    const result = AuditProgrammeCoverage.parse(
      auditProgrammeCoverage(
        [audit('reported', 'REPORTED', [unitA]), audit('running', 'IN_PROGRESS', [unitB])],
        [
          item('reported', 'c-4.1', unitA, 'NOT_AUDITED'),
          item('running', 'c-6.1', unitB, 'CONFORMS'),
        ],
        { unitIds: [unitA, unitB] },
        clauses,
        '2025-26',
      ),
    );
    expect(result.uncoveredClauseIds).toEqual([u('c-4.1'), u('c-6.1')]);
    expect(result.uncoveredUnitIds).toEqual([unitA, unitB]);
  });
  it('a row with no unit covers the units its audit lists, and none when the audit lists none', () => {
    const listed = auditProgrammeCoverage(
      [audit('a1', 'CLOSED', [unitA, unitB])],
      [item('a1', 'c-4.1', null, 'FINDING'), item('a1', 'c-6.1', null, 'CONFORMS')],
      { unitIds: [unitA, unitB] },
      clauses,
      '2025-26',
    );
    expect(listed.uncoveredClauseIds).toEqual([]);
    expect(listed.uncoveredUnitIds).toEqual([]);
    const unlisted = auditProgrammeCoverage(
      [audit('a2', 'REPORTED', [])],
      [item('a2', 'c-4.1', null, 'CONFORMS')],
      { unitIds: [unitA] },
      clauses,
      '2025-26',
    );
    expect(unlisted.uncoveredClauseIds).toEqual([u('c-6.1')]);
    expect(unlisted.uncoveredUnitIds).toEqual([unitA]);
  });
  it('a row naming a unit covers that unit; counts planned, reported and cancelled', () => {
    const result = AuditProgrammeCoverage.parse(
      auditProgrammeCoverage(
        [
          audit('r', 'REPORTED', [unitA, unitB]),
          audit('p', 'PLANNED', [unitA]),
          audit('x', 'CANCELLED', [unitA]),
        ],
        [item('r', 'c-4.1', unitB, 'CONFORMS'), item('r', 'c-6.1', unitB, null)],
        { unitIds: [unitA, unitB] },
        clauses,
        '2026-27',
      ),
    );
    expect(result).toEqual({
      fy: '2026-27',
      uncoveredClauseIds: [u('c-6.1')],
      uncoveredUnitIds: [unitA],
      planned: { count: 2, ids: [u('r'), u('p')] },
      reported: { count: 1, ids: [u('r')] },
      cancelled: { count: 1, ids: [u('x')] },
    });
  });
});

describe('certificationReadiness (model §5.1, plan §7 items 5 and 6)', () => {
  const q = u('cr-9001');
  const h = u('cr-45001');
  const unit = u('cr-unit');
  const system: IsoSystemInput = {
    id: u('cr-system'),
    standardIds: [q, h],
    unitIds: [unit],
    scopeStatement: 'Design and manufacture of castings',
    climateChangeRelevant: true,
    reviewIntervalMonths: 12,
    createdOn: d('2024-04-01'),
  };
  const clause = (
    name: string,
    standardId: string,
    number: string,
    over: Record<string, boolean> = {},
  ) => ({
    id: u(name),
    standardId,
    number,
    assessable: true,
    exclusionAllowed: false,
    ...over,
  });
  const complete = (): CertificationReadinessData => ({
    standards: [
      { id: q, code: 'ISO_9001' },
      { id: h, code: 'ISO_45001' },
    ],
    clauses: [
      clause('q-5.2', q, '5.2', { assessable: false }),
      clause('q-5.2.1', q, '5.2.1'),
      clause('q-8.3', q, '8.3', { exclusionAllowed: true }),
      clause('h-5.2', h, '5.2'),
      clause('h-10.2', h, '10.2'),
    ],
    assessments: [{ clauseId: u('q-8.3'), status: 'NOT_APPLICABLE', naState: 'APPROVED' }],
    audits: [{ id: u('cr-audit'), state: 'CLOSED', reportedOn: d('2025-04-01'), unitIds: [unit] }],
    checklistItems: ['q-5.2.1', 'h-5.2', 'h-10.2'].map((c) => ({
      internalAuditId: u('cr-audit'),
      clauseId: u(c),
      unitId: null,
      result: 'CONFORMS' as const,
    })),
    reviews: [
      {
        id: u('cr-review'),
        state: 'HELD',
        heldOn: d('2025-06-30'),
        standards: ['ISO_9001', 'ISO_45001'],
      },
    ],
    reviewInputs: [
      {
        managementReviewId: u('cr-review'),
        key: 'OBJECTIVES',
        standard: 'ISO_9001',
        notes: 'On track',
      },
      { managementReviewId: u('cr-review'), key: 'INCIDENTS', standard: 'ISO_45001', notes: 'Two' },
    ],
    documents: [
      {
        id: u('cr-policy'),
        type: 'POLICY',
        status: 'ACTIVE',
        currentRevisionId: u('cr-rev'),
        clauseIds: [u('q-5.2.1'), u('h-5.2')],
      },
    ],
    objectives: [{ id: u('cr-objective'), standards: ['ISO_9001', 'ISO_45001'], closedOn: null }],
    objectiveActions: [
      { id: u('cr-plan'), subject: { type: 'OBJECTIVE', id: u('cr-objective') }, state: 'OPEN' },
    ],
    riskItems: [
      { id: u('cr-risk'), kind: 'OPPORTUNITY', archivedAt: null },
      { id: u('cr-hazard'), kind: 'HAZARD', archivedAt: null },
    ],
  });
  const gates = (data: CertificationReadinessData, asOf: string, sys = system) =>
    CertificationReadiness.parse(certificationReadiness(sys, data, d(asOf))).standards.map((st) =>
      Object.fromEntries(st.gates.map((g) => [g.gate, g.missing])),
    );

  it('every gate met is ready, per standard in the system order', () => {
    const result = certificationReadiness(system, complete(), d('2026-03-31'));
    expect(result.standards.map((st) => [st.standardId, st.ready])).toEqual([
      [q, true],
      [h, true],
    ]);
  });
  it('INTERNAL_AUDIT: the 12 months up to as-of, from 1 April across the FY boundary', () => {
    // The window is (as-of − 12 months, as-of]: a report of 2025-04-01 counts on 2026-03-31, not on 2026-04-01.
    expect(gates(complete(), '2026-03-31')[0]!.INTERNAL_AUDIT).toEqual([]);
    expect(gates(complete(), '2026-04-01')[0]!.INTERNAL_AUDIT).toEqual(['5.2.1', unit]);
    const data = {
      ...complete(),
      audits: [{ ...complete().audits[0]!, reportedOn: d('2026-04-01') }],
    };
    expect(gates(data, '2026-03-31')[0]!.INTERNAL_AUDIT).toEqual(['5.2.1', unit]);
  });
  it('INTERNAL_AUDIT on 29 February counts back to 28 February of the year before', () => {
    const data = {
      ...complete(),
      audits: [{ ...complete().audits[0]!, reportedOn: d('2027-02-28') }],
    };
    expect(gates(data, '2028-02-29')[0]!.INTERNAL_AUDIT).toEqual(['5.2.1', unit]);
    const inside = {
      ...complete(),
      audits: [{ ...complete().audits[0]!, reportedOn: d('2027-03-01') }],
    };
    expect(gates(inside, '2028-02-29')[0]!.INTERNAL_AUDIT).toEqual([]);
  });
  it('INTERNAL_AUDIT: a NOT_AUDITED row covers nothing; an excluded clause needs no coverage; uncovered by number', () => {
    const data = complete();
    data.checklistItems = data.checklistItems.map((i) =>
      i.clauseId === u('h-10.2') ? { ...i, result: 'NOT_AUDITED' } : i,
    );
    data.clauses.push(clause('h-4.10', h, '4.10'));
    expect(gates(data, '2026-03-31')[1]!.INTERNAL_AUDIT).toEqual(['4.10', '10.2']);
    // q-8.3 has an approved N/A and allows exclusion: not listed.
    expect(gates(data, '2026-03-31')[0]!.INTERNAL_AUDIT).toEqual([]);
  });
  it('MANAGEMENT_REVIEW: a held review in the window covering the standard with notes on every input', () => {
    const none = { ...complete(), reviews: [] };
    expect(gates(none, '2026-03-31')[0]!.MANAGEMENT_REVIEW).toEqual([NO_REVIEW_IN_WINDOW]);
    const unnoted = complete();
    unnoted.reviewInputs.push({
      managementReviewId: u('cr-review'),
      key: 'CUSTOMER_SATISFACTION',
      standard: 'ISO_9001',
      notes: ' ',
    });
    expect(gates(unnoted, '2026-03-31')).toMatchObject([
      { MANAGEMENT_REVIEW: ['CUSTOMER_SATISFACTION'] },
      { MANAGEMENT_REVIEW: [] },
    ]);
    // A later complete review meets it; the latest incomplete one is what is reported otherwise.
    const later = complete();
    later.reviews.push({
      id: u('cr-review-2'),
      state: 'CLOSED',
      heldOn: d('2025-12-31'),
      standards: ['ISO_9001'],
    });
    later.reviewInputs.push({
      managementReviewId: u('cr-review-2'),
      key: 'OBJECTIVES',
      standard: 'ISO_9001',
      notes: null,
    });
    expect(gates(later, '2026-03-31')[0]!.MANAGEMENT_REVIEW).toEqual([]);
    later.reviewInputs[0] = { ...later.reviewInputs[0]!, notes: null };
    expect(gates(later, '2026-03-31')[0]!.MANAGEMENT_REVIEW).toEqual(['OBJECTIVES']);
    // A planned review counts for nothing.
    const planned = {
      ...complete(),
      reviews: [
        {
          id: u('cr-review'),
          state: 'PLANNED' as const,
          heldOn: null,
          standards: ['ISO_9001' as const],
        },
      ],
    };
    expect(gates(planned, '2026-03-31')[0]!.MANAGEMENT_REVIEW).toEqual([NO_REVIEW_IN_WINDOW]);
  });
  it('SCOPE: a scope statement and at least one unit', () => {
    const sys = { ...system, scopeStatement: '  ', unitIds: [] };
    expect(gates(complete(), '2026-03-31', sys)[0]!.SCOPE).toEqual(['scopeStatement', 'unitIds']);
    expect(gates(complete(), '2026-03-31', { ...system, scopeStatement: null })[0]!.SCOPE).toEqual([
      'scopeStatement',
    ]);
  });
  it('POLICY: an ACTIVE policy with an approved revision linked to 5.2 or a 5.2 sub-clause', () => {
    const draft = complete();
    draft.documents = [{ ...draft.documents[0]!, currentRevisionId: null }];
    expect(gates(draft, '2026-03-31').map((g) => g.POLICY)).toEqual([['5.2'], ['5.2']]);
    const procedure = complete();
    procedure.documents = [{ ...procedure.documents[0]!, type: 'PROCEDURE' }];
    expect(gates(procedure, '2026-03-31')[0]!.POLICY).toEqual(['5.2']);
    const obsolete = complete();
    obsolete.documents = [{ ...obsolete.documents[0]!, status: 'OBSOLETE' }];
    expect(gates(obsolete, '2026-03-31')[0]!.POLICY).toEqual(['5.2']);
    const otherClause = complete();
    otherClause.documents = [{ ...otherClause.documents[0]!, clauseIds: [u('h-10.2')] }];
    expect(gates(otherClause, '2026-03-31').map((g) => g.POLICY)).toEqual([['5.2'], ['5.2']]);
  });
  it('OBJECTIVES: one for the standard, and every open one has a plan that is not cancelled', () => {
    const none = { ...complete(), objectives: [] };
    expect(gates(none, '2026-03-31')[0]!.OBJECTIVES).toEqual([NO_OBJECTIVE]);
    const cancelled = complete();
    cancelled.objectiveActions = [{ ...cancelled.objectiveActions[0]!, state: 'CANCELLED' }];
    expect(gates(cancelled, '2026-03-31')[0]!.OBJECTIVES).toEqual([u('cr-objective')]);
    const closed = {
      ...cancelled,
      objectives: [{ ...cancelled.objectives[0]!, closedOn: d('2026-01-31') }],
    };
    expect(gates(closed, '2026-03-31')[0]!.OBJECTIVES).toEqual([]);
    const otherSubject = complete();
    otherSubject.objectiveActions = [
      { id: u('cr-plan'), subject: { type: 'RISK_ITEM', id: u('cr-objective') }, state: 'OPEN' },
    ];
    expect(gates(otherSubject, '2026-03-31')[0]!.OBJECTIVES).toEqual([u('cr-objective')]);
  });
  it('RISKS: a live RISK or OPPORTUNITY for 9001, ASPECT for 14001, HAZARD for 45001', () => {
    const archived = complete();
    archived.riskItems = archived.riskItems.map((r) => ({
      ...r,
      archivedAt: '2026-01-01T00:00:00Z',
    }));
    expect(gates(archived, '2026-03-31').map((g) => g.RISKS)).toEqual([
      ['RISK', 'OPPORTUNITY'],
      ['HAZARD'],
    ]);
    const e = u('cr-14001');
    const data = complete();
    data.standards.push({ id: e, code: 'ISO_14001' });
    const result = gates(data, '2026-03-31', { ...system, standardIds: [e, u('cr-missing')] });
    expect(result).toHaveLength(1);
    expect(result[0]!.RISKS).toEqual(['ASPECT']);
  });
});

describe('objectiveProgress (model §5.1)', () => {
  const quarterly: RecurrenceRule = { kind: 'ONGOING_REVIEW', every: 'QUARTER' };
  const objective = (over: Record<string, unknown> = {}) => ({
    id: u('objective'),
    target: 80,
    baseline: 40,
    direction: 'INCREASE' as const,
    readingRule: quarterly,
    dueOn: d('2027-03-31'),
    createdOn: d('2026-04-01'),
    ...over,
  });
  const reading = (periodStart: string, periodEnd: string, value: number) => ({
    periodStart: d(periodStart),
    periodEnd: d(periodEnd),
    value,
  });
  const run = (...args: Parameters<typeof objectiveProgress>) =>
    ObjectiveProgress.parse(objectiveProgress(...args));

  it('compares the latest reading by periodEnd with the straight line from baseline to target', () => {
    const readings = [
      reading('2026-07-01', '2026-09-30', 62),
      reading('2026-04-01', '2026-06-30', 45),
    ];
    const result = run(readings, objective(), d('2026-10-15'));
    // 182 of 364 days from creation: expected 59.99; 62 is on track and 55% of the way.
    expect(result).toEqual({
      objectiveId: u('objective'),
      latestValue: 62,
      latestPeriodEnd: '2026-09-30',
      progressPercent: 55,
      onTrack: true,
      missedReadings: [],
    });
    expect(
      run([reading('2026-07-01', '2026-09-30', 59)], objective(), d('2026-10-15')).onTrack,
    ).toBe(false);
  });
  it('DECREASE runs the other way and progress is clamped to 0-100', () => {
    const down = objective({ direction: 'DECREASE', baseline: 100, target: 60 });
    expect(run([reading('2026-04-01', '2026-06-30', 50)], down, d('2026-07-01'))).toMatchObject({
      progressPercent: 100,
      onTrack: true,
    });
    expect(run([reading('2026-04-01', '2026-06-30', 120)], down, d('2026-07-01'))).toMatchObject({
      progressPercent: 0,
      onTrack: false,
    });
  });
  it('of two readings ending the same day, the one starting later is the latest', () => {
    const readings = [
      reading('2026-06-01', '2026-06-30', 70),
      reading('2026-04-01', '2026-06-30', 50),
    ];
    expect(run(readings, objective(), d('2026-07-01')).latestValue).toBe(70);
    expect(run([...readings].reverse(), objective(), d('2026-07-01')).latestValue).toBe(70);
  });
  it('readings ending after as-of are ignored; none gives nulls', () => {
    const result = run([reading('2026-07-01', '2026-09-30', 70)], objective(), d('2026-09-29'));
    expect(result).toMatchObject({
      latestValue: null,
      latestPeriodEnd: null,
      progressPercent: null,
      onTrack: null,
    });
  });
  it('without a baseline, or for MAINTAIN, the reading must meet the target', () => {
    const noBaseline = objective({ baseline: null });
    expect(
      run([reading('2026-04-01', '2026-06-30', 80)], noBaseline, d('2026-07-01')),
    ).toMatchObject({
      progressPercent: null,
      onTrack: true,
    });
    const maintain = objective({ direction: 'MAINTAIN', target: 0, baseline: 2 });
    expect(run([reading('2026-04-01', '2026-06-30', 0)], maintain, d('2026-07-01'))).toMatchObject({
      progressPercent: 100,
      onTrack: true,
    });
    expect(run([reading('2026-04-01', '2026-06-30', 1)], maintain, d('2026-07-01'))).toMatchObject({
      progressPercent: 0,
      onTrack: false,
    });
    const flat = objective({ baseline: 80 });
    expect(run([reading('2026-04-01', '2026-06-30', 79)], flat, d('2026-07-01'))).toMatchObject({
      progressPercent: 0,
      onTrack: false,
    });
  });
  it('a reading on or after dueOn expects the full target; a due date on the creation day too', () => {
    expect(
      run([reading('2027-01-01', '2027-03-31', 79)], objective(), d('2027-04-01')).onTrack,
    ).toBe(false);
    const sameDay = objective({ dueOn: d('2026-04-01') });
    expect(run([reading('2026-04-01', '2026-04-01', 80)], sameDay, d('2026-04-02')).onTrack).toBe(
      true,
    );
    const early = objective({ dueOn: d('2026-03-01') });
    expect(run([reading('2026-04-01', '2026-04-01', 80)], early, d('2026-04-02')).onTrack).toBe(
      true,
    );
  });
  it('missed readings: periods due before as-of, after creation, by dueOn, that no reading overlaps', () => {
    const readings = [reading('2026-07-15', '2026-08-15', 50)];
    const result = run(readings, objective(), d('2027-04-01'));
    expect(result.missedReadings).toEqual([
      { periodStart: '2026-04-01', periodEnd: '2026-06-30' },
      { periodStart: '2026-10-01', periodEnd: '2026-12-31' },
      { periodStart: '2027-01-01', periodEnd: '2027-03-31' },
    ]);
    // On the due date itself a period is not missed yet.
    expect(run(readings, objective(), d('2027-03-31')).missedReadings).toHaveLength(2);
  });
  it('quarters follow the FY start month given', () => {
    const january = objective({ createdOn: d('2026-01-01'), dueOn: d('2026-12-31') });
    expect(run([], january, d('2026-04-01'), { fyStartMonth: 1 }).missedReadings).toEqual([
      { periodStart: '2026-01-01', periodEnd: '2026-03-31' },
    ]);
    // February-start quarters: the one running when the objective was made counts, as it ends after that day.
    expect(run([], january, d('2026-05-01'), { fyStartMonth: 2 }).missedReadings).toEqual([
      { periodStart: '2025-11-01', periodEnd: '2026-01-31' },
      { periodStart: '2026-02-01', periodEnd: '2026-04-30' },
    ]);
  });
  it('nothing is missed on the creation day or before', () => {
    expect(run([], objective(), d('2026-04-01')).missedReadings).toEqual([]);
    expect(run([], objective(), d('2026-03-01')).missedReadings).toEqual([]);
  });
});

describe('incidentCounts (model §5.1)', () => {
  const nc = (name: string, occurredAt: string | null, type = 'INJURY', outcome = 'FIRST_AID') => ({
    id: u(name),
    incident:
      occurredAt === null
        ? null
        : {
            occurredAt,
            location: 'Casting bay',
            type: type as 'INJURY',
            outcome: outcome as 'FIRST_AID',
            personCategory: null,
            lostDays: null,
            reportable: false,
            statutoryInstanceId: null,
            investigatorIds: [],
            workerParticipation: true,
          },
  });
  it('counts by the client-local date, so 31 March 20:00 UTC is 1 April in Kolkata', () => {
    const ncs = [
      nc('late-march', '2026-03-31T20:00:00Z'),
      nc('first-day', '2026-03-31T18:29:59Z', 'NEAR_MISS', 'NONE'),
      nc('process', null),
      nc('end', '2027-03-31T18:00:00Z', 'FIRE', 'LOST_TIME'),
    ];
    const result = IncidentCounts.parse(
      incidentCounts(ncs, { from: d('2026-04-01'), to: d('2027-03-31') }, 'Asia/Kolkata'),
    );
    expect(result.total).toEqual({ count: 2, ids: [u('late-march'), u('end')] });
    expect(result.byType.find((t) => t.type === 'INJURY')).toEqual({
      type: 'INJURY',
      count: 1,
      ids: [u('late-march')],
    });
    expect(result.byType.find((t) => t.type === 'NEAR_MISS')!.count).toBe(0);
    expect(result.byType).toHaveLength(7);
    expect(result.byOutcome.find((o) => o.outcome === 'LOST_TIME')!.ids).toEqual([u('end')]);
    expect(result.byOutcome).toHaveLength(6);
    expect(
      incidentCounts(ncs, { from: d('2026-03-31'), to: d('2026-03-31') }, 'UTC').total.ids,
    ).toEqual([u('late-march'), u('first-day')]);
  });
});

describe('climateDeterminationGaps (model §5.1)', () => {
  const live = { climateRelated: true, archivedAt: null };
  const archived = { climateRelated: true, archivedAt: '2026-01-01T00:00:00Z' };
  const unrelated = { climateRelated: false, archivedAt: null };
  it('UNDECIDED while null; nothing when not relevant', () => {
    expect(climateDeterminationGaps({ climateChangeRelevant: null }, [], [])).toEqual([
      'UNDECIDED',
    ]);
    expect(climateDeterminationGaps({ climateChangeRelevant: false }, [], [])).toEqual([]);
  });
  it('when relevant, a live climate-related risk item and context item are both needed', () => {
    expect(
      climateDeterminationGaps({ climateChangeRelevant: true }, [archived, unrelated], [unrelated]),
    ).toEqual(['RELEVANT_NO_RISK', 'RELEVANT_NO_ISSUE']);
    expect(climateDeterminationGaps({ climateChangeRelevant: true }, [live], [archived])).toEqual([
      'RELEVANT_NO_RISK',
    ]);
    expect(climateDeterminationGaps({ climateChangeRelevant: true }, [live], [live])).toEqual([]);
    // Any kind of risk item meets it: RISK, OPPORTUNITY, ASPECT or HAZARD.
    for (const kind of ['RISK', 'OPPORTUNITY', 'ASPECT', 'HAZARD']) {
      const riskItem = { ...live, kind };
      expect(climateDeterminationGaps({ climateChangeRelevant: true }, [live], [riskItem])).toEqual(
        [],
      );
    }
  });
});

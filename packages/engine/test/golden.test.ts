import {
  Criticality,
  DEFAULT_FIRM_SETTINGS,
  TimelineType,
  WorkflowState,
  type FirmSettings,
  type InferredRule,
  type LocalDate,
  type ScoreInput,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import {
  asLocalDate,
  computeScore,
  fyRangeOf,
  generateInstances,
  inferRule,
  type Calendar,
} from '../src/index.js';
import sample from './fixtures/sample-fy2022-23.json' with { type: 'json' };

/**
 * Golden tests against the sample register (MODULES.md M4 acceptance, docs/contracts/fixtures.md §4-§5).
 * The fixture is extracted from the sample xlsx by fixtures/extract-sample.py and holds no names.
 */

const cal: Calendar = { fyStartMonth: 4, holidayPolicy: 'NONE' };
const fy = fyRangeOf('2022-23', cal.fyStartMonth);

const rows = sample.rows.map((r) => ({
  ref: r.ref,
  timelineType: TimelineType.parse(r.timelineType),
  criticality: Criticality.parse(r.criticality),
  dueDate: asLocalDate(r.dueDate),
  workflowState: WorkflowState.parse(r.workflowState),
  activityDate: r.activityDate === null ? null : asLocalDate(r.activityDate),
}));

const obligations = new Map<string, { timelineType: TimelineType; dueDates: LocalDate[] }>();
for (const row of rows) {
  const o = obligations.get(row.ref) ?? { timelineType: row.timelineType, dueDates: [] };
  o.dueDates.push(row.dueDate);
  obligations.set(row.ref, o);
}

/**
 * Obligations whose Excel dates no rule reproduces exactly: monthly dates that drift by a day, and the two
 * duplicate periods (fixtures.md §3, findings 1 and 6). The instances keep the Excel dates; import flags these
 * rules TO_REVIEW.
 */
const LOW_CONFIDENCE: Record<string, InferredRule> = {
  'TAX-CL-033-6067-60218': {
    rule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
    confidence: 11 / 12,
    mismatches: [{ expected: d('2022-08-06'), generated: d('2022-08-07') }],
  },
  'HRS-WB-032-3238-32430': {
    rule: { kind: 'MONTHLY', day: 10, offsetMonths: 1 },
    confidence: 10 / 12,
    mismatches: [
      { expected: d('2022-04-09'), generated: d('2022-04-10') },
      { expected: d('2022-07-09'), generated: d('2022-07-10') },
    ],
  },
  'HRS-CL-019-3058-30396': {
    rule: { kind: 'MONTHLY', day: 15, offsetMonths: 1 },
    confidence: 10 / 12,
    mismatches: [
      { expected: d('2022-05-14'), generated: d('2022-05-15') },
      { expected: d('2023-01-14'), generated: d('2023-01-15') },
    ],
  },
  'TAX-CL-033-6067-61259': {
    rule: { kind: 'MONTHLY', day: 30, offsetMonths: 1 },
    confidence: 11 / 12,
    mismatches: [{ expected: d('2022-10-29'), generated: d('2022-10-30') }],
  },
  'EHS-CL-017-2317-22813': {
    rule: { kind: 'ONGOING_REVIEW', every: 'MONTH' },
    confidence: 11 / 12,
    mismatches: [{ expected: d('2022-07-30'), generated: d('2022-07-31') }],
  },
  'EHS-CL-017-2025-20452': {
    rule: { kind: 'ONGOING_REVIEW', every: 'MONTH' },
    confidence: 11 / 12,
    mismatches: [{ expected: d('2022-07-30'), generated: d('2022-07-31') }],
  },
  'HRS-CL-014-3059-30387': {
    rule: {
      kind: 'FIXED_DATES',
      dates: [
        { month: 4, day: 30 },
        { month: 7, day: 30 },
        { month: 10, day: 29 },
        { month: 1, day: 30 },
      ],
    },
    confidence: 4 / 5,
    mismatches: [{ expected: d('2022-04-30'), generated: null }],
  },
  'HRS-CL-005-3174-30354': {
    rule: { kind: 'ANNUAL', month: 4, day: 30 },
    confidence: 1 / 2,
    mismatches: [{ expected: d('2022-04-30'), generated: null }],
  },
};

function d(value: string): LocalDate {
  return asLocalDate(value);
}

describe('golden: sample register FY 2022-23 due dates', () => {
  it('holds 424 rows and 119 obligations', () => {
    expect(rows).toHaveLength(424);
    expect(obligations.size).toBe(119);
  });

  it.each([...obligations.keys()])(
    '%s: the inferred rule regenerates the Excel due dates',
    (ref) => {
      const o = obligations.get(ref) as { timelineType: TimelineType; dueDates: LocalDate[] };
      const inferred = inferRule(o.dueDates, o.timelineType, cal, { coverage: fy });
      const expected = LOW_CONFIDENCE[ref];
      if (expected) {
        expect(inferred).toEqual({
          ...expected,
          confidence: expect.closeTo(expected.confidence, 9),
        });
        return;
      }
      expect(inferred.confidence).toBe(1);
      expect(inferred.mismatches).toEqual([]);
      const regenerated = generateInstances(inferred.rule, fy, cal).map((p) => p.dueDate);
      expect(regenerated).toEqual([...o.dueDates].sort());
    },
  );

  it('every low-confidence obligation is in the sample', () => {
    for (const ref of Object.keys(LOW_CONFIDENCE)) expect(obligations.has(ref)).toBe(true);
  });

  it('infers the expected mix of rule kinds', () => {
    const kinds: Record<string, number> = {};
    for (const o of obligations.values()) {
      const { kind } = inferRule(o.dueDates, o.timelineType, cal, { coverage: fy }).rule;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    expect(kinds).toEqual({ ONGOING_REVIEW: 76, ANNUAL: 28, FIXED_DATES: 11, MONTHLY: 4 });
  });
});

describe('golden: sample register scores (recommended profile, default settings)', () => {
  // Recommended profile: the two duplicate periods fold into their first row (fixtures.md §3), and the Complied row
  // without an Activity Date takes its due date. NOT_APPLICABLE keeps the date the NA was recorded.
  const seen = new Set<string>();
  const items: ScoreInput[] = [];
  rows.forEach((row, index) => {
    const key = `${row.ref}|${row.dueDate}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      instanceId: `01900000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      criticality: row.criticality,
      dueDate: row.dueDate,
      workflowState: row.workflowState,
      pendingKind: null,
      completedOn: row.workflowState === 'OPEN' ? null : (row.activityDate ?? row.dueDate),
    });
  });
  const settings: FirmSettings = {
    ...DEFAULT_FIRM_SETTINGS,
    criticalityWeights: { ...DEFAULT_FIRM_SETTINGS.criticalityWeights },
  };

  it('folds to 422 instances', () => {
    expect(items).toHaveLength(422);
  });

  it.each([
    [
      '2022-09-30',
      { COMPLIED: 209, NOT_APPLICABLE: 12, OVERDUE: 0, DUE_SOON: 0, UPCOMING: 201 },
      100.0,
      100.0,
    ],
    [
      '2022-12-15',
      { COMPLIED: 209, NOT_APPLICABLE: 12, OVERDUE: 3, DUE_SOON: 1, UPCOMING: 197 },
      97.9,
      98.1,
    ],
    [
      '2023-03-31',
      { COMPLIED: 209, NOT_APPLICABLE: 12, OVERDUE: 125, DUE_SOON: 76, UPCOMING: 0 },
      51.3,
      51.0,
    ],
  ])('asOf %s matches fixtures.md §4', (asOf, counts, score, onTimeRate) => {
    const r = computeScore(items, d(asOf), settings);
    expect(r.counts).toEqual({ ...counts, SUBMITTED: 0, COMPLIED_LATE: 0 });
    expect(r.score).toBe(score);
    expect(r.onTimeRate).toBe(onTimeRate);
  });
});

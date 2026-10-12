import {
  DEFAULT_FIRM_SETTINGS,
  ScoreResult,
  Breakdown,
  type Criticality,
  type FirmSettings,
  type ScoreInput,
  type WorkflowState,
} from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import {
  asLocalDate as d,
  computeBreakdown,
  computeScore,
  ENGINE_VERSION,
  summarizeKpis,
} from '../src/index.js';

const settings: FirmSettings = {
  ...DEFAULT_FIRM_SETTINGS,
  criticalityWeights: { ...DEFAULT_FIRM_SETTINGS.criticalityWeights },
};
let n = 0;
function item(
  dueDate: string,
  workflowState: WorkflowState,
  completedOn: string | null = null,
  criticality: Criticality = 'HIGH',
): ScoreInput {
  n += 1;
  return {
    instanceId: `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    criticality,
    dueDate: d(dueDate),
    workflowState,
    pendingKind: workflowState === 'SUBMITTED' ? 'COMPLETION' : null,
    completedOn: completedOn === null ? null : d(completedOn),
  };
}
const asOf = d('2023-03-31');

describe('computeScore', () => {
  it('weights on time fully, late by half, and ignores NA and items not yet due', () => {
    const items = [
      item('2023-01-31', 'APPROVED', '2023-01-30', 'SUPER_CRITICAL'), // 5 of 5
      item('2023-02-28', 'APPROVED', '2023-03-02', 'CRITICAL'), // 2 of 4
      item('2023-03-15', 'OPEN', null, 'LOW'), // 0 of 1, overdue
      item('2023-03-31', 'SUBMITTED', '2023-03-30', 'MEDIUM'), // 0 of 2, due today
      item('2022-12-31', 'NOT_APPLICABLE', '2022-06-01', 'SUPER_CRITICAL'), // excluded
      item('2023-04-15', 'APPROVED', '2023-03-20', 'SUPER_CRITICAL'), // not due yet: counted, not scored
      item('2023-06-30', 'OPEN'), // upcoming
      item('2023-04-03', 'SENT_BACK'), // due soon
    ];
    const r = computeScore(items, asOf, settings);
    expect(ScoreResult.safeParse(r).success).toBe(true);
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    expect(r.asOf).toBe('2023-03-31');
    expect(r.score).toBe(58.3); // 7 / 12
    expect(r.onTimeRate).toBe(25); // 1 of 4 due
    expect(r.counts).toEqual({
      UPCOMING: 1,
      DUE_SOON: 1,
      OVERDUE: 1,
      SUBMITTED: 1,
      COMPLIED: 2,
      COMPLIED_LATE: 1,
      NOT_APPLICABLE: 1,
    });
    expect(r.instanceIds.COMPLIED).toEqual([items[0]?.instanceId, items[5]?.instanceId]);
    expect(r.instanceIds.NOT_APPLICABLE).toEqual([items[4]?.instanceId]);
  });
  it('returns null, not 0 or 100, when nothing is due', () => {
    const r = computeScore(
      [item('2023-06-30', 'OPEN'), item('2022-04-30', 'NOT_APPLICABLE', '2022-04-01')],
      asOf,
      settings,
    );
    expect(r.score).toBeNull();
    expect(r.onTimeRate).toBeNull();
    expect(computeScore([], asOf, settings)).toMatchObject({
      score: null,
      onTimeRate: null,
      counts: { UPCOMING: 0 },
    });
  });
  it('returns a null score when every due item weighs zero', () => {
    const zero: FirmSettings = {
      ...settings,
      criticalityWeights: { ...settings.criticalityWeights, LOW: 0 },
    };
    const r = computeScore([item('2023-01-31', 'APPROVED', '2023-01-01', 'LOW')], asOf, zero);
    expect(r.score).toBeNull();
    expect(r.onTimeRate).toBe(100);
  });
  it('rounds half up to one decimal', () => {
    // 1 late of 8 due, unweighted-equal: score (7 + 0.5) / 8 = 93.75 → 93.8; on-time 7/8 = 87.5.
    const items = [
      ...Array.from({ length: 7 }, () => item('2023-01-31', 'APPROVED', '2023-01-31')),
      item('2023-01-31', 'APPROVED', '2023-02-01'),
    ];
    const r = computeScore(items, asOf, settings);
    expect(r.score).toBe(93.8);
    expect(r.onTimeRate).toBe(87.5);
    expect(
      computeScore(
        [
          item('2023-01-31', 'APPROVED', '2023-01-31'),
          item('2023-01-31', 'OPEN'),
          item('2023-01-31', 'OPEN'),
        ],
        asOf,
        settings,
      ).score,
    ).toBe(33.3);
  });
  it('uses dueSoonDays from firm settings', () => {
    const r = computeScore([item('2023-04-20', 'OPEN')], asOf, { ...settings, dueSoonDays: 30 });
    expect(r.counts.DUE_SOON).toBe(1);
  });
});

describe('computeBreakdown', () => {
  it('scores each group with computeScore and sorts rows by label', () => {
    const hr = [item('2023-01-31', 'APPROVED', '2023-01-31'), item('2023-02-28', 'OPEN')];
    const tax = [item('2023-01-31', 'APPROVED', '2023-01-31')];
    const b = computeBreakdown(
      'department',
      [
        { key: 'dept-tax', label: 'Tax', item: tax[0] as ScoreInput },
        { key: 'dept-hr', label: 'Human Resources', item: hr[0] as ScoreInput },
        { key: 'dept-hr', label: 'Human Resources', item: hr[1] as ScoreInput },
        { key: 'dept-hr-2', label: 'Human Resources', item: tax[0] as ScoreInput },
      ],
      asOf,
      settings,
    );
    expect(Breakdown.safeParse(b).success).toBe(true);
    expect(b.by).toBe('department');
    expect(b.rows.map((r) => r.key)).toEqual(['dept-hr', 'dept-hr-2', 'dept-tax']);
    expect(b.rows[0]?.result).toEqual(computeScore(hr, asOf, settings));
    expect(b.rows[2]?.result.score).toBe(100);
  });
  it('is empty for no items', () => {
    expect(computeBreakdown('act', [], asOf, settings)).toEqual({ by: 'act', rows: [] });
  });
});

describe('summarizeKpis', () => {
  it('derives the KPI tiles and their ids from the score result', () => {
    const items = [
      item('2023-03-01', 'OPEN'),
      item('2023-04-02', 'OPEN'),
      item('2023-09-30', 'SENT_BACK'),
      item('2023-03-01', 'SUBMITTED'),
      item('2023-03-01', 'APPROVED', '2023-03-01'),
    ];
    const k = summarizeKpis(computeScore(items, asOf, settings));
    expect(k.overdue).toEqual({ count: 1, instanceIds: [items[0]?.instanceId] });
    expect(k.dueSoon).toEqual({ count: 1, instanceIds: [items[1]?.instanceId] });
    expect(k.awaitingApproval).toEqual({ count: 1, instanceIds: [items[3]?.instanceId] });
    expect(k.open.count).toBe(3);
    expect(k.open.instanceIds).toEqual([
      items[2]?.instanceId,
      items[1]?.instanceId,
      items[0]?.instanceId,
    ]);
  });
});

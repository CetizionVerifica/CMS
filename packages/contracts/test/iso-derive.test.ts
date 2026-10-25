// The mock's objectiveProgress stand-in (docs/iso/model.md §5.1, docs/contracts/iso-mock.md "Stand-ins for M4
// formulas", README decision 51 r) at a day boundary: the creation day is the objective's createdAt as a date in the
// client's time zone, so the reading periods it owes and the start of its on-track line move with that zone, and
// reading periods follow the client's financial year.
import { describe, expect, it } from 'vitest';
import { objectiveProgress } from '../src/mock/iso/derive.js';
import type { IsoRow } from '../src/mock/store.js';
import { base, PERSON, seedId } from './iso-harness.js';

type Objective = IsoRow<'objectives'>;
type Reading = Parameters<typeof objectiveProgress>[1][number];

/** 01:30 on 1 April 2026 in Kolkata, still 31 March in UTC. */
const AFTER_IST_MIDNIGHT = '2026-03-31T20:00:00Z';
const KOLKATA = { fyStartMonth: 4, timeZone: 'Asia/Kolkata' };
const UTC = { fyStartMonth: 4, timeZone: 'UTC' };

const MARCH = { periodStart: '2026-03-01', periodEnd: '2026-03-31' };

/** An objective for FY 2026-27, from 80 up to 92 with a monthly reading due on the month's last day. */
function objective(fields: Partial<Objective> = {}): Objective {
  return {
    ...base(),
    createdAt: AFTER_IST_MIDNIGHT,
    managementSystemId: seedId(),
    standards: ['ISO_14001'],
    text: 'Raise the share of waste recycled',
    target: 92,
    unitOfMeasure: '%',
    baseline: 80,
    direction: 'INCREASE',
    readingRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    riskItemIds: [],
    ownerId: PERSON.sameer,
    dueOn: '2027-03-31',
    closedOn: null,
    outcome: null,
    ...fields,
  };
}

const reading = (periodStart: string, periodEnd: string, value: number): Reading => ({
  periodStart,
  periodEnd,
  value,
});

describe('objectiveProgress at a day boundary in the client’s time zone', () => {
  it('owes no March reading for an objective set after midnight IST, where a UTC client owes one', () => {
    // March fell due on 31 March: the day before the Kolkata creation day, and the UTC creation day itself.
    const set = objective();
    const april = [reading('2026-04-01', '2026-04-30', 83)];
    expect(objectiveProgress(set, april, '2026-05-15', KOLKATA).missedReadings).toEqual([]);
    expect(objectiveProgress(set, april, '2026-05-15', UTC).missedReadings).toEqual([MARCH]);
  });

  it('owes no January-March quarter that ended before the local creation day, though it fell due after it', () => {
    // January-March falls due on 30 April, after either creation day, but ended on 31 March. April-June falls due
    // on 30 July, so it is missed from 31 July on.
    const set = objective({
      readingRule: { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 30 },
    });
    const firstQuarter = { periodStart: '2026-01-01', periodEnd: '2026-03-31' };
    const secondQuarter = { periodStart: '2026-04-01', periodEnd: '2026-06-30' };
    expect(objectiveProgress(set, [], '2026-07-30', KOLKATA).missedReadings).toEqual([]);
    expect(objectiveProgress(set, [], '2026-07-31', KOLKATA).missedReadings).toEqual([
      secondQuarter,
    ]);
    expect(objectiveProgress(set, [], '2026-07-30', UTC).missedReadings).toEqual([firstQuarter]);
    expect(objectiveProgress(set, [], '2026-07-31', UTC).missedReadings).toEqual([
      firstQuarter,
      secondQuarter,
    ]);
  });

  it('cuts half-years from the client’s financial year', () => {
    // Set on 15 January 2026, read on 31 January 2027, half-years due 30 days after they end. From April:
    // October-March (due 30 April) and April-September (due 30 October). From January: July-December 2025 falls due
    // on 30 January 2026 but ended before the creation day; January-June (due 30 July) and July-December (due
    // 30 January 2027) are missed.
    const set = objective({
      createdAt: '2026-01-15T06:30:00Z',
      readingRule: { kind: 'HALF_YEARLY', anchor: 'AFTER_PERIOD_END', days: 30 },
    });
    expect(objectiveProgress(set, [], '2027-01-31', KOLKATA).missedReadings).toEqual([
      { periodStart: '2025-10-01', periodEnd: '2026-03-31' },
      { periodStart: '2026-04-01', periodEnd: '2026-09-30' },
    ]);
    expect(
      objectiveProgress(set, [], '2027-01-31', { ...KOLKATA, fyStartMonth: 1 }).missedReadings,
    ).toEqual([
      { periodStart: '2026-01-01', periodEnd: '2026-06-30' },
      { periodStart: '2026-07-01', periodEnd: '2026-12-31' },
    ]);
  });

  it('starts the on-track line at the baseline on the client-local creation day', () => {
    // A reading of 80 taken on 1 April: on the Kolkata creation day the line stands at the baseline, so it is on
    // track; for a UTC client 1 April is one day along the line (80 + 12 × 1/365), so the same reading is behind.
    const set = objective();
    const dayOne = [reading('2026-04-01', '2026-04-01', 80)];
    expect(objectiveProgress(set, dayOne, '2026-04-02', KOLKATA)).toEqual({
      objectiveId: set.id,
      latestValue: 80,
      latestPeriodEnd: '2026-04-01',
      progressPercent: 0,
      onTrack: true,
      missedReadings: [],
    });
    expect(objectiveProgress(set, dayOne, '2026-04-02', UTC)).toEqual({
      objectiveId: set.id,
      latestValue: 80,
      latestPeriodEnd: '2026-04-01',
      progressPercent: 0,
      onTrack: false,
      missedReadings: [MARCH],
    });
  });

  it('measures progressPercent from the baseline, whatever the creation day', () => {
    // 83 covers 3 of the 12 points from 80 to 92. On 30 April the line stands near 81 in either zone.
    const set = objective();
    const april = [reading('2026-04-01', '2026-04-30', 83)];
    const progress = {
      objectiveId: set.id,
      latestValue: 83,
      latestPeriodEnd: '2026-04-30',
      progressPercent: 25,
      onTrack: true,
    };
    expect(objectiveProgress(set, april, '2026-05-01', KOLKATA)).toEqual({
      ...progress,
      missedReadings: [],
    });
    expect(objectiveProgress(set, april, '2026-05-01', UTC)).toEqual({
      ...progress,
      missedReadings: [MARCH],
    });
  });
});

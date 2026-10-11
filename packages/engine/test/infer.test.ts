import { InferredRule } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { asLocalDate, generateInstances, inferRule, type Calendar } from '../src/index.js';

const india: Calendar = { fyStartMonth: 4, holidayPolicy: 'NONE' };
const ds = (...dates: string[]) => dates.map(asLocalDate);
const fy2223 = { from: asLocalDate('2022-04-01'), to: asLocalDate('2023-03-31') };
const fy2324 = { from: asLocalDate('2023-04-01'), to: asLocalDate('2024-03-31') };

describe('inferRule', () => {
  it('quarter ends of an ONGOING obligation are a quarterly review', () => {
    const r = inferRule(
      ds('2022-06-30', '2022-09-30', '2022-12-31', '2023-03-31'),
      'ONGOING',
      india,
    );
    expect(r).toEqual({
      rule: { kind: 'ONGOING_REVIEW', every: 'QUARTER' },
      confidence: 1,
      mismatches: [],
    });
    expect(InferredRule.safeParse(r).success).toBe(true);
  });
  it('the same dates on a TIME_BASED obligation are QUARTERLY at period end', () => {
    expect(
      inferRule(ds('2022-06-30', '2022-09-30', '2022-12-31', '2023-03-31'), 'TIME_BASED', india)
        .rule,
    ).toEqual({
      kind: 'QUARTERLY',
      anchor: 'PERIOD_END',
      days: 0,
    });
  });
  it('a quarter-close window ("within 15 days") is QUARTERLY after period end', () => {
    expect(
      inferRule(ds('2022-04-15', '2022-07-15', '2022-10-15', '2023-01-15'), 'TIME_BASED', india),
    ).toEqual({
      rule: { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 15 },
      confidence: 1,
      mismatches: [],
    });
  });
  it('days before the period end are QUARTERLY PERIOD_END with days', () => {
    expect(
      inferRule(ds('2022-06-25', '2022-09-25', '2022-12-26', '2023-03-26'), 'TIME_BASED', india)
        .rule,
    ).toEqual({
      kind: 'QUARTERLY',
      anchor: 'PERIOD_END',
      days: 5,
    });
  });
  it('FY half ends are HALF_YEARLY', () => {
    expect(inferRule(ds('2022-04-30', '2022-10-30'), 'TIME_BASED', india).rule).toEqual({
      kind: 'HALF_YEARLY',
      anchor: 'AFTER_PERIOD_END',
      days: 30,
    });
  });
  it('a single date over a full-year register is ANNUAL', () => {
    expect(inferRule(ds('2023-02-01'), 'TIME_BASED', india, { coverage: fy2223 })).toEqual({
      rule: { kind: 'ANNUAL', month: 2, day: 1 },
      confidence: 1,
      mismatches: [],
    });
  });
  it('a single date with no coverage is ambiguous: the sparsest rule at half confidence', () => {
    expect(inferRule(ds('2023-02-01'), 'TIME_BASED', india)).toEqual({
      rule: { kind: 'ANNUAL', month: 2, day: 1 },
      confidence: 0.5,
      mismatches: [],
    });
    expect(inferRule(ds('2022-09-30'), 'ONGOING', india, { coverage: fy2223 }).rule).toEqual({
      kind: 'ANNUAL',
      month: 9,
      day: 30,
    });
  });
  it('calendar half-year dates that FY halves cannot express become FIXED_DATES', () => {
    const r = inferRule(ds('2022-06-30', '2022-12-31'), 'TIME_BASED', india, { coverage: fy2223 });
    expect(r.confidence).toBe(1);
    expect(r.rule).toEqual({
      kind: 'FIXED_DATES',
      dates: [
        { month: 6, day: 30 },
        { month: 12, day: 31 },
      ],
    });
  });
  it('TDS by the 7th is MONTHLY for the previous month', () => {
    const dates = ds(
      ...['04', '05', '06', '07', '08', '09', '10', '11', '12'].map((m) => `2022-${m}-07`),
      '2023-01-07',
      '2023-02-07',
      '2023-03-07',
    );
    expect(inferRule(dates, 'TIME_BASED', india)).toEqual({
      rule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
      confidence: 1,
      mismatches: [],
    });
  });
  it('month ends are MONTHLY LAST for TIME_BASED and a monthly review for ONGOING', () => {
    const dates = generateInstances(
      { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
      { from: asLocalDate('2022-04-01'), to: asLocalDate('2023-03-31') },
      india,
    ).map((p) => p.dueDate);
    expect(inferRule(dates, 'TIME_BASED', india).rule).toEqual({
      kind: 'MONTHLY',
      day: 'LAST',
      offsetMonths: 0,
    });
    expect(inferRule(dates, 'ONGOING', india).rule).toEqual({
      kind: 'ONGOING_REVIEW',
      every: 'MONTH',
    });
  });
  it('drifting monthly dates give MONTHLY with confidence below 1 and the nearest generated date', () => {
    const dates = ds(
      '2022-04-15',
      '2022-05-14',
      '2022-06-15',
      '2022-07-15',
      '2022-08-15',
      '2022-09-15',
      '2022-10-15',
      '2022-11-15',
      '2022-12-15',
      '2023-01-14',
      '2023-02-15',
      '2023-03-15',
    );
    const r = inferRule(dates, 'TIME_BASED', india);
    expect(r.rule).toEqual({ kind: 'MONTHLY', day: 15, offsetMonths: 1 });
    expect(r.confidence).toBeCloseTo(10 / 12);
    expect(r.mismatches).toEqual([
      { expected: '2022-05-14', generated: '2022-05-15' },
      { expected: '2023-01-14', generated: '2023-01-15' },
    ]);
  });
  it('a duplicate date is a mismatch with nothing generated', () => {
    expect(inferRule(ds('2022-04-30', '2022-04-30'), 'TIME_BASED', india)).toEqual({
      rule: { kind: 'ANNUAL', month: 4, day: 30 },
      confidence: 0.5,
      mismatches: [{ expected: '2022-04-30', generated: null }],
    });
  });
  it('accepts unsorted input and spans several FYs', () => {
    const r = inferRule(ds('2024-03-31', '2022-03-31', '2023-03-31'), 'ONGOING', india);
    expect(r).toEqual({
      rule: { kind: 'ONGOING_REVIEW', every: 'YEAR' },
      confidence: 1,
      mismatches: [],
    });
  });
  it('counts generated dates the register lacks against confidence', () => {
    // Five of six month ends: the monthly review generates one date nobody holds.
    const r = inferRule(
      ds(
        '2022-04-30',
        '2022-05-31',
        '2022-06-30',
        '2022-07-31',
        '2022-08-31',
        '2022-09-30',
        '2022-10-31',
        '2022-11-30',
        '2022-12-31',
        '2023-01-31',
        '2023-02-28',
      ),
      'ONGOING',
      india,
      { coverage: fy2223 },
    );
    expect(r.rule).toEqual({ kind: 'ONGOING_REVIEW', every: 'MONTH' });
    expect(r.confidence).toBeCloseTo(11 / 12);
    expect(r.mismatches).toEqual([]);
  });
  it('honours the calendar (fyStartMonth 1)', () => {
    const cal: Calendar = { fyStartMonth: 1, holidayPolicy: 'NONE' };
    expect(inferRule(ds('2023-06-30', '2023-12-31'), 'TIME_BASED', cal).rule).toEqual({
      kind: 'HALF_YEARLY',
      anchor: 'PERIOD_END',
      days: 0,
    });
  });
  it('needs at least one date', () => {
    expect(() => inferRule([], 'TIME_BASED', india)).toThrow(RangeError);
  });
});

describe('inferRule on part-year registers (client onboarded mid-year)', () => {
  const tdsDecToMar = ds('2022-12-07', '2023-01-07', '2023-02-07', '2023-03-07');
  it('TDS by the 7th from December to March is MONTHLY and regenerates 12 deposits next FY', () => {
    const r = inferRule(tdsDecToMar, 'TIME_BASED', india);
    expect(r).toEqual({
      rule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
      confidence: 1,
      mismatches: [],
    });
    expect(generateInstances(r.rule, fy2324, india)).toHaveLength(12);
  });
  it('with full-FY coverage, the same TDS register keeps MONTHLY but below confidence 1', () => {
    const r = inferRule(tdsDecToMar, 'TIME_BASED', india, { coverage: fy2223 });
    expect(r.rule).toEqual({ kind: 'MONTHLY', day: 7, offsetMonths: 1 });
    expect(r.confidence).toBeCloseTo(4 / 12);
    expect(r.mismatches).toEqual([]);
    expect(generateInstances(r.rule, fy2324, india)).toHaveLength(12);
    const janToMar = inferRule(ds('2023-01-07', '2023-02-07', '2023-03-07'), 'TIME_BASED', india, {
      coverage: fy2223,
    });
    expect(janToMar.rule).toEqual({ kind: 'MONTHLY', day: 7, offsetMonths: 1 });
    expect(janToMar.confidence).toBeCloseTo(3 / 12);
  });
  it('quarter-end reviews for Q3 and Q4 only are a quarterly review, below confidence 1 with or without coverage', () => {
    const r = inferRule(ds('2022-12-31', '2023-03-31'), 'ONGOING', india);
    expect(r).toEqual({
      rule: { kind: 'ONGOING_REVIEW', every: 'QUARTER' },
      confidence: 0.5,
      mismatches: [],
    });
    const covered = inferRule(ds('2022-12-31', '2023-03-31'), 'ONGOING', india, {
      coverage: fy2223,
    });
    expect(covered.rule).toEqual({ kind: 'ONGOING_REVIEW', every: 'QUARTER' });
    expect(covered.confidence).toBe(0.5);
    expect(generateInstances(covered.rule, fy2324, india)).toHaveLength(4);
  });
  it('"within 15 days of quarter close" seen twice is QUARTERLY after period end, flagged', () => {
    expect(inferRule(ds('2023-01-15', '2023-04-15'), 'TIME_BASED', india)).toEqual({
      rule: { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 15 },
      confidence: 0.5,
      mismatches: [],
    });
    const covered = inferRule(ds('2023-01-15', '2023-04-15'), 'TIME_BASED', india, {
      coverage: { from: asLocalDate('2022-04-16'), to: asLocalDate('2023-04-15') },
    });
    expect(covered.rule).toEqual({ kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 15 });
    expect(covered.confidence).toBe(0.5);
  });
  it('month ends from October to March are MONTHLY LAST: certain alone, flagged with full-FY coverage', () => {
    const dates = ds(
      '2022-10-31',
      '2022-11-30',
      '2022-12-31',
      '2023-01-31',
      '2023-02-28',
      '2023-03-31',
    );
    expect(inferRule(dates, 'TIME_BASED', india)).toEqual({
      rule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
      confidence: 1,
      mismatches: [],
    });
    const covered = inferRule(dates, 'TIME_BASED', india, { coverage: fy2223 });
    expect(covered.rule).toEqual({ kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 });
    expect(covered.confidence).toBe(0.5);
  });
  it('four quarters across the FY boundary give the right rule at full confidence', () => {
    expect(
      inferRule(ds('2022-07-15', '2022-10-15', '2023-01-15', '2023-04-15'), 'TIME_BASED', india),
    ).toEqual({
      rule: { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 15 },
      confidence: 1,
      mismatches: [],
    });
  });
  it('a gap between the first and last date is real evidence: FIXED_DATES stays certain over a full year', () => {
    // 30 Sep is missing between 30 Jun and 31 Dec, so this is not a quarterly review.
    const r = inferRule(ds('2022-06-30', '2022-12-31'), 'ONGOING', india, { coverage: fy2223 });
    expect(r.rule).toEqual({
      kind: 'FIXED_DATES',
      dates: [
        { month: 6, day: 30 },
        { month: 12, day: 31 },
      ],
    });
    expect(r.confidence).toBe(1);
  });
  it('only uses FIXED_DATES when no periodic rule fits, and flags it from a part-year window', () => {
    const r = inferRule(ds('2022-05-10', '2022-11-10'), 'TIME_BASED', india);
    expect(r).toEqual({
      rule: {
        kind: 'FIXED_DATES',
        dates: [
          { month: 5, day: 10 },
          { month: 11, day: 10 },
        ],
      },
      confidence: 0.5,
      mismatches: [],
    });
    // A periodic rule that fits better at part-year confidence beats it: calendar half-year ends seen once each.
    const q = inferRule(ds('2022-06-30', '2022-12-31'), 'TIME_BASED', india);
    expect(q.rule).toEqual({ kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 });
    expect(q.confidence).toBeCloseTo(2 / 3);
  });
  it('keeps the best periodic rule when FIXED_DATES is not tried', () => {
    // Monthly dates with two drifts: too many month/days for FIXED_DATES, so MONTHLY with mismatches.
    const r = inferRule(
      ds('2022-11-07', '2022-12-06', '2023-01-07', '2023-02-06', '2023-03-07'),
      'TIME_BASED',
      india,
    );
    expect(r.rule).toEqual({ kind: 'MONTHLY', day: 7, offsetMonths: 1 });
    expect(r.confidence).toBeCloseTo(3 / 5);
  });
  it('never gives full confidence from fewer than three dates without coverage', () => {
    expect(inferRule(ds('2022-04-07', '2022-05-07'), 'TIME_BASED', india).confidence).toBe(0.5);
    expect(inferRule(ds('2022-06-30', '2022-09-30'), 'ONGOING', india).confidence).toBe(0.5);
    expect(
      inferRule(ds('2022-04-07', '2022-05-07', '2022-06-07'), 'TIME_BASED', india).confidence,
    ).toBe(1);
  });
  it('widens a coverage that does not include every date', () => {
    const coverage = { from: asLocalDate('2022-04-01'), to: asLocalDate('2022-06-30') };
    const r = inferRule(ds('2022-03-31', '2022-06-30'), 'ONGOING', india, { coverage });
    expect(r).toEqual({
      rule: { kind: 'ONGOING_REVIEW', every: 'QUARTER' },
      confidence: 1,
      mismatches: [],
    });
  });
});

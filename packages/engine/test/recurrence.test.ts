import type { RecurrenceRule } from '@canopy/contracts';
import { RecurrenceRule as RecurrenceRuleSchema, GeneratedPeriod } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import {
  adjustDueDate,
  asLocalDate as d,
  eventInstance,
  generateInstances,
  type Calendar,
} from '../src/index.js';

const india: Calendar = { fyStartMonth: 4, holidayPolicy: 'NONE' };
const fy2223 = { from: d('2022-04-01'), to: d('2023-03-31') };

function dues(rule: RecurrenceRule, range = fy2223, cal: Calendar = india): string[] {
  return generateInstances(RecurrenceRuleSchema.parse(rule), range, cal).map((p) => p.dueDate);
}

describe('generateInstances', () => {
  it('MONTHLY day 7 of the following month (TDS deposit), FY 2022-23', () => {
    const periods = generateInstances({ kind: 'MONTHLY', day: 7, offsetMonths: 1 }, fy2223, india);
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({
      periodStart: '2022-03-01',
      periodEnd: '2022-03-31',
      dueDate: '2022-04-07',
    });
    expect(periods[11]).toEqual({
      periodStart: '2023-02-01',
      periodEnd: '2023-02-28',
      dueDate: '2023-03-07',
    });
    for (const p of periods) expect(GeneratedPeriod.safeParse(p).success).toBe(true);
  });
  it('MONTHLY day 30 clamps to February, in leap and common years', () => {
    expect(
      dues(
        { kind: 'MONTHLY', day: 30, offsetMonths: 0 },
        { from: d('2023-02-01'), to: d('2024-03-31') },
      ),
    ).toEqual([
      '2023-02-28',
      '2023-03-30',
      '2023-04-30',
      '2023-05-30',
      '2023-06-30',
      '2023-07-30',
      '2023-08-30',
      '2023-09-30',
      '2023-10-30',
      '2023-11-30',
      '2023-12-30',
      '2024-01-30',
      '2024-02-29',
      '2024-03-30',
    ]);
  });
  it('MONTHLY LAST gives month ends', () => {
    expect(
      dues(
        { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
        { from: d('2024-01-01'), to: d('2024-04-30') },
      ),
    ).toEqual(['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
  });
  it('QUARTERLY within 15 days after quarter close, on FY quarters', () => {
    const periods = generateInstances(
      { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 15 },
      fy2223,
      india,
    );
    expect(periods).toEqual([
      { periodStart: '2022-01-01', periodEnd: '2022-03-31', dueDate: '2022-04-15' },
      { periodStart: '2022-04-01', periodEnd: '2022-06-30', dueDate: '2022-07-15' },
      { periodStart: '2022-07-01', periodEnd: '2022-09-30', dueDate: '2022-10-15' },
      { periodStart: '2022-10-01', periodEnd: '2022-12-31', dueDate: '2023-01-15' },
    ]);
  });
  it('QUARTERLY at period end, and days before it', () => {
    expect(dues({ kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 })).toEqual([
      '2022-06-30',
      '2022-09-30',
      '2022-12-31',
      '2023-03-31',
    ]);
    expect(dues({ kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 5 })).toEqual([
      '2022-06-25',
      '2022-09-25',
      '2022-12-26',
      '2023-03-26',
    ]);
  });
  it('HALF_YEARLY follows FY halves (Apr-Sep, Oct-Mar)', () => {
    expect(
      generateInstances({ kind: 'HALF_YEARLY', anchor: 'PERIOD_END', days: 0 }, fy2223, india),
    ).toEqual([
      { periodStart: '2022-04-01', periodEnd: '2022-09-30', dueDate: '2022-09-30' },
      { periodStart: '2022-10-01', periodEnd: '2023-03-31', dueDate: '2023-03-31' },
    ]);
    expect(dues({ kind: 'HALF_YEARLY', anchor: 'AFTER_PERIOD_END', days: 30 })).toEqual([
      '2022-04-30',
      '2022-10-30',
    ]);
  });
  it('ANNUAL falls inside its FY (1 Feb return belongs to the FY it falls in)', () => {
    expect(generateInstances({ kind: 'ANNUAL', month: 2, day: 1 }, fy2223, india)).toEqual([
      { periodStart: '2022-04-01', periodEnd: '2023-03-31', dueDate: '2023-02-01' },
    ]);
    expect(dues({ kind: 'ANNUAL', month: 4, day: 30 })).toEqual(['2022-04-30']);
  });
  it('ANNUAL on 29 Feb clamps to 28 Feb in common years', () => {
    expect(
      dues({ kind: 'ANNUAL', month: 2, day: 29 }, { from: d('2022-04-01'), to: d('2025-03-31') }),
    ).toEqual(['2023-02-28', '2024-02-29', '2025-02-28']);
  });
  it('FIXED_DATES: each date closes a period that starts after the previous one', () => {
    const rule: RecurrenceRule = {
      kind: 'FIXED_DATES',
      dates: [
        { month: 4, day: 30 },
        { month: 7, day: 30 },
        { month: 10, day: 30 },
        { month: 1, day: 30 },
      ],
    };
    expect(generateInstances(rule, fy2223, india)).toEqual([
      { periodStart: '2022-01-31', periodEnd: '2022-04-30', dueDate: '2022-04-30' },
      { periodStart: '2022-05-01', periodEnd: '2022-07-30', dueDate: '2022-07-30' },
      { periodStart: '2022-07-31', periodEnd: '2022-10-30', dueDate: '2022-10-30' },
      { periodStart: '2022-10-31', periodEnd: '2023-01-30', dueDate: '2023-01-30' },
    ]);
  });
  it('FIXED_DATES folds 29 Feb onto an existing 28 Feb in common years', () => {
    const rule: RecurrenceRule = {
      kind: 'FIXED_DATES',
      dates: [
        { month: 2, day: 28 },
        { month: 2, day: 29 },
      ],
    };
    expect(dues(rule, { from: d('2023-01-01'), to: d('2024-12-31') })).toEqual([
      '2023-02-28',
      '2024-02-28',
      '2024-02-29',
    ]);
  });
  it('ONGOING_REVIEW at the end of each month, quarter, half and year', () => {
    expect(dues({ kind: 'ONGOING_REVIEW', every: 'QUARTER' })).toEqual([
      '2022-06-30',
      '2022-09-30',
      '2022-12-31',
      '2023-03-31',
    ]);
    expect(dues({ kind: 'ONGOING_REVIEW', every: 'MONTH' })).toHaveLength(12);
    expect(dues({ kind: 'ONGOING_REVIEW', every: 'HALF_YEAR' })).toEqual([
      '2022-09-30',
      '2023-03-31',
    ]);
    expect(generateInstances({ kind: 'ONGOING_REVIEW', every: 'YEAR' }, fy2223, india)).toEqual([
      { periodStart: '2022-04-01', periodEnd: '2023-03-31', dueDate: '2023-03-31' },
    ]);
  });
  it('honours a calendar-year FY (fyStartMonth 1)', () => {
    const cal: Calendar = { fyStartMonth: 1, holidayPolicy: 'NONE' };
    expect(
      dues(
        { kind: 'ONGOING_REVIEW', every: 'QUARTER' },
        { from: d('2023-01-01'), to: d('2023-12-31') },
        cal,
      ),
    ).toEqual(['2023-03-31', '2023-06-30', '2023-09-30', '2023-12-31']);
    expect(
      dues(
        { kind: 'HALF_YEARLY', anchor: 'AFTER_PERIOD_END', days: 30 },
        { from: d('2023-01-01'), to: d('2023-12-31') },
        cal,
      ),
    ).toEqual(['2023-01-30', '2023-07-30']);
  });
  it('ONE_TIME yields its date only when in range', () => {
    const rule: RecurrenceRule = { kind: 'ONE_TIME', dueDate: d('2022-11-15') };
    expect(generateInstances(rule, fy2223, india)).toEqual([
      { periodStart: '2022-11-15', periodEnd: '2022-11-15', dueDate: '2022-11-15' },
    ]);
    expect(dues(rule, { from: d('2023-04-01'), to: d('2024-03-31') })).toEqual([]);
  });
  it('EVENT_DRIVEN never generates from the calendar', () => {
    expect(dues({ kind: 'EVENT_DRIVEN', trigger: 'Accident', withinDays: 2 })).toEqual([]);
  });
  it('includes both range ends and nothing outside them', () => {
    expect(
      dues(
        { kind: 'ONGOING_REVIEW', every: 'MONTH' },
        { from: d('2023-03-31'), to: d('2023-04-30') },
      ),
    ).toEqual(['2023-03-31', '2023-04-30']);
    expect(
      dues(
        { kind: 'ONGOING_REVIEW', every: 'MONTH' },
        { from: d('2023-04-01'), to: d('2023-04-29') },
      ),
    ).toEqual([]);
  });
  it('is idempotent: re-running gives the same unique period starts', () => {
    const rule: RecurrenceRule = { kind: 'MONTHLY', day: 7, offsetMonths: 1 };
    const a = generateInstances(rule, fy2223, india);
    expect(generateInstances(rule, fy2223, india)).toEqual(a);
    expect(new Set(a.map((p) => p.periodStart)).size).toBe(a.length);
    const twoYears = generateInstances(rule, { from: d('2022-04-01'), to: d('2024-03-31') }, india);
    expect(twoYears.slice(0, 12)).toEqual(a);
  });
  it('rejects a range that ends before it starts', () => {
    expect(() =>
      generateInstances(
        { kind: 'ONGOING_REVIEW', every: 'YEAR' },
        { from: d('2023-04-01'), to: d('2023-03-31') },
        india,
      ),
    ).toThrow(RangeError);
  });
});

describe('holiday policy', () => {
  // 2022-07-31 and 2023-04-30 are Sundays.
  const sunday = d('2022-07-31');
  it('NONE leaves Sundays alone', () => {
    expect(adjustDueDate(sunday, india)).toBe('2022-07-31');
  });
  it('NEXT_WORKING_DAY moves past Sundays and holidays', () => {
    expect(adjustDueDate(sunday, { ...india, holidayPolicy: 'NEXT_WORKING_DAY' })).toBe(
      '2022-08-01',
    );
    expect(
      adjustDueDate(sunday, {
        ...india,
        holidayPolicy: 'NEXT_WORKING_DAY',
        holidays: [d('2022-08-01')],
      }),
    ).toBe('2022-08-02');
    expect(
      adjustDueDate(d('2022-08-15'), {
        ...india,
        holidayPolicy: 'NEXT_WORKING_DAY',
        holidays: [d('2022-08-15')],
      }),
    ).toBe('2022-08-16');
  });
  it('PREVIOUS_WORKING_DAY moves back, leaving Saturdays as working days', () => {
    expect(adjustDueDate(sunday, { ...india, holidayPolicy: 'PREVIOUS_WORKING_DAY' })).toBe(
      '2022-07-30',
    );
    expect(
      adjustDueDate(d('2022-07-30'), { ...india, holidayPolicy: 'PREVIOUS_WORKING_DAY' }),
    ).toBe('2022-07-30');
  });
  it('filters on the adjusted date, so a due date can move across the FY boundary', () => {
    const cal: Calendar = { fyStartMonth: 4, holidayPolicy: 'NEXT_WORKING_DAY' };
    // 2023-04-30 is a Sunday; the April 2023 monthly-LAST period moves to 1 May.
    expect(
      dues(
        { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
        { from: d('2023-04-01'), to: d('2023-04-30') },
        cal,
      ),
    ).toEqual([]);
    expect(
      dues(
        { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
        { from: d('2023-05-01'), to: d('2023-05-01') },
        cal,
      ),
    ).toEqual(['2023-05-01']);
  });
  it('orders periods that land on the same adjusted due date by period start', () => {
    const february = Array.from({ length: 28 }, (_, i) =>
      d(`2023-02-${String(i + 1).padStart(2, '0')}`),
    );
    const cal: Calendar = {
      fyStartMonth: 4,
      holidayPolicy: 'PREVIOUS_WORKING_DAY',
      holidays: february,
    };
    expect(
      generateInstances(
        { kind: 'ONGOING_REVIEW', every: 'MONTH' },
        { from: d('2023-01-31'), to: d('2023-01-31') },
        cal,
      ),
    ).toEqual([
      { periodStart: '2023-01-01', periodEnd: '2023-01-31', dueDate: '2023-01-31' },
      { periodStart: '2023-02-01', periodEnd: '2023-02-28', dueDate: '2023-01-31' },
    ]);
  });
});

describe('eventInstance', () => {
  it('is due withinDays after the event, adjusted for holidays', () => {
    const rule = { kind: 'EVENT_DRIVEN', trigger: 'Accident', withinDays: 2 } as const;
    expect(eventInstance(rule, d('2023-03-30'), india)).toEqual({
      periodStart: '2023-03-30',
      periodEnd: '2023-03-30',
      dueDate: '2023-04-01',
    });
    expect(
      eventInstance(rule, d('2022-07-29'), { ...india, holidayPolicy: 'NEXT_WORKING_DAY' }).dueDate,
    ).toBe('2022-08-01');
  });
});

import { describe, expect, it } from 'vitest';
import { GeneratedPeriod, InferredRule, RecurrenceRule } from '../src/index.js';

describe('RecurrenceRule', () => {
  it.each([
    { kind: 'ONE_TIME', dueDate: '2023-03-31' },
    { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
    { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 15 },
    { kind: 'HALF_YEARLY', anchor: 'PERIOD_END', days: 0 },
    { kind: 'ANNUAL', month: 2, day: 1 },
    { kind: 'ANNUAL', month: 2, day: 29 },
    {
      kind: 'FIXED_DATES',
      dates: [
        { month: 4, day: 30 },
        { month: 7, day: 30 },
        { month: 10, day: 30 },
        { month: 1, day: 30 },
      ],
    },
    { kind: 'ONGOING_REVIEW', every: 'QUARTER' },
    { kind: 'EVENT_DRIVEN', trigger: 'Accident at site', withinDays: 2 },
  ])('accepts $kind', (rule) => {
    expect(RecurrenceRule.safeParse(rule).success).toBe(true);
  });

  it.each([
    ['unknown kind', { kind: 'WEEKLY' }],
    ['one-time date that does not exist', { kind: 'ONE_TIME', dueDate: '2023-02-29' }],
    ['monthly day 32', { kind: 'MONTHLY', day: 32, offsetMonths: 0 }],
    ['monthly offset 2', { kind: 'MONTHLY', day: 7, offsetMonths: 2 }],
    ['quarterly negative days', { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: -1 }],
    ['quarterly bad anchor', { kind: 'QUARTERLY', anchor: 'START', days: 15 }],
    ['annual 31 April', { kind: 'ANNUAL', month: 4, day: 31 }],
    ['annual 30 Feb', { kind: 'ANNUAL', month: 2, day: 30 }],
    ['fixed dates empty', { kind: 'FIXED_DATES', dates: [] }],
    ['fixed date 31 Jun', { kind: 'FIXED_DATES', dates: [{ month: 6, day: 31 }] }],
    ['ongoing every week', { kind: 'ONGOING_REVIEW', every: 'WEEK' }],
    ['event with empty trigger', { kind: 'EVENT_DRIVEN', trigger: ' ', withinDays: 2 }],
    ['extra key', { kind: 'MONTHLY', day: 7, offsetMonths: 1, month: 4 }],
  ])('rejects %s', (_name, rule) => {
    expect(RecurrenceRule.safeParse(rule).success).toBe(false);
  });

  it('parses generated periods and inferred rules', () => {
    expect(
      GeneratedPeriod.safeParse({
        periodStart: '2023-03-01',
        periodEnd: '2023-03-31',
        dueDate: '2023-04-07',
      }).success,
    ).toBe(true);
    const inferred = {
      rule: { kind: 'MONTHLY', day: 15, offsetMonths: 1 },
      confidence: 0.83,
      mismatches: [{ expected: '2022-05-14', generated: '2022-05-15' }],
    };
    expect(InferredRule.safeParse(inferred).success).toBe(true);
    expect(InferredRule.safeParse({ ...inferred, confidence: 1.2 }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  addDays,
  addMonths,
  daysInMonth,
  isValidIso,
  monthWeeks,
  parseDateInput,
  weekdayMon0,
} from './calendarDate';
import {
  fyLabel,
  fyMonths,
  fyStartYear,
  monthLabel,
  periodLabel,
  periodName,
  quarterLabel,
  quarterMonths,
  samePeriod,
} from './period';

describe('period labels', () => {
  it('formats FY keys with an en dash', () => {
    expect(fyStartYear('2022-23')).toBe(2022);
    expect(fyLabel('2022-23')).toBe('FY 2022–23');
  });

  it('lays out months from the FY start month', () => {
    const april = fyMonths('2022-23');
    expect(april.map((m) => m.value)).toEqual([
      '2022-04',
      '2022-05',
      '2022-06',
      '2022-07',
      '2022-08',
      '2022-09',
      '2022-10',
      '2022-11',
      '2022-12',
      '2023-01',
      '2023-02',
      '2023-03',
    ]);
    expect(fyMonths('2022-23', 1)[0]!.value).toBe('2022-01');
    expect(fyMonths('2022-23', 1)[11]!.value).toBe('2022-12');
    expect(quarterMonths('2022-23', 4).map((m) => m.value)).toEqual([
      '2023-01',
      '2023-02',
      '2023-03',
    ]);
  });

  it('labels quarters, months and periods', () => {
    expect(quarterLabel('2022-23', 3)).toBe('Q3 Oct–Dec');
    expect(quarterLabel('2022-23', 1, 1)).toBe('Q1 Jan–Mar');
    expect(monthLabel('2022-10')).toBe('Oct 2022');
    expect(periodLabel({ fy: '2022-23' })).toBe('FY 2022–23');
    expect(periodLabel({ fy: '2022-23', quarter: 3 })).toBe('FY 2022–23 · Q3');
    expect(periodLabel({ fy: '2022-23', month: '2022-10' })).toBe('FY 2022–23 · Oct 2022');
    expect(periodName({ fy: '2022-23' })).toBe('FY 2022–23');
    expect(periodName({ fy: '2022-23', quarter: 3 })).toBe('FY 2022–23, quarter 3');
    expect(periodName({ fy: '2022-23', month: '2022-10' })).toBe('FY 2022–23, October 2022');
  });

  it('compares periods', () => {
    expect(samePeriod({ fy: '2022-23', quarter: 1 }, { fy: '2022-23', quarter: 1 })).toBe(true);
    expect(samePeriod({ fy: '2022-23', quarter: 1 }, { fy: '2022-23' })).toBe(false);
    expect(samePeriod(undefined, { fy: '2022-23' })).toBe(false);
  });
});

describe('calendar dates', () => {
  it('reads the formats people type, day first', () => {
    expect(parseDateInput('31 Mar 2027')).toBe('2027-03-31');
    expect(parseDateInput(' 31 march 2027 ')).toBe('2027-03-31');
    expect(parseDateInput('5 Sept 2027')).toBeNull();
    expect(parseDateInput('31/03/2027')).toBe('2027-03-31');
    expect(parseDateInput('1-4-2027')).toBe('2027-04-01');
    expect(parseDateInput('2027-03-31')).toBe('2027-03-31');
    expect(parseDateInput('31/02/2027')).toBeNull();
    expect(parseDateInput('29 Feb 2028')).toBe('2028-02-29');
    expect(parseDateInput('29 Feb 2027')).toBeNull();
    expect(parseDateInput('soon')).toBeNull();
    expect(parseDateInput('31 Foo 2027')).toBeNull();
  });

  it('validates and counts days without a time zone', () => {
    expect(isValidIso('2027-13-01')).toBe(false);
    expect(isValidIso('2027-1-01')).toBe(false);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(addDays('2027-03-31', 1)).toBe('2027-04-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2027-01-15', -1)).toBe('2026-12-15');
    expect(addMonths('2027-03-31', 12)).toBe('2028-03-31');
  });

  it('builds Monday-first weeks', () => {
    expect(weekdayMon0('2027-03-01')).toBe(0); // a Monday
    expect(weekdayMon0('2027-03-07')).toBe(6); // a Sunday
    const weeks = monthWeeks('2027-02-10');
    expect(weeks).toHaveLength(4); // Feb 2027 starts on a Monday and has 28 days
    const april = monthWeeks('2027-04-15');
    expect(april[0]!.slice(0, 3)).toEqual([null, null, null]);
    expect(april[0]![3]).toBe('2027-04-01');
    expect(april.flat().filter(Boolean)).toHaveLength(30);
  });
});

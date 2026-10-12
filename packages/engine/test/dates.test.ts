import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  asLocalDate as d,
  clampedDate,
  compareDates,
  daysBetween,
  daysInMonth,
  fromDayNumber,
  fromParts,
  fyBounds,
  fyLabel,
  fyRangeOf,
  fyStartYear,
  isLeapYear,
  isoWeekday,
  localDateIn,
  toDayNumber,
  toParts,
} from '../src/index.js';

describe('asLocalDate', () => {
  it('accepts real calendar dates', () => {
    expect(d('2024-02-29')).toBe('2024-02-29');
  });
  it.each(['2023-02-29', '2022-04-31', '2022-4-1', '2022-04-01T00:00:00Z', ''])(
    'rejects %j',
    (v) => {
      expect(() => d(v)).toThrow(RangeError);
    },
  );
});

describe('leap years and month lengths', () => {
  it.each([
    [2024, true],
    [2023, false],
    [1900, false],
    [2000, true],
  ])('isLeapYear(%i) = %s', (year, leap) => {
    expect(isLeapYear(year)).toBe(leap);
  });
  it.each([
    [2024, 2, 29],
    [2023, 2, 28],
    [2022, 4, 30],
    [2022, 6, 30],
    [2022, 9, 30],
    [2022, 11, 30],
    [2022, 12, 31],
    [2023, 1, 31],
  ])('daysInMonth(%i, %i) = %i', (y, m, n) => {
    expect(daysInMonth(y, m)).toBe(n);
  });
});

describe('parts', () => {
  it('splits and joins', () => {
    expect(toParts(d('2023-03-31'))).toEqual({ year: 2023, month: 3, day: 31 });
    expect(fromParts(2023, 3, 31)).toBe('2023-03-31');
    expect(fromParts(999, 1, 2)).toBe('0999-01-02');
  });
  it('rejects a date that does not exist', () => {
    expect(() => fromParts(2023, 2, 29)).toThrow(RangeError);
  });
  it('clamps to the end of the month', () => {
    expect(clampedDate(2023, 2, 30)).toBe('2023-02-28');
    expect(clampedDate(2024, 2, 30)).toBe('2024-02-29');
    expect(clampedDate(2022, 4, 'LAST')).toBe('2022-04-30');
    expect(clampedDate(2022, 5, 15)).toBe('2022-05-15');
  });
});

describe('day numbers', () => {
  it.each([
    ['1970-01-01', 0],
    ['1969-12-31', -1],
    ['2000-03-01', 11017],
    ['2022-04-01', 19083],
    ['2024-02-29', 19782],
    ['0001-01-01', -719162],
  ])('%s is day %i and back', (date, n) => {
    expect(toDayNumber(d(date))).toBe(n);
    expect(fromDayNumber(n)).toBe(date);
  });
  it('round-trips every day across leap years and century boundaries', () => {
    let date = d('1899-12-25');
    for (let n = toDayNumber(date); date < '2101-01-05'; n++) {
      expect(toDayNumber(date)).toBe(n);
      const next = addDays(date, 1);
      expect(fromDayNumber(n + 1)).toBe(next);
      date = next;
    }
  });
});

describe('arithmetic', () => {
  it('adds days over month, FY and leap boundaries', () => {
    expect(addDays(d('2023-03-31'), 1)).toBe('2023-04-01');
    expect(addDays(d('2024-02-28'), 1)).toBe('2024-02-29');
    expect(addDays(d('2023-02-28'), 1)).toBe('2023-03-01');
    expect(addDays(d('2022-12-31'), 15)).toBe('2023-01-15');
    expect(addDays(d('2022-04-07'), -7)).toBe('2022-03-31');
  });
  it('counts days between dates', () => {
    expect(daysBetween(d('2022-04-30'), d('2022-05-07'))).toBe(7);
    expect(daysBetween(d('2022-05-07'), d('2022-04-30'))).toBe(-7);
    expect(daysBetween(d('2024-02-01'), d('2024-03-01'))).toBe(29);
    expect(daysBetween(d('2022-04-01'), d('2023-03-31'))).toBe(364);
  });
  it('compares dates', () => {
    expect(compareDates(d('2022-04-01'), d('2022-04-01'))).toBe(0);
    expect(compareDates(d('2022-03-31'), d('2022-04-01'))).toBe(-1);
    expect(compareDates(d('2023-01-01'), d('2022-12-31'))).toBe(1);
  });
  it('gives ISO weekdays', () => {
    expect(isoWeekday(d('1970-01-01'))).toBe(4);
    expect(isoWeekday(d('2022-04-03'))).toBe(7); // Sunday
    expect(isoWeekday(d('2022-04-04'))).toBe(1); // Monday
    expect(isoWeekday(d('1969-12-28'))).toBe(7);
  });
  it('adds months across years', () => {
    expect(addMonths(2022, 12, 1)).toEqual({ year: 2023, month: 1 });
    expect(addMonths(2023, 1, -1)).toEqual({ year: 2022, month: 12 });
    expect(addMonths(2022, 4, 11)).toEqual({ year: 2023, month: 3 });
    expect(addMonths(2022, 4, 0)).toEqual({ year: 2022, month: 4 });
  });
});

describe('financial year', () => {
  it('places 31 Mar and 1 Apr in different Indian FYs', () => {
    expect(fyStartYear(d('2023-03-31'), 4)).toBe(2022);
    expect(fyStartYear(d('2023-04-01'), 4)).toBe(2023);
    expect(fyLabel(d('2023-03-31'), 4)).toBe('2022-23');
    expect(fyLabel(d('2023-04-01'), 4)).toBe('2023-24');
    expect(fyLabel(d('1999-06-01'), 4)).toBe('1999-00');
  });
  it('honours a calendar-year FY', () => {
    expect(fyStartYear(d('2023-01-01'), 1)).toBe(2023);
    expect(fyBounds(2023, 1)).toEqual({ from: '2023-01-01', to: '2023-12-31' });
  });
  it('gives FY bounds, including a leap February end', () => {
    expect(fyBounds(2022, 4)).toEqual({ from: '2022-04-01', to: '2023-03-31' });
    expect(fyBounds(2023, 3)).toEqual({ from: '2023-03-01', to: '2024-02-29' });
    expect(fyRangeOf('2022-23', 4)).toEqual({ from: '2022-04-01', to: '2023-03-31' });
  });
  it.each(['2022-24', '2022', 'FY22'])('rejects label %j', (label) => {
    expect(() => fyRangeOf(label, 4)).toThrow(RangeError);
  });
  it.each([0, 13, 4.5])('rejects fyStartMonth %d', (m) => {
    expect(() => fyStartYear(d('2022-04-01'), m)).toThrow(RangeError);
    expect(() => fyBounds(2022, m)).toThrow(RangeError);
  });
});

describe('localDateIn', () => {
  it('turns an instant into the client calendar date at the Asia/Kolkata FY boundary', () => {
    // Asia/Kolkata is UTC+05:30: 18:30Z is midnight local time.
    expect(localDateIn('2023-03-31T18:29:59Z', 'Asia/Kolkata')).toBe('2023-03-31');
    expect(localDateIn('2023-03-31T18:30:00Z', 'Asia/Kolkata')).toBe('2023-04-01');
    expect(localDateIn('2023-03-31T18:30:00.000Z', 'UTC')).toBe('2023-03-31');
  });
  it('handles zones behind UTC and leap days', () => {
    expect(localDateIn('2024-03-01T04:00:00Z', 'America/New_York')).toBe('2024-02-29');
    expect(localDateIn('2024-02-29T23:59:59Z', 'Asia/Kolkata')).toBe('2024-03-01');
  });
  it('rejects instants that are not UTC and unknown time zones', () => {
    expect(() => localDateIn('2023-03-31T23:00:00+05:30', 'Asia/Kolkata')).toThrow(RangeError);
    expect(() => localDateIn('2023-03-31', 'Asia/Kolkata')).toThrow(RangeError);
    expect(() => localDateIn('2023-03-31T18:30:00Z', 'Mars/Olympus')).toThrow(RangeError);
  });
});

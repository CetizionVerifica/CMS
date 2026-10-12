import { describe, expect, it } from 'vitest';

import { periodApiQuery, periodFromParams, periodQuery, withPeriod } from './period';

const p = (q: string) => periodFromParams(new URLSearchParams(q));

describe('period URL state', () => {
  it('reads FY, quarter and month', () => {
    expect(p('fy=2022-23')).toEqual({ fy: '2022-23' });
    expect(p('fy=2022-23&q=Q3')).toEqual({ fy: '2022-23', quarter: 3 });
    expect(p('fy=2022-23&m=2023-01')).toEqual({ fy: '2022-23', month: '2023-01' });
  });

  it('ignores malformed values', () => {
    expect(p('')).toBeUndefined();
    expect(p('fy=2022-24')).toBeUndefined();
    expect(p('fy=22-23')).toBeUndefined();
    expect(p('fy=2022-23&q=Q5')).toEqual({ fy: '2022-23' });
    expect(p('fy=2022-23&m=2025-01')).toEqual({ fy: '2022-23' });
    expect(p('fy=2022-23&m=2023-13')).toEqual({ fy: '2022-23' });
  });

  it('writes the period and keeps other parameters', () => {
    expect(withPeriod('status=OVERDUE&q=Q1', { fy: '2023-24' }).toString()).toBe(
      'status=OVERDUE&fy=2023-24',
    );
    expect(withPeriod('m=2022-05', { fy: '2022-23', quarter: 2 }).toString()).toBe(
      'fy=2022-23&q=Q2',
    );
    expect(withPeriod('', { fy: '2022-23', month: '2022-10' }).toString()).toBe(
      'fy=2022-23&m=2022-10',
    );
  });

  it('builds a query to carry the period on links', () => {
    expect(periodQuery(undefined)).toBe('');
    expect(periodQuery({ fy: '2022-23', quarter: 4 })).toBe('?fy=2022-23&q=Q4');
  });
});

describe('periodApiQuery', () => {
  it('sends a whole FY by its label', () => {
    expect(periodApiQuery({ fy: '2022-23' }, 4)).toEqual({ fy: '2022-23' });
  });

  it('turns a quarter into its first and last day, from the client’s FY start', () => {
    expect(periodApiQuery({ fy: '2022-23', quarter: 1 }, 4)).toEqual({
      from: '2022-04-01',
      to: '2022-06-30',
    });
    expect(periodApiQuery({ fy: '2022-23', quarter: 3 }, 4)).toEqual({
      from: '2022-10-01',
      to: '2022-12-31',
    });
    // Q4 of an April FY runs into the next calendar year.
    expect(periodApiQuery({ fy: '2022-23', quarter: 4 }, 4)).toEqual({
      from: '2023-01-01',
      to: '2023-03-31',
    });
    // A January FY start: Q1 is January to March of the label's first year.
    expect(periodApiQuery({ fy: '2023-24', quarter: 1 }, 1)).toEqual({
      from: '2023-01-01',
      to: '2023-03-31',
    });
    // An October FY start: Q2 crosses the year end.
    expect(periodApiQuery({ fy: '2022-23', quarter: 2 }, 10)).toEqual({
      from: '2023-01-01',
      to: '2023-03-31',
    });
  });

  it('turns a month into its first and last day, leap years included', () => {
    expect(periodApiQuery({ fy: '2022-23', month: '2022-10' }, 4)).toEqual({
      from: '2022-10-01',
      to: '2022-10-31',
    });
    expect(periodApiQuery({ fy: '2023-24', month: '2024-02' }, 4)).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
    expect(periodApiQuery({ fy: '2022-23', month: '2023-02' }, 4)).toEqual({
      from: '2023-02-01',
      to: '2023-02-28',
    });
  });

  it('rejects an FY start that is not a month', () => {
    expect(() => periodApiQuery({ fy: '2022-23' }, 0)).toThrow(RangeError);
    expect(() => periodApiQuery({ fy: '2022-23' }, 13)).toThrow(RangeError);
    expect(() => periodApiQuery({ fy: '2022-23' }, 4.5)).toThrow(RangeError);
  });
});

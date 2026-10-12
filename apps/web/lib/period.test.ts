import { describe, expect, it } from 'vitest';

import { periodFromParams, periodQuery, withPeriod } from './period';

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

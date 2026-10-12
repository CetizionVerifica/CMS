import { describe, expect, it } from 'vitest';

import { periodQuery } from './period-query';

describe('periodQuery', () => {
  it('sends nothing when the URL has no period, so the API uses the current one', () => {
    expect(periodQuery(undefined, 4)).toEqual({});
  });

  it('sends a whole FY as fy', () => {
    expect(periodQuery({ fy: '2022-23' }, 4)).toEqual({ fy: '2022-23' });
  });

  it('turns an April-start quarter into its dates', () => {
    expect(periodQuery({ fy: '2022-23', quarter: 1 }, 4)).toEqual({
      from: '2022-04-01',
      to: '2022-06-30',
    });
    expect(periodQuery({ fy: '2022-23', quarter: 3 }, 4)).toEqual({
      from: '2022-10-01',
      to: '2022-12-31',
    });
    expect(periodQuery({ fy: '2022-23', quarter: 4 }, 4)).toEqual({
      from: '2023-01-01',
      to: '2023-03-31',
    });
  });

  it('handles a January start and a quarter that crosses the year', () => {
    expect(periodQuery({ fy: '2023-24', quarter: 4 }, 1)).toEqual({
      from: '2023-10-01',
      to: '2023-12-31',
    });
    expect(periodQuery({ fy: '2022-23', quarter: 2 }, 11)).toEqual({
      from: '2023-02-01',
      to: '2023-04-30',
    });
  });

  it('turns a month into its first and last day, leap years included', () => {
    expect(periodQuery({ fy: '2023-24', month: '2024-02' }, 4)).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
    expect(periodQuery({ fy: '2022-23', month: '2023-02' }, 4)).toEqual({
      from: '2023-02-01',
      to: '2023-02-28',
    });
    expect(periodQuery({ fy: '2022-23', month: '2022-12' }, 4)).toEqual({
      from: '2022-12-01',
      to: '2022-12-31',
    });
  });
});

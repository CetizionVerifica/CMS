import { describe, expect, it } from 'vitest';

import {
  addMonths,
  fyOf,
  isMonth,
  monthLabel,
  monthRange,
  monthToShow,
  monthWeeks,
  periodMonths,
  todayIn,
} from './month';

describe('month arithmetic', () => {
  it('moves across years and finds month ends, leap Februaries included', () => {
    expect(addMonths('2024-11', 1)).toBe('2024-12');
    expect(addMonths('2024-12', 1)).toBe('2025-01');
    expect(addMonths('2024-01', -1)).toBe('2023-12');
    expect(addMonths('2024-03', -14)).toBe('2023-01');
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('2023-02')).toEqual({ from: '2023-02-01', to: '2023-02-28' });
    expect(monthRange('2024-11')).toEqual({ from: '2024-11-01', to: '2024-11-30' });
    expect(() => addMonths('2024-13', 1)).toThrow(RangeError);
    expect(isMonth('2024-11')).toBe(true);
    expect(isMonth('2024-1')).toBe(false);
    expect(isMonth(null)).toBe(false);
  });

  it('names the FY a month falls in, for April and January starts', () => {
    expect(fyOf('2024-04', 4)).toBe('2024-25');
    expect(fyOf('2025-03', 4)).toBe('2024-25');
    expect(fyOf('1999-12', 4)).toBe('1999-00');
    expect(fyOf('2025-01', 1)).toBe('2025-26');
    expect(fyOf('2025-12', 1)).toBe('2025-26');
  });

  it('lists a period’s months: a month, a quarter, a whole FY', () => {
    expect(periodMonths({ fy: '2024-25', month: '2024-11' }, 4)).toEqual(['2024-11']);
    expect(periodMonths({ fy: '2024-25', quarter: 3 }, 4)).toEqual([
      '2024-10',
      '2024-11',
      '2024-12',
    ]);
    expect(periodMonths({ fy: '2024-25', quarter: 4 }, 4)).toEqual([
      '2025-01',
      '2025-02',
      '2025-03',
    ]);
    const fy = periodMonths({ fy: '2024-25' }, 4);
    expect(fy).toHaveLength(12);
    expect([fy[0], fy[11]]).toEqual(['2024-04', '2025-03']);
    expect(periodMonths({ fy: '2025-26', quarter: 1 }, 1)).toEqual([
      '2025-01',
      '2025-02',
      '2025-03',
    ]);
  });

  it('opens on this month when the period has it, else the period’s first month', () => {
    expect(monthToShow({ fy: '2024-25', quarter: 3 }, 4, '2024-11-15')).toBe('2024-11');
    expect(monthToShow({ fy: '2023-24' }, 4, '2024-11-15')).toBe('2023-04');
    expect(monthToShow({ fy: '2024-25', month: '2024-06' }, 4, '2024-11-15')).toBe('2024-06');
  });

  it('lays a month out in full Monday-first weeks', () => {
    // November 2024 starts on a Friday and ends on a Saturday.
    const weeks = monthWeeks('2024-11');
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toEqual([
      '2024-10-28',
      '2024-10-29',
      '2024-10-30',
      '2024-10-31',
      '2024-11-01',
      '2024-11-02',
      '2024-11-03',
    ]);
    expect(weeks[4]![6]).toBe('2024-12-01');
    // September 2024 starts on a Sunday: six weeks.
    expect(monthWeeks('2024-09')).toHaveLength(6);
    expect(monthWeeks('2024-09')[0]![6]).toBe('2024-09-01');
    // February 2021 starts on a Monday and fills exactly four weeks.
    expect(monthWeeks('2021-02')).toHaveLength(4);
  });

  it('formats the month and today in the client’s time zone', () => {
    expect(monthLabel('2024-11')).toBe('November 2024');
    // 20:00 UTC on 14 Nov is already 15 Nov in India, still 14 Nov in London.
    const at = new Date('2024-11-14T20:00:00Z');
    expect(todayIn('Asia/Kolkata', at)).toBe('2024-11-15');
    expect(todayIn('Europe/London', at)).toBe('2024-11-14');
  });
});

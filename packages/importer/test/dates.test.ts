import { describe, expect, it } from 'vitest';
import { fromExcelSerial, readDate } from '../src/dates.js';

describe('readDate', () => {
  it.each([
    ['2022-04-07', '2022-04-07'],
    ['2022-04-07T00:00:00.000Z', '2022-04-07'],
    ['07/04/2022', '2022-04-07'],
    ['7-4-2022', '2022-04-07'],
    ['07.04.2022', '2022-04-07'],
    ['7 Apr 2022', '2022-04-07'],
    ['07-Apr-2022', '2022-04-07'],
    ['30 September 2022', '2022-09-30'],
    ['30 Sept 2022', '2022-09-30'],
    ['44658', '2022-04-07'],
  ])('reads %s', (text, expected) => {
    expect(readDate(text)).toEqual({ kind: 'date', value: expected });
  });

  it('reads Excel serial numbers', () => {
    expect(readDate(44658)).toEqual({ kind: 'date', value: '2022-04-07' });
    expect(readDate(44658.75)).toEqual({ kind: 'date', value: '2022-04-07' });
    expect(readDate(-1)).toEqual({ kind: 'invalid' });
  });

  it('refuses dates outside 1950 to 2100, such as a year typed as a number', () => {
    expect(readDate(2022)).toEqual({ kind: 'invalid' });
    expect(readDate('2022')).toEqual({ kind: 'invalid' });
    expect(readDate('1949-12-31')).toEqual({ kind: 'invalid' });
    expect(readDate('2101-01-01')).toEqual({ kind: 'invalid' });
    expect(readDate('1950-01-01')).toEqual({ kind: 'date', value: '1950-01-01' });
    expect(readDate('31/12/2100')).toEqual({ kind: 'date', value: '2100-12-31' });
  });

  it('treats blanks as blank and refuses impossible or unknown dates', () => {
    expect(readDate(null)).toEqual({ kind: 'blank' });
    expect(readDate('  ')).toEqual({ kind: 'blank' });
    for (const bad of ['2022-02-30', '31/04/2022', '7 Apricot 2022', 'soon', '2022/04/07']) {
      expect(readDate(bad)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('fromExcelSerial', () => {
  it('starts after the phantom 1900 leap day and ends at 9999-12-31', () => {
    expect(fromExcelSerial(61)).toBe('1900-03-01');
    expect(fromExcelSerial(60)).toBe(null);
    expect(fromExcelSerial(2_958_465)).toBe('9999-12-31');
    expect(fromExcelSerial(2_958_466)).toBe(null);
    expect(fromExcelSerial(Number.NaN)).toBe(null);
  });
});

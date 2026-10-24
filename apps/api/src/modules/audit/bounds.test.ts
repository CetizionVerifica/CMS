import { LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../auth/index.js';
import { exclusiveTo, requireCursor, scopedUnits, startOfDayIn, uploadWindow } from './bounds.js';

const d = (s: string) => LocalDate.parse(s);

describe('startOfDayIn', () => {
  it('finds local midnight as a UTC instant', () => {
    expect(startOfDayIn(d('2023-01-20'), 'Asia/Kolkata')).toBe('2023-01-19T18:30:00.000Z');
    expect(startOfDayIn(d('2023-01-20'), 'UTC')).toBe('2023-01-20T00:00:00.000Z');
    expect(startOfDayIn(d('2023-01-20'), 'Pacific/Kiritimati')).toBe('2023-01-19T10:00:00.000Z');
    expect(startOfDayIn(d('2023-01-20'), 'Etc/GMT+12')).toBe('2023-01-20T12:00:00.000Z');
  });

  it('follows daylight saving and offsets that are not whole hours', () => {
    expect(startOfDayIn(d('2023-07-01'), 'Europe/London')).toBe('2023-06-30T23:00:00.000Z');
    expect(startOfDayIn(d('2023-01-01'), 'Europe/London')).toBe('2023-01-01T00:00:00.000Z');
    // Sao Paulo once moved its clocks forward at midnight: 4 Nov 2018 began at 01:00 local.
    expect(startOfDayIn(d('2018-11-04'), 'America/Sao_Paulo')).toBe('2018-11-04T03:00:00.000Z');
    expect(startOfDayIn(d('2023-01-20'), 'Asia/Kathmandu')).toBe('2023-01-19T18:15:00.000Z');
  });
});

describe('uploadWindow', () => {
  it('turns inclusive client dates into half-open instants', () => {
    expect(
      uploadWindow({ uploadedFrom: d('2023-01-20'), uploadedTo: d('2023-01-31') }, 'Asia/Kolkata'),
    ).toEqual({
      uploadedFrom: '2023-01-19T18:30:00.000Z',
      uploadedTo: '2023-01-31T18:30:00.000Z',
    });
  });

  it('leaves out bounds that were not asked for', () => {
    expect(uploadWindow({}, 'Asia/Kolkata')).toEqual({});
    expect(uploadWindow({ uploadedTo: d('2023-12-31') }, 'UTC')).toEqual({
      uploadedTo: '2024-01-01T00:00:00.000Z',
    });
  });
});

describe('uploadWindow at the ends of the calendar', () => {
  it('leaves out a bound at the first or last date, which excludes nothing', () => {
    expect(
      uploadWindow({ uploadedFrom: d('0001-01-01'), uploadedTo: d('9999-12-31') }, 'Asia/Kolkata'),
    ).toEqual({});
    expect(uploadWindow({ uploadedFrom: d('0001-01-02') }, 'UTC')).toEqual({
      uploadedFrom: '0001-01-02T00:00:00.000Z',
    });
    expect(
      uploadWindow({ uploadedFrom: d('9999-12-31'), uploadedTo: d('9999-12-30') }, 'UTC'),
    ).toEqual({ uploadedFrom: '9999-12-31T00:00:00.000Z', uploadedTo: '9999-12-31T00:00:00.000Z' });
  });
});

describe('exclusiveTo', () => {
  it('is the millisecond after the inclusive bound', () => {
    expect(exclusiveTo('2023-01-20T06:00:00Z')).toBe('2023-01-20T06:00:00.001Z');
    expect(exclusiveTo('2023-01-20T23:59:59.999Z')).toBe('2023-01-21T00:00:00.000Z');
  });
});

describe('scopedUnits', () => {
  it('keeps the asked units when every unit is in scope', () => {
    expect(scopedUnits(undefined, null)).toBeUndefined();
    expect(scopedUnits(['a'], null)).toEqual(['a']);
  });

  it('limits the asked units to the scope', () => {
    expect(scopedUnits(undefined, ['a', 'b'])).toEqual(['a', 'b']);
    expect(scopedUnits(['b', 'c'], ['a', 'b'])).toEqual(['b']);
    expect(scopedUnits(['c'], ['a'])).toEqual([]);
    expect(scopedUnits(undefined, [])).toEqual([]);
  });
});

describe('requireCursor', () => {
  it('passes a cursor these lists hand out', () => {
    const cursor = Buffer.from('0190f000-0000-7000-8000-000000000001').toString('base64url');
    expect(requireCursor(cursor)).toBe(cursor);
    expect(requireCursor(undefined)).toBeNull();
  });

  it('refuses anything else as a 400 on cursor', () => {
    try {
      requireCursor('not-a-cursor');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('VALIDATION');
      expect((error as ApiError).details).toEqual({
        issues: [{ path: ['cursor'], message: 'Invalid cursor' }],
      });
    }
  });
});

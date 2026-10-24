import { describe, expect, it } from 'vitest';

import {
  atLimit,
  formatBytes,
  formatInstant,
  formatRupees,
  monthName,
  paiseFrom,
  shiftDate,
  todayInIndia,
  usageOf,
} from './format';

describe('formatting', () => {
  it('shows instants in India time', () => {
    expect(formatInstant('2026-10-24T09:35:00.000Z')).toBe('24 Oct 2026, 15:05 IST');
    expect(formatInstant('not a time')).toBe('not a time');
  });

  it('shows rupees from paise with Indian grouping', () => {
    expect(formatRupees(12_345_600)).toBe('₹1,23,456');
    expect(formatRupees(150)).toBe('₹1.50');
  });

  it('reads typed rupees as paise', () => {
    expect(paiseFrom('1,20,000.50')).toBe(12_000_050);
    expect(paiseFrom('₹ 999')).toBe(99_900);
    expect(paiseFrom('12.345')).toBeNull();
    expect(paiseFrom('ten')).toBeNull();
  });

  it('shows usage against a limit, unlimited and bytes', () => {
    expect(usageOf(3, 5)).toBe('3 of 5');
    expect(usageOf(3, null)).toBe('3 of unlimited');
    expect(usageOf(2048, 1024 * 1024, true)).toBe('2 KB of 1 MB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(atLimit(5, 5)).toBe(true);
    expect(atLimit(4, 5)).toBe(false);
    expect(atLimit(99, null)).toBe(false);
  });

  it('names months and moves dates', () => {
    expect(monthName(4)).toBe('April');
    expect(monthName(13)).toBe('13');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('takes today from India, not UTC', () => {
    expect(todayInIndia(new Date('2026-10-23T19:00:00Z'))).toBe('2026-10-24');
    expect(todayInIndia(new Date('2026-10-23T18:00:00Z'))).toBe('2026-10-23');
  });
});

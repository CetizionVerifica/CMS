import { afterEach, describe, expect, it, vi } from 'vitest';

import { devWarn, formatDate, formatNumber, formatPercent, monthLong, monthShort } from './format';

describe('format', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('formats calendar dates without a time zone', () => {
    expect(formatDate('2027-03-31')).toBe('31 Mar 2027');
    expect(formatDate('2023-04-01')).toBe('1 Apr 2023');
    expect(formatDate('not a date')).toBe('not a date');
  });
  it('uses Indian grouping by default', () => {
    expect(formatNumber(100000)).toBe('1,00,000');
    expect(formatNumber(100000, 'en-GB')).toBe('100,000');
    expect(formatNumber(424)).toBe('424');
  });
  it('rounds percentages, keeping one decimal under 1%', () => {
    expect(formatPercent(82.4)).toBe('82%');
    expect(formatPercent(0.44)).toBe('0.4%');
    expect(formatPercent(0)).toBe('0%');
  });
  it('names months', () => {
    expect(monthShort(10)).toBe('Oct');
    expect(monthLong(3)).toBe('March');
  });
  it('warns outside production only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    devWarn('x');
    expect(warn).toHaveBeenCalledWith('[@canopy/ui] x');
    warn.mockClear();
    vi.stubGlobal('process', { env: { NODE_ENV: 'production' } });
    devWarn('y');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

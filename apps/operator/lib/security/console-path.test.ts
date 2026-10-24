import { describe, expect, it } from 'vitest';

import { consolePath } from './console-path';

describe('consolePath', () => {
  it('keeps a console path with its query and fragment', () => {
    expect(consolePath('/accounts/abc')).toBe('/accounts/abc');
    expect(consolePath('/accounts?status=TRIAL#top')).toBe('/accounts?status=TRIAL#top');
    expect(consolePath('/')).toBe('/');
  });

  it('refuses anything a browser would take to another site', () => {
    for (const raw of [
      '/\\evil.test',
      '/\\/evil.test',
      decodeURIComponent('/%5Cevil.test'),
      decodeURIComponent('%2F%5Cevil.test%2Flogin'),
      '//evil.test',
      '///evil.test',
      'https://evil.test',
      'javascript:alert(1)',
      'evil.test',
      '/\t/evil.test',
      '/\n/evil.test',
      '/\u0000/evil.test',
    ]) {
      expect(consolePath(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('keeps an encoded backslash as a literal path on the console', () => {
    expect(consolePath('/%5Cevil.test')).toBe('/%5Cevil.test');
  });

  it('refuses the sign-in page and empty input', () => {
    expect(consolePath('/login')).toBeNull();
    expect(consolePath('/login?next=%2Faccounts')).toBeNull();
    expect(consolePath('/login/')).toBeNull();
    expect(consolePath('')).toBeNull();
    expect(consolePath(null)).toBeNull();
    expect(consolePath(undefined)).toBeNull();
  });

  it('normalises dot segments without leaving the console', () => {
    expect(consolePath('/accounts/../plans')).toBe('/plans');
    expect(consolePath('/../../login')).toBeNull();
  });
});

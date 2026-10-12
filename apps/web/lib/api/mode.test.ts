import { describe, expect, it } from 'vitest';

import { apiMode } from './mode';

describe('apiMode', () => {
  it('uses the real API whenever CANOPY_API_URL is set', () => {
    expect(apiMode({ CANOPY_API_URL: 'https://api.example', NODE_ENV: 'production' })).toBe('real');
    expect(apiMode({ CANOPY_API_URL: 'https://api.example', CANOPY_DEMO_API: '1' })).toBe('real');
  });

  it('uses the mock outside production', () => {
    expect(apiMode({ NODE_ENV: 'development' })).toBe('mock');
    expect(apiMode({})).toBe('mock');
  });

  it('refuses the mock in production unless CANOPY_DEMO_API=1 opts in', () => {
    expect(apiMode({ NODE_ENV: 'production', CANOPY_DEMO_API: '1' })).toBe('mock');
    for (const flag of [undefined, '', '0', 'true']) {
      expect(() => apiMode({ NODE_ENV: 'production', CANOPY_DEMO_API: flag })).toThrow(
        'CANOPY_API_URL is not set',
      );
    }
  });
});

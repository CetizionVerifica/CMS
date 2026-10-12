import { describe, expect, it } from 'vitest';

import { apiMode } from './mode';

describe('apiMode', () => {
  it('uses the real API whenever it is configured', () => {
    expect(
      apiMode({ CANOPY_API_URL: 'https://api.example', NODE_ENV: 'production' }, 'app.example'),
    ).toBe('real');
  });

  it('uses the mock in development and tests', () => {
    expect(apiMode({ NODE_ENV: 'development' }, 'anything')).toBe('mock');
    expect(apiMode({}, null)).toBe('mock');
  });

  it('uses the mock in a production build only on a local host', () => {
    expect(apiMode({ NODE_ENV: 'production' }, 'localhost:3000')).toBe('mock');
    expect(apiMode({ NODE_ENV: 'production' }, '127.0.0.1')).toBe('mock');
    expect(apiMode({ NODE_ENV: 'production' }, '[::1]:3000')).toBe('mock');
    expect(() => apiMode({ NODE_ENV: 'production' }, 'compliance.planetpulse.life')).toThrow(
      'CANOPY_API_URL is not set',
    );
    expect(() => apiMode({ NODE_ENV: 'production' }, null)).toThrow();
  });
});

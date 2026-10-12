import { describe, expect, it } from 'vitest';

import { documentTitle, PRODUCT_NAME } from './brand';

describe('brand', () => {
  it('uses the client-facing product name', () => {
    expect(PRODUCT_NAME).toBe('PlanetPulse Compliance');
    expect(PRODUCT_NAME.toLowerCase()).not.toContain('canopy');
  });

  it('joins title parts and drops empty ones', () => {
    expect(documentTitle('Register', 'Demo Metals')).toBe(
      'Register · Demo Metals · PlanetPulse Compliance',
    );
    expect(documentTitle(undefined, ' ', null)).toBe('PlanetPulse Compliance');
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AuthBrand } from './AuthBrand';
import { DemoAccounts } from './DemoAccounts';

describe('auth page blocks', () => {
  it('shows the client-facing brand', () => {
    render(<AuthBrand />);
    expect(screen.getByText('PlanetPulse Compliance')).toBeTruthy();
  });

  it('lists the demo accounts for the mock API', () => {
    render(<DemoAccounts />);
    expect(screen.getByText(/consultant@demo\.test \(consultant\)/)).toBeTruthy();
    expect(screen.getByText(/twofirms@demo\.test \(consultant, in two firms\)/)).toBeTruthy();
    expect(
      screen.getByText(/newconsultant@demo\.test \(consultant, sets up MFA at first sign-in\)/),
    ).toBeTruthy();
    expect(screen.getByText(/admin@demo\.test \(account admin\)/)).toBeTruthy();
    expect(screen.getByText('demo-password')).toBeTruthy();
  });
});

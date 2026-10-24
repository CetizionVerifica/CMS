import type { Metadata } from 'next';

import { SupportStartForm } from '../../../../lib/auth/forms';

export const metadata: Metadata = { title: 'PlanetPulse support', referrer: 'no-referrer' };

// Opened from the PlanetPulse operator console with a one-time token in the fragment (ADR M15-0003 decision 7).
export default function SupportStartPage() {
  return (
    <>
      <h1 className="mb-1 text-page text-ink">PlanetPulse support</h1>
      <p className="mb-4 text-body text-muted">
        Opening this account with the access its admins granted. Everything you do here is recorded
        in the account’s audit trail.
      </p>
      <SupportStartForm />
    </>
  );
}

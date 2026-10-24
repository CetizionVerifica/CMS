import type { LocalDate } from '@canopy/contracts';
import type { Renewal } from '@canopy/db';
import { describe, expect, it } from 'vitest';
import { OPERATOR_DIGEST_DAYS, renderOperatorDigest } from './operator-digest.js';

const TODAY = '2026-11-16' as LocalDate;

const renewal = (overrides: Partial<Renewal> = {}): Renewal => ({
  accountId: '01920000-0000-7000-8000-0000000000d1',
  name: 'Kestrel Fibres',
  status: 'TRIAL',
  planCode: 'STARTER',
  endsOn: '2026-11-20',
  kind: 'TRIAL',
  ...overrides,
});

describe('the operator digest email', () => {
  it('lists each account with what ends and when, in the order given', () => {
    const email = renderOperatorDigest('Asha Operator', TODAY, [
      renewal(),
      renewal({
        name: 'Stonebridge Advisory',
        kind: 'SUBSCRIPTION',
        status: 'ACTIVE',
        endsOn: '2026-11-27',
      }),
    ]);
    expect(email.subject).toBe('Renewals due, 16 Nov 2026: 2 accounts');
    expect(email.text).toBe(
      [
        'Hello Asha Operator,',
        `2 accounts need renewing in the next ${OPERATOR_DIGEST_DAYS} days, as of 16 Nov 2026.`,
        'Kestrel Fibres: trial ends on 20 Nov 2026 (plan STARTER)\nStonebridge Advisory: subscription ends on 27 Nov 2026 (plan STARTER)',
        'Open Renewals in the operator console to convert, extend or record a payment.',
        'You get this email because you are a PlanetPulse operator.',
      ].join('\n\n') + '\n',
    );
    expect(email.html.startsWith('<!doctype html><html lang="en">')).toBe(true);
    expect(email.html).toContain('<td');
    expect(email.html).toContain('Subscription ends');
  });

  it('says "account" and "needs" for one', () => {
    const email = renderOperatorDigest('Asha Operator', TODAY, [renewal()]);
    expect(email.subject).toBe('Renewals due, 16 Nov 2026: 1 account');
    expect(email.text).toContain('1 account needs renewing');
  });

  it('escapes account names, and carries no internal name', () => {
    const email = renderOperatorDigest('Asha <b>', TODAY, [
      renewal({ name: '<script>x</script> & Co' }),
    ]);
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<b>');
    expect(email.html).toContain('&lt;script&gt;x&lt;/script&gt; &amp; Co');
    expect(`${email.subject}${email.html}${email.text}`.toLowerCase()).not.toContain('canopy');
  });
});

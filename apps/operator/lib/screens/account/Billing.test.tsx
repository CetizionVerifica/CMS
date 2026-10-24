import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { navigation } from '../../test/navigation';

vi.mock('next/navigation', () => navigation);

const { Billing } = await import('./Billing');
const { account, apiError, fakeApi, list, PLANS, renderSignedIn } =
  await import('../../test/fake-api');

const SUB = {
  id: '01900000-0000-7000-8000-0000000000e1',
  accountId: account().id,
  planCode: 'BUSINESS',
  startsOn: '2026-11-01',
  endsOn: '2027-10-31',
  amountPaise: 12_000_000,
  invoiceNumber: 'PP-2026-014',
  paidOn: null,
  recordedAt: '2026-10-24T05:00:00.000Z',
  recordedById: '01900000-0000-7000-8000-0000000000a1',
};

const SNAPSHOT = {
  accountId: account().id,
  takenOn: '2026-10-23',
  usage: { companies: 1, units: 4, users: 37, storageBytes: 0 },
  activeUsers30d: 21,
  instances: 412,
};

describe('billing and usage', () => {
  it('lists subscriptions and nightly usage for the last 30 days', async () => {
    const api = fakeApi({
      'GET /accounts/{id}/subscriptions': list([SUB]),
      'GET /accounts/{id}/usage': list([SNAPSHOT]),
    });
    await renderSignedIn(<Billing account={account()} plans={PLANS} />, api.fetch);
    const subs = await screen.findByRole('table', { name: 'Subscriptions' });
    expect(within(subs).getAllByRole('row')[1]!.textContent).toContain('₹1,20,000');
    expect(within(subs).getAllByRole('row')[1]!.textContent).toContain('Not yet');
    const usage = await screen.findByRole('table', { name: 'Nightly usage' });
    expect(within(usage).getAllByRole('row')[1]!.textContent).toContain('412');
    const query = api.sent.find((s) => s.path.endsWith('/usage'))!.query;
    expect(Date.parse(query.get('to')!) - Date.parse(query.get('from')!)).toBe(30 * 86_400_000);
  });

  it('records a subscription with an idempotency key, checking the amount first', async () => {
    const api = fakeApi({
      'GET /accounts/{id}/subscriptions': list([]),
      'GET /accounts/{id}/usage': list([]),
      'POST /accounts/{id}/subscriptions': { status: 201, body: SUB },
    });
    await renderSignedIn(<Billing account={account()} plans={PLANS} />, api.fetch);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Record subscription' }));
    const drawer = await screen.findByRole('dialog', { name: 'Record subscription' });
    const amount = within(drawer).getByRole('textbox', { name: 'Amount (₹)' });
    await user.type(amount, 'a lot');
    await user.click(within(drawer).getByRole('button', { name: 'Record subscription' }));
    expect(await within(drawer).findByText(/An amount in rupees/)).toBeTruthy();
    await user.clear(amount);
    await user.type(amount, '1,20,000');
    await user.type(
      within(drawer).getByRole('textbox', { name: 'Invoice number (optional)' }),
      'PP-2026-014',
    );
    await user.click(within(drawer).getByRole('button', { name: 'Record subscription' }));
    await vi.waitFor(() => expect(api.sent.filter((s) => s.method === 'POST')).toHaveLength(1));
    const sent = api.sent.find((s) => s.method === 'POST')!;
    expect(sent.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.body).toMatchObject({
      planCode: 'BUSINESS',
      amountPaise: 12_000_000,
      invoiceNumber: 'PP-2026-014',
      paidOn: null,
    });
    const { startsOn, endsOn } = sent.body as { startsOn: string; endsOn: string };
    expect(Date.parse(endsOn) - Date.parse(startsOn)).toBe(364 * 86_400_000);
    await vi.waitFor(() =>
      expect(api.sent.filter((s) => s.path.endsWith('/subscriptions'))).toHaveLength(3),
    );
  });

  it('shows when billing or usage did not load', async () => {
    const api = fakeApi({
      'GET /accounts/{id}/subscriptions': apiError(500, 'INTERNAL', 'Billing is down.'),
      'GET /accounts/{id}/usage': apiError(500, 'INTERNAL', 'Usage is down.'),
    });
    await renderSignedIn(<Billing account={account()} plans={PLANS} />, api.fetch);
    expect(await screen.findByText('Billing is down.')).toBeTruthy();
    expect(await screen.findByText('Usage is down.')).toBeTruthy();
  });
});

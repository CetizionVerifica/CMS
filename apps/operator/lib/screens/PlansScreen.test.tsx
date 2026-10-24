import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { navigation } from '../test/navigation';

vi.mock('next/navigation', () => navigation);

const { planBody, PlansScreen } = await import('./PlansScreen');
const { apiError, fakeApi, list, PLANS, renderSignedIn } = await import('../test/fake-api');

describe('plans', () => {
  it('lists plans with limits, marks retired ones and edits one', async () => {
    const api = fakeApi({ 'GET /plans': list(PLANS), 'PUT /plans/{code}': { body: PLANS[0] } });
    await renderSignedIn(<PlansScreen />, api.fetch);
    const table = await screen.findByRole('table', { name: 'Plans' });
    const legacy = within(table).getByRole('row', { name: /Legacy/ });
    expect(within(legacy).getByText('Retired')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(table).getByRole('button', { name: 'Edit Starter' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit Starter' });
    expect(
      (within(drawer).getByRole('textbox', { name: 'Code' }) as HTMLInputElement).disabled,
    ).toBe(true);
    const users = within(drawer).getByRole('textbox', { name: 'Users' });
    await user.clear(users);
    await user.type(users, '12');
    await user.click(within(drawer).getByRole('checkbox', { name: /Retired/ }));
    await user.click(within(drawer).getByRole('button', { name: 'Save plan' }));
    await vi.waitFor(() => expect(api.sent.filter((s) => s.method === 'PUT')).toHaveLength(1));
    const put = api.sent.find((s) => s.method === 'PUT')!;
    expect(put.path).toBe('/plans/STARTER');
    expect(put.body).toEqual({
      name: 'Starter',
      limits: { companies: 1, units: 3, users: 12, storageBytes: null },
      features: [],
      retired: true,
    });
  });

  it('creates a plan and refuses a bad code or a blank limit', async () => {
    const api = fakeApi({ 'GET /plans': list([]), 'PUT /plans/{code}': { body: PLANS[0] } });
    await renderSignedIn(<PlansScreen />, api.fetch);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New plan' }));
    const drawer = await screen.findByRole('dialog', { name: 'New plan' });
    await user.type(within(drawer).getByRole('textbox', { name: 'Code' }), 'growth plan');
    await user.click(within(drawer).getByRole('button', { name: 'Save plan' }));
    expect(await within(drawer).findByText(/Capital letters/)).toBeTruthy();
    expect(api.sent.filter((s) => s.method === 'PUT')).toHaveLength(0);
  });

  it('builds the body and reports a failed list', async () => {
    const limits = { companies: '2', units: '10', users: 'unlimited', storageBytes: 'unlimited' };
    expect(
      planBody({
        code: 'growth',
        name: ' Growth ',
        limits,
        features: 'importer, sso',
        retired: false,
      }),
    ).toEqual({
      code: 'GROWTH',
      body: {
        name: 'Growth',
        limits: { companies: 2, units: 10, users: null, storageBytes: null },
        features: ['importer', 'sso'],
        retired: false,
      },
    });
    expect(
      planBody({
        code: 'GROWTH',
        name: 'Growth',
        limits: { ...limits, units: '' },
        features: '',
        retired: false,
      }),
    ).toEqual({
      field: 'units',
      error: 'A whole number, or "unlimited"',
    });
    await renderSignedIn(
      <PlansScreen />,
      fakeApi({ 'GET /plans': apiError(500, 'INTERNAL', 'Plans are down.') }).fetch,
    );
    expect(await screen.findByText('Plans are down.')).toBeTruthy();
  });
});

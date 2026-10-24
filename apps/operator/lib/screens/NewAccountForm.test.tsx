import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { navigation } from '../test/navigation';

vi.mock('next/navigation', () => navigation);

const { createBody, NewAccountForm } = await import('./NewAccountForm');
const { account, apiError, fakeApi, list, PLANS, renderSignedIn } =
  await import('../test/fake-api');
const { choose } = await import('../test/select');

async function fillOwner(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Display name'), 'Kestrel Metals Group');
  await user.type(screen.getByLabelText("Owner's name"), 'Asha Rao');
  await user.type(screen.getByLabelText("Owner's email"), 'asha@kestrel.example');
}

describe('a new account', () => {
  it('offers only plans that are not retired, provisions once per form and opens the account', async () => {
    const api = fakeApi({
      'GET /plans': list(PLANS),
      'POST /accounts': { status: 201, body: account() },
    });
    const navigate = vi.fn();
    await renderSignedIn(<NewAccountForm navigate={navigate} />, api.fetch);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'New account', level: 1 });
    await user.click(screen.getByRole('combobox', { name: 'Plan' }));
    expect(screen.queryByRole('option', { name: /Legacy/ })).toBeNull();
    await user.keyboard('{Escape}');
    await choose(user, 'Plan', 'Business (BUSINESS)');
    await fillOwner(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(`/accounts/${account().id}`));
    const sent = api.sent.find((s) => s.method === 'POST')!;
    expect(sent.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.body).toMatchObject({
      name: 'Kestrel Metals Group',
      legalName: 'Kestrel Metals Group',
      kind: 'ENTERPRISE',
      planCode: 'BUSINESS',
      activeNow: false,
      owner: { displayName: 'Asha Rao', email: 'asha@kestrel.example' },
    });
  });

  it('keeps the same key on a retry and shows the API field errors', async () => {
    let calls = 0;
    const api = fakeApi({
      'GET /plans': list(PLANS),
      'POST /accounts': () => {
        calls += 1;
        return calls === 1
          ? apiError(400, 'VALIDATION', 'Check the form.', {
              issues: [{ path: ['body', 'owner', 'email'], message: 'Enter a valid email' }],
            })
          : { status: 201, body: account() };
      },
    });
    const navigate = vi.fn();
    await renderSignedIn(<NewAccountForm navigate={navigate} />, api.fetch);
    const user = userEvent.setup();
    await screen.findByLabelText('Display name');
    await fillOwner(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Enter a valid email')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    const keys = api.sent
      .filter((s) => s.method === 'POST')
      .map((s) => s.headers.get('idempotency-key'));
    expect(keys[0]).toBe(keys[1]);
  });

  it('cancels back to the list and reports plans that did not load', async () => {
    const navigate = vi.fn();
    const ok = fakeApi({ 'GET /plans': list(PLANS) });
    const { unmount } = await renderSignedIn(<NewAccountForm navigate={navigate} />, ok.fetch);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(navigate).toHaveBeenCalledWith('/accounts');
    unmount();
    await renderSignedIn(
      <NewAccountForm navigate={navigate} />,
      fakeApi({ 'GET /plans': apiError(500, 'INTERNAL', 'Plans are down.') }).fetch,
    );
    expect(await screen.findByText('Plans are down.')).toBeTruthy();
  });

  it('builds the body: defaults, a consultancy, a dated trial and a paid start', () => {
    const base = {
      name: ' Osprey Textiles Group ',
      kind: 'CONSULTANCY' as const,
      planCode: 'STARTER',
      legalName: '',
      gstin: '27aapfu0939f1zv',
      timeZone: '',
      fyStartMonth: '1',
      term: 'trialUntil' as const,
      trialEndsOn: '2026-12-31',
      clientName: 'ignored for a consultancy',
      ownerName: 'Ravi Nair',
      ownerEmail: 'ravi@osprey.example',
    };
    expect(createBody(base)).toEqual({
      name: 'Osprey Textiles Group',
      kind: 'CONSULTANCY',
      planCode: 'STARTER',
      legalName: 'Osprey Textiles Group',
      gstin: '27AAPFU0939F1ZV',
      timeZone: 'Asia/Kolkata',
      fyStartMonth: 1,
      activeNow: false,
      trialEndsOn: '2026-12-31',
      owner: { displayName: 'Ravi Nair', email: 'ravi@osprey.example' },
    });
    const paid = createBody({
      ...base,
      kind: 'ENTERPRISE',
      term: 'activeNow',
      gstin: '',
      clientName: 'Riverbend',
    });
    expect(paid).toMatchObject({ activeNow: true, gstin: null, clientName: 'Riverbend' });
    expect(paid).not.toHaveProperty('trialEndsOn');
  });
});

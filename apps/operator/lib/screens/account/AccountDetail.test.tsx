import type { Account } from '@canopy/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { navigation } from '../../test/navigation';

vi.mock('next/navigation', () => navigation);

const { AccountDetail } = await import('./AccountDetail');
const { account, apiError, fakeApi, list, PLANS, renderSignedIn } =
  await import('../../test/fake-api');
const { choose } = await import('../../test/select');

afterEach(() => vi.unstubAllGlobals());

const GRANT = {
  id: '01900000-0000-7000-8000-0000000000d1',
  accountId: account().id,
  level: 'READ_ONLY',
  status: 'ACTIVE',
  startsAt: '2026-10-24T03:00:00.000Z',
  endsAt: '2026-10-31T03:00:00.000Z',
  revokedAt: null,
};

/** An API holding one account; each change returns it at the next version with `change` applied. */
function accountApi(start: Partial<Account> = {}, extra: Parameters<typeof fakeApi>[0] = {}) {
  let current = account(start);
  const bump = (change: Partial<Account>) => {
    current = { ...current, ...change, version: current.version + 1 };
    return { body: current };
  };
  const api = fakeApi({
    'GET /accounts/{id}': () => ({ body: current }),
    'GET /plans': list(PLANS),
    'GET /accounts/{id}/subscriptions': list([]),
    'GET /accounts/{id}/usage': list([]),
    'GET /accounts/{id}/support-grants': list([GRANT]),
    'POST /accounts/{id}/status': (s) => bump({ status: (s.body as { to: Account['status'] }).to }),
    'POST /accounts/{id}/trial': (s) =>
      bump({ trialEndsOn: (s.body as { trialEndsOn: Account['trialEndsOn'] }).trialEndsOn }),
    'POST /accounts/{id}/plan': (s) =>
      bump({ planCode: (s.body as { planCode: string }).planCode }),
    'PUT /accounts/{id}/override': () => bump({}),
    'PATCH /accounts/{id}': (s) =>
      bump({ name: (s.body as { name?: string }).name ?? current.name }),
    'POST /accounts/{id}/onboarded': () => bump({ onboardedAt: '2026-10-24T05:00:00.000Z' }),
    'POST /accounts/{id}/owner-invite': { status: 202 },
    'POST /accounts/{id}/deletion': () =>
      bump({
        status: 'PENDING_DELETION',
        deletionRequestedAt: '2026-10-24T05:00:00.000Z',
        purgeAfter: '2026-11-23T05:00:00.000Z',
      }),
    'POST /accounts/{id}/deletion/cancel': () =>
      bump({ status: 'ACTIVE', deletionRequestedAt: null, purgeAfter: null }),
    'POST /support-grants/{id}/sessions': {
      status: 201,
      body: {
        url: 'https://app.planetpulse.example/support/start#token=abc',
        expiresAt: '2026-10-24T05:01:00.000Z',
      },
    },
    ...extra,
  });
  return { ...api, current: () => current };
}

const show = (api: ReturnType<typeof accountApi>) =>
  renderSignedIn(<AccountDetail id={account().id} />, api.fetch);
const sentTo = (api: ReturnType<typeof accountApi>, method: string, path: string) =>
  api.sent.filter((s) => s.method === method && s.path.endsWith(path));

describe('the account page', () => {
  it('shows the account, its limits against usage, billing, usage and support access', async () => {
    const api = accountApi();
    await show(api);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Kestrel Metals Group' }),
    ).toBeTruthy();
    expect(screen.getByText('Company · BUSINESS plan · version 3')).toBeTruthy();
    expect(screen.getByText(/^Copied 24 Oct 2026/)).toBeTruthy();
    const limits = screen.getByRole('table', { name: 'Limits and usage' });
    const users = within(limits).getByRole('row', { name: /Users/ });
    expect(users.textContent).toContain('150 of 150');
    expect(within(users).getByText('At limit')).toBeTruthy();
    expect(await screen.findByText('No subscription recorded')).toBeTruthy();
    expect(await screen.findByText(/No nightly counts yet/)).toBeTruthy();
    expect(await screen.findByRole('table', { name: 'Support grants' })).toBeTruthy();
    const actions = screen.getByRole('group', { name: 'Account actions' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Convert to paid', 'Change trial end', 'Mark onboarded', 'Suspend account']);
  });

  it('converts, suspends and resumes with a typed reason, at the version it read', async () => {
    const api = accountApi();
    await show(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Convert to paid' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Reason' }),
      'Paid by bank transfer',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Convert to paid' }));
    await vi.waitFor(() =>
      expect(screen.getByText('Company · BUSINESS plan · version 4')).toBeTruthy(),
    );
    expect(sentTo(api, 'POST', '/status')[0]!.body).toEqual({
      version: 3,
      to: 'ACTIVE',
      reason: 'Paid by bank transfer',
    });

    await user.click(screen.getByRole('button', { name: 'Suspend account' }));
    const suspend = await screen.findByRole('alertdialog');
    await user.type(within(suspend).getByRole('textbox', { name: 'Reason' }), 'Unpaid invoice');
    await user.click(within(suspend).getByRole('button', { name: 'Suspend account' }));
    await user.click(await screen.findByRole('button', { name: 'Resume account' }));
    const resume = await screen.findByRole('alertdialog');
    await user.type(within(resume).getByRole('textbox', { name: 'Reason' }), 'Invoice paid');
    await user.click(within(resume).getByRole('button', { name: 'Resume account' }));
    await vi.waitFor(() => expect(sentTo(api, 'POST', '/status')).toHaveLength(3));
    expect(
      sentTo(api, 'POST', '/status').map((s) => (s.body as { version: number }).version),
    ).toEqual([3, 4, 5]);
  });

  it('moves the trial end and marks the account onboarded', async () => {
    const api = accountApi();
    await show(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change trial end' }));
    const drawer = await screen.findByRole('dialog', { name: 'Change the trial end' });
    const date = within(drawer).getByRole('textbox', { name: 'Trial ends on' });
    await user.clear(date);
    await user.type(date, '31 Dec 2030');
    await user.tab();
    await user.type(
      within(drawer).getByRole('textbox', { name: 'Reason (optional)' }),
      'Pilot runs longer',
    );
    await user.click(within(drawer).getByRole('button', { name: 'Save trial end' }));
    await vi.waitFor(() => expect(sentTo(api, 'POST', '/trial')).toHaveLength(1));
    expect(sentTo(api, 'POST', '/trial')[0]!.body).toEqual({
      version: 3,
      trialEndsOn: '2030-12-31',
      reason: 'Pilot runs longer',
    });

    await user.click(await screen.findByRole('button', { name: 'Mark onboarded' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Mark onboarded',
      }),
    );
    await vi.waitFor(() =>
      expect(sentTo(api, 'POST', '/onboarded')[0]?.body).toEqual({ version: 4 }),
    );
  });

  it('resends the owner invite while the account waits for its owner', async () => {
    const api = accountApi({ status: 'PROVISIONING', libraryCopiedAt: null });
    await show(api);
    expect(await screen.findByText(/Not copied yet/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Resend owner invite' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Resend invite' }),
    );
    await vi.waitFor(() => expect(sentTo(api, 'POST', '/owner-invite')).toHaveLength(1));
  });

  it('deletes only with the exact name, then can cancel the deletion', async () => {
    const api = accountApi({ status: 'ACTIVE', trialEndsOn: null });
    await show(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete account' }));
    const drawer = await screen.findByRole('dialog', { name: 'Delete Kestrel Metals Group' });
    await user.type(
      within(drawer).getByRole('textbox', { name: /to confirm/ }),
      'kestrel metals group',
    );
    await user.type(within(drawer).getByRole('textbox', { name: 'Reason' }), 'Customer left');
    await user.click(within(drawer).getByRole('button', { name: 'Request deletion' }));
    expect((await within(drawer).findByRole('alert')).textContent).toMatch(/exactly as shown/);
    expect(sentTo(api, 'POST', '/deletion')).toHaveLength(0);
    const name = within(drawer).getByRole('textbox', { name: /to confirm/ });
    await user.clear(name);
    await user.type(name, 'Kestrel Metals Group');
    await user.click(within(drawer).getByRole('button', { name: 'Request deletion' }));
    expect(await screen.findByText('Deleted for good after')).toBeTruthy();
    expect(sentTo(api, 'POST', '/deletion')[0]!.body).toEqual({
      version: 3,
      confirmName: 'Kestrel Metals Group',
      reason: 'Customer left',
    });
    await user.click(screen.getByRole('button', { name: 'Cancel deletion' }));
    const cancel = await screen.findByRole('alertdialog');
    await user.type(within(cancel).getByRole('textbox', { name: 'Reason' }), 'Customer stays');
    await user.click(within(cancel).getByRole('button', { name: 'Cancel deletion' }));
    await vi.waitFor(() => expect(sentTo(api, 'POST', '/deletion/cancel')).toHaveLength(1));
  });

  it('edits only what changed, and says when nothing did', async () => {
    const api = accountApi();
    await show(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit details' }));
    let drawer = await screen.findByRole('dialog', { name: 'Edit details' });
    await user.click(within(drawer).getByRole('button', { name: 'Save details' }));
    expect((await within(drawer).findByRole('alert')).textContent).toBe('Nothing has changed.');
    const gstin = within(drawer).getByRole('textbox', { name: 'GSTIN' });
    await user.type(gstin, '27aapfu0939f1zv');
    const name = within(drawer).getByRole('textbox', { name: 'Display name' });
    await user.clear(name);
    await user.type(name, 'Kestrel Metals');
    await user.click(within(drawer).getByRole('button', { name: 'Save details' }));
    await vi.waitFor(() => expect(sentTo(api, 'PATCH', account().id)).toHaveLength(1));
    expect(sentTo(api, 'PATCH', account().id)[0]!.body).toEqual({
      version: 3,
      name: 'Kestrel Metals',
      profile: { gstin: '27AAPFU0939F1ZV' },
    });
    drawer = await screen.findByRole('heading', { level: 1, name: 'Kestrel Metals' });
    expect(drawer).toBeTruthy();
  });

  it('changes the plan and overrides a limit with reasons', async () => {
    const api = accountApi({
      entitlements: {
        planCode: 'BUSINESS',
        limits: { ...PLANS[1]!.limits, users: 200 },
        features: ['importer', 'sso'],
      },
    });
    await show(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Override limits' }));
    const drawer = await screen.findByRole('dialog', { name: 'Override limits' });
    expect((within(drawer).getByRole('textbox', { name: 'Users' }) as HTMLInputElement).value).toBe(
      '200',
    );
    expect(
      (within(drawer).getByRole('textbox', { name: 'Extra features' }) as HTMLInputElement).value,
    ).toBe('sso');
    const units = within(drawer).getByRole('textbox', { name: 'Units' });
    await user.type(units, 'lots');
    await user.click(within(drawer).getByRole('button', { name: 'Save override' }));
    expect(await within(drawer).findByText(/A whole number/)).toBeTruthy();
    await user.clear(units);
    await user.type(units, 'unlimited');
    await user.type(within(drawer).getByRole('textbox', { name: 'Reason' }), 'Group expansion');
    await user.click(within(drawer).getByRole('button', { name: 'Save override' }));
    await vi.waitFor(() => expect(sentTo(api, 'PUT', '/override')).toHaveLength(1));
    expect(sentTo(api, 'PUT', '/override')[0]!.body).toEqual({
      version: 3,
      override: { limits: { units: null, users: 200 }, features: ['sso'], note: null },
      reason: 'Group expansion',
    });

    await user.click(await screen.findByRole('button', { name: 'Change plan' }));
    const plan = await screen.findByRole('dialog', { name: 'Change plan' });
    await choose(user, 'New plan', 'Starter (STARTER)');
    await user.type(within(plan).getByRole('textbox', { name: 'Reason' }), 'Smaller team');
    await user.click(within(plan).getByRole('button', { name: 'Change plan' }));
    await vi.waitFor(() =>
      expect(sentTo(api, 'POST', '/plan')[0]?.body).toEqual({
        version: 4,
        planCode: 'STARTER',
        reason: 'Smaller team',
      }),
    );
  });

  it('opens a support session in a new tab and reports a refused one', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    let refuse = false;
    const api = accountApi(
      {},
      {
        'POST /support-grants/{id}/sessions': () =>
          refuse
            ? apiError(403, 'ACCESS_EXPIRED', 'This support access has ended.')
            : {
                status: 201,
                body: {
                  url: 'https://app.planetpulse.example/support/start#token=abc',
                  expiresAt: '2026-10-24T05:01:00.000Z',
                },
              },
      },
    );
    await show(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://app.planetpulse.example/support/start#token=abc',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    refuse = true;
    await user.click(screen.getByRole('button', { name: 'Open support session' }));
    expect(await screen.findByText('This support access has ended.')).toBeTruthy();
  });

  it('says when the account does not exist, and when it did not load', async () => {
    const missing = fakeApi({
      'GET /accounts/{id}': apiError(404, 'NOT_FOUND', 'No such account.'),
      'GET /plans': list(PLANS),
    });
    const { unmount } = await renderSignedIn(<AccountDetail id={account().id} />, missing.fetch);
    expect(await screen.findByText('No such account')).toBeTruthy();
    unmount();
    const down = fakeApi({
      'GET /accounts/{id}': apiError(500, 'INTERNAL', 'Database is down.'),
      'GET /plans': list(PLANS),
    });
    await renderSignedIn(<AccountDetail id={account().id} />, down.fetch);
    expect(await screen.findByText('Database is down.')).toBeTruthy();
  });

  it('asks the operator to reload when someone else changed the account', async () => {
    const api = accountApi(
      {},
      {
        'POST /accounts/{id}/status': apiError(409, 'STALE_VERSION', 'Stale.', {
          currentVersion: 4,
        }),
      },
    );
    await show(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Suspend account' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Unpaid invoice');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend account' }));
    expect(await screen.findByText(/Reload it and try again/)).toBeTruthy();
    expect(within(dialog).getByRole('alert').textContent).toMatch(/didn't work/);
  });
});

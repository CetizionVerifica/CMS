import {
  effectiveFeatures,
  KNOWN_FEATURES,
  type Account,
  type AccountOverride,
  type OperatorAuditEvent,
} from '@canopy/contracts';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { navigation } from '../../test/navigation';

vi.mock('next/navigation', () => navigation);

const { AccountDetail } = await import('./AccountDetail');
const { account, apiError, fakeApi, list, page, PLANS, renderSignedIn } =
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

/** The newest OVERRIDE_CHANGE, as the operator audit returns it, holding `override`. */
const overrideEvent = (override: AccountOverride): OperatorAuditEvent => ({
  id: '01900000-0000-7000-8000-0000000000e1',
  at: '2026-10-24T04:00:00.000Z',
  operatorId: '01900000-0000-7000-8000-0000000000a1',
  action: 'OVERRIDE_CHANGE',
  accountId: account().id,
  before: null,
  after: { override },
  reason: 'Pilot',
  requestId: 'req-1',
  ip: null,
});

/**
 * An API holding one account; each change returns it at the next version with `change` applied. An override save
 * works out the entitlements the way the API does and keeps the override as the newest OVERRIDE_CHANGE.
 */
const KNOWN_CODES: string[] = KNOWN_FEATURES.map((f) => f.code);

function accountApi(
  start: Partial<Account> = {},
  extra: Parameters<typeof fakeApi>[0] = {},
  override: AccountOverride | null = null,
  plans = PLANS,
) {
  let current = account(start);
  let stored = override;
  const bump = (change: Partial<Account>) => {
    current = { ...current, ...change, version: current.version + 1 };
    return { body: current };
  };
  const putOverride = (body: AccountOverride) => {
    // As the API stores it (ISO-5b): an add-on named in neither list keeps its stored state.
    const named = new Set([...body.features, ...(body.removedFeatures ?? [])]);
    const kept = (list: string[] | undefined) =>
      (list ?? []).filter((f) => KNOWN_CODES.includes(f) && !named.has(f));
    stored = {
      ...body,
      features: [...body.features, ...kept(stored?.features)],
      removedFeatures: [...(body.removedFeatures ?? []), ...kept(stored?.removedFeatures)],
    };
    const plan = plans.find((p) => p.code === current.planCode)!;
    return bump({
      entitlements: {
        planCode: plan.code,
        limits: { ...plan.limits, ...body.limits },
        features: effectiveFeatures(plan.features, stored),
      },
    });
  };
  const api = fakeApi({
    'GET /accounts/{id}': () => ({ body: current }),
    'GET /plans': list(plans),
    'GET /accounts/{id}/subscriptions': list([]),
    'GET /accounts/{id}/usage': list([]),
    'GET /accounts/{id}/support-grants': list([GRANT]),
    'POST /accounts/{id}/status': (s) => bump({ status: (s.body as { to: Account['status'] }).to }),
    'POST /accounts/{id}/trial': (s) =>
      bump({ trialEndsOn: (s.body as { trialEndsOn: Account['trialEndsOn'] }).trialEndsOn }),
    'POST /accounts/{id}/plan': (s) =>
      bump({ planCode: (s.body as { planCode: string }).planCode }),
    'PUT /accounts/{id}/override': (s) =>
      putOverride((s.body as { override: AccountOverride }).override),
    'GET /audit': () => page(stored ? [overrideEvent(stored)] : []),
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
  return { ...api, current: () => current, stored: () => stored };
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
      override: {
        limits: { units: null, users: 200 },
        features: ['sso'],
        removedFeatures: [],
        note: null,
      },
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

/** Business with the ISO add-on in the plan itself, so a switch can take it away from one account. */
const ISO_PLANS = PLANS.map((p) =>
  p.code === 'BUSINESS' ? { ...p, features: ['importer', 'isoManagement'] } : p,
);

describe('the add-ons card', () => {
  const card = async () => screen.findByRole('region', { name: 'Add-ons' });
  const isoSwitch = async () =>
    within(await card()).findByRole('switch', {
      name: 'ISO management systems for Kestrel Metals Group',
    });

  it('turns the ISO add-on on with a reason, keeping the overridden limits and the note', async () => {
    const api = accountApi(
      {
        entitlements: {
          planCode: 'BUSINESS',
          limits: { ...PLANS[1]!.limits, users: 200 },
          features: ['importer', 'sso'],
        },
      },
      {},
      { limits: { users: 200 }, features: ['sso'], note: 'Pilot pricing until March' },
    );
    await show(api);
    const user = userEvent.setup();
    const toggle = await isoSwitch();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(within(await card()).getByText('Not in the plan.')).toBeTruthy();
    await user.click(toggle);
    const drawer = await screen.findByRole('dialog', { name: 'Turn on ISO management systems' });
    await user.type(within(drawer).getByRole('textbox', { name: 'Reason' }), 'Bought the add-on');
    await user.click(within(drawer).getByRole('button', { name: 'Turn on' }));
    await vi.waitFor(() => expect(sentTo(api, 'PUT', '/override')).toHaveLength(1));
    expect(sentTo(api, 'PUT', '/override')[0]!.body).toEqual({
      version: 3,
      override: {
        limits: { users: 200 },
        features: ['sso', 'isoManagement'],
        removedFeatures: [],
        note: 'Pilot pricing until March',
      },
      reason: 'Bought the add-on',
    });
    expect(
      await screen.findByText(/ISO management systems is on for Kestrel Metals Group/),
    ).toBeTruthy();
    expect((await isoSwitch()).getAttribute('aria-checked')).toBe('true');
    expect(within(await card()).getByText('Added for this account.')).toBeTruthy();
  });

  it('turns off an add-on that the plan includes, for this account only', async () => {
    const api = accountApi(
      {
        entitlements: {
          planCode: 'BUSINESS',
          limits: PLANS[1]!.limits,
          features: ['importer', 'isoManagement'],
        },
      },
      {},
      null,
      ISO_PLANS,
    );
    await show(api);
    const user = userEvent.setup();
    expect(within(await card()).getByText('The plan includes it.')).toBeTruthy();
    await user.click(await isoSwitch());
    const drawer = await screen.findByRole('dialog', { name: 'Turn off ISO management systems' });
    await user.type(within(drawer).getByRole('textbox', { name: 'Reason' }), 'Did not renew it');
    await user.click(within(drawer).getByRole('button', { name: 'Turn off' }));
    await vi.waitFor(() => expect(sentTo(api, 'PUT', '/override')).toHaveLength(1));
    expect(sentTo(api, 'PUT', '/override')[0]!.body).toEqual({
      version: 3,
      override: { limits: {}, features: [], removedFeatures: ['isoManagement'], note: null },
      reason: 'Did not renew it',
    });
    expect(api.current().entitlements.features).toEqual(['importer']);
    expect((await isoSwitch()).getAttribute('aria-checked')).toBe('false');
    expect(
      within(await card()).getByText('Turned off for this account, although the plan includes it.'),
    ).toBeTruthy();
  });

  it('keeps a removed add-on removed, and the note, when the limits are saved', async () => {
    const api = accountApi(
      {
        entitlements: { planCode: 'BUSINESS', limits: PLANS[1]!.limits, features: ['importer'] },
      },
      {},
      { limits: {}, features: [], removedFeatures: ['isoManagement'], note: 'Paused add-on' },
      ISO_PLANS,
    );
    await show(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Override limits' }));
    const drawer = await screen.findByRole('dialog', { name: 'Override limits' });
    expect(
      (within(drawer).getByRole('textbox', { name: /^Note/ }) as HTMLTextAreaElement).value,
    ).toBe('Paused add-on');
    await user.type(within(drawer).getByRole('textbox', { name: 'Users' }), '400');
    await user.type(
      within(drawer).getByRole('textbox', { name: 'Extra features' }),
      'isoManagement',
    );
    await user.type(within(drawer).getByRole('textbox', { name: 'Reason' }), 'More seats');
    await user.click(within(drawer).getByRole('button', { name: 'Save override' }));
    expect(await within(drawer).findByText(/Add-ons card/)).toBeTruthy();
    expect(sentTo(api, 'PUT', '/override')).toHaveLength(0);
    await user.clear(within(drawer).getByRole('textbox', { name: 'Extra features' }));
    await user.click(within(drawer).getByRole('button', { name: 'Save override' }));
    await vi.waitFor(() => expect(sentTo(api, 'PUT', '/override')).toHaveLength(1));
    expect(sentTo(api, 'PUT', '/override')[0]!.body).toEqual({
      version: 3,
      // The drawer sends no add-on; the API keeps the stored removal (ISO-5b).
      override: {
        limits: { users: 400 },
        features: [],
        removedFeatures: [],
        note: 'Paused add-on',
      },
      reason: 'More seats',
    });
    expect(api.current().entitlements.features).toEqual(['importer']);
  });

  it('shows when the ISO catalogue was copied, and flags a set-up that has not finished', async () => {
    const iso = {
      planCode: 'BUSINESS',
      limits: PLANS[1]!.limits,
      features: ['importer', 'isoManagement'],
    };
    await show(
      accountApi(
        { entitlements: iso, isoCatalogueCopiedAt: '2026-10-24T05:00:00.000Z' },
        {},
        null,
        ISO_PLANS,
      ),
    );
    expect(await within(await card()).findByText('ISO set up')).toBeTruthy();
    cleanup();
    // In trial since long ago, and still not copied.
    await show(
      accountApi(
        {
          entitlements: iso,
          status: 'TRIAL',
          isoCatalogueCopiedAt: null,
          createdAt: '2020-01-01T00:00:00.000Z',
        },
        {},
        null,
        ISO_PLANS,
      ),
    );
    expect(await within(await card()).findByText('ISO set-up has not finished')).toBeTruthy();
  });

  it('does not open the limits drawer when the note cannot be read', async () => {
    const api = accountApi({}, { 'GET /audit': apiError(500, 'INTERNAL', 'Try again shortly.') });
    await show(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Override limits' }));
    expect(await screen.findByText(/Try again/)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Override limits' })).toBeNull();
  });
});

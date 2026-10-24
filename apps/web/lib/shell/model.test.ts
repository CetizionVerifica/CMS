import { AccountSummary, type Me } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { createApiClient } from '../api/client';
import { MOCK_CLIENTS, MOCK_PASSWORD, mockFetch } from '../api/mock';
import { accountNotice, buildShellModel, homeHref, navSections, rolesFor } from './model';

async function meFor(email: string): Promise<Me> {
  const anon = createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch });
  const cookie = (await anon.login({ email, password: MOCK_PASSWORD })).setCookies[0]!.split(
    ';',
  )[0]!;
  const verified = (
    await createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie }).verifyMfa(
      '123456',
    )
  ).setCookies[0]!.split(';')[0]!;
  return (
    await createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie: verified }).me()
  ).data;
}

const labels = (sections: ReturnType<typeof navSections>) =>
  sections.map((s) => [s.label ?? '', s.items.map((i) => i.label)]);

describe('shell model', () => {
  it('lists a consultant’s clients by name with overdue counts and period context', async () => {
    const model = buildShellModel(await meFor('consultant@demo.test'), {
      [MOCK_CLIENTS.demoMetals]: 5,
    });
    expect(model.isFirmUser).toBe(true);
    expect(model.user).toEqual({
      name: 'Consultant 01',
      detail: 'Consultant',
      email: 'consultant@demo.test',
    });
    expect(model.clients.map((c) => [c.name, c.meta, c.overdueCount])).toEqual([
      ['Demo Metals', '3 units', 5],
      ['Northwind Textiles', '1 unit', 0],
    ]);
    expect(model.clients[0]).toMatchObject({
      fyStartMonth: 4,
      timeZone: 'Asia/Kolkata',
      availableUntil: '2025-03',
    });
    expect(model.roles.firm).toEqual(['CONSULTANT']);
    expect(homeHref(model)).toBe('/portfolio');
  });

  it('sorts every client the API lists by name and maps the period context', async () => {
    const me = await meFor('admin@demo.test');
    me.clients.reverse();
    const model = buildShellModel(me);
    expect(model.clients.map((c) => c.name)).toEqual([
      'Demo Metals',
      'Northwind Textiles',
      'Sunrise Foods',
    ]);
    expect(model.clients[2]).toMatchObject({
      meta: '5 units',
      thisPeriod: { fy: '2024-25', quarter: 3 },
      availableFys: ['2024-25'],
      availableUntil: null,
    });
  });

  it('sends client users to their client’s overview', async () => {
    const model = buildShellModel(await meFor('owner@demo.test'));
    expect(model.isFirmUser).toBe(false);
    expect(model.roles).toEqual({ firm: [], byClient: { [MOCK_CLIENTS.demoMetals]: ['OWNER'] } });
    expect(homeHref(model)).toBe(`/c/${MOCK_CLIENTS.demoMetals}/overview`);
    expect(homeHref({ ...model, clients: [] })).toBe('/library/acts');
  });

  it('scopes roles to a client', async () => {
    const me = await meFor('owner@demo.test');
    expect(rolesFor(me, MOCK_CLIENTS.demoMetals)).toEqual(['OWNER']);
    expect(rolesFor(me, MOCK_CLIENTS.northwind)).toEqual([]);
    expect(rolesFor(me)).toEqual(['OWNER']);
  });

  it('builds the sidebar per role (spec 01 default nav)', () => {
    expect(labels(navSections(['CONSULTANT'], 'c1'))).toEqual([
      ['', ['Overview', 'Register', 'Calendar', 'Evidence']],
      ['Reporting', ['Reports', 'Audit trail']],
      ['Setup', ['Entities', 'People', 'Import']],
      ['Firm', ['Portfolio', 'Library']],
    ]);
    expect(labels(navSections(['OWNER'], 'c1'))).toEqual([
      ['', ['Overview', 'Register', 'Calendar', 'Evidence']],
      ['Firm', ['Library']],
    ]);
    expect(labels(navSections(['APPROVER'], 'c1'))).toEqual([
      ['', ['Overview', 'Register', 'Calendar', 'Approvals', 'Evidence']],
      ['Reporting', ['Reports']],
      ['Firm', ['Library']],
    ]);
    expect(labels(navSections(['FIRM_ADMIN']))).toEqual([
      ['Firm', ['Portfolio', 'Library', 'Account']],
    ]);
    // The account page is for account admins only.
    expect(labels(navSections(['CONSULTANT']))).toEqual([['Firm', ['Portfolio', 'Library']]]);
    expect(navSections(['OWNER'], 'c1')[0]!.items[1]).toEqual({
      path: 'register',
      label: 'Register',
      href: '/c/c1/register',
    });
  });

  it('words nothing for an active account, and puts a support visit before a closing account or a trial', async () => {
    const me = await meFor('consultant@demo.test');
    const person = (support: boolean) => ({ ...me.person, support });
    const account = (
      status: 'ACTIVE' | 'TRIAL' | 'PENDING_DELETION',
      trialEndsOn: string | null = null,
    ) => AccountSummary.parse({ kind: 'ENTERPRISE', status, trialEndsOn });
    expect(accountNotice({ person: person(false), account: account('ACTIVE') })).toBeUndefined();
    expect(accountNotice({ person: person(false) })).toBeUndefined();
    expect(
      accountNotice({ person: person(false), account: account('TRIAL', '2026-11-23') }),
    ).toEqual({
      kind: 'trial',
      endsOn: '2026-11-23',
    });
    expect(accountNotice({ person: person(false), account: account('TRIAL') })).toBeUndefined();
    expect(accountNotice({ person: person(false), account: account('PENDING_DELETION') })).toEqual({
      kind: 'closing',
    });
    expect(
      accountNotice({ person: person(true), account: account('TRIAL', '2026-11-23') }),
    ).toEqual({
      kind: 'support',
    });
  });

  it('hides the client switcher for a company account with one client only', async () => {
    const me = await meFor('consultant@demo.test');
    const one = { ...me, clients: me.clients.slice(0, 1) };
    const company = AccountSummary.parse({
      kind: 'ENTERPRISE',
      status: 'ACTIVE',
      trialEndsOn: null,
    });
    expect(buildShellModel(me).showClientSwitcher).toBe(true);
    expect(buildShellModel({ ...one }).showClientSwitcher).toBe(true);
    expect(buildShellModel({ ...one, account: company }).showClientSwitcher).toBe(false);
    expect(buildShellModel({ ...me, account: company }).showClientSwitcher).toBe(true);
  });

  it('gives a company account with one client no portfolio, and lands its firm users on that client', async () => {
    const me = await meFor('consultant@demo.test');
    const company = AccountSummary.parse({
      kind: 'ENTERPRISE',
      status: 'ACTIVE',
      trialEndsOn: null,
    });
    const single = buildShellModel({ ...me, clients: me.clients.slice(0, 1), account: company });
    expect(single.showPortfolio).toBe(false);
    expect(homeHref(single)).toBe(`/c/${MOCK_CLIENTS.demoMetals}/overview`);
    expect(labels(navSections(['CONSULTANT'], undefined, { showPortfolio: false }))).toEqual([
      ['Firm', ['Library']],
    ]);
    // Two clients, a consultancy, or no client yet: the portfolio stays.
    expect(buildShellModel({ ...me, account: company }).showPortfolio).toBe(true);
    expect(buildShellModel({ ...me, clients: me.clients.slice(0, 1) }).showPortfolio).toBe(true);
    const none = buildShellModel({ ...me, clients: [], account: company });
    expect(none.showPortfolio).toBe(true);
    expect(homeHref({ ...single, clients: [] })).toBe('/portfolio');
  });
});

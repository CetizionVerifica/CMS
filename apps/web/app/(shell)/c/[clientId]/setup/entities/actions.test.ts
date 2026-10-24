// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk, so these run each
// change through the actions and read the result back from the mock API.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../../../../../lib/api/client';
import {
  MOCK_CLIENTS,
  MOCK_MFA_CODE,
  MOCK_PASSWORD,
  mockFetch,
} from '../../../../../../lib/api/mock';
import {
  nextHeaders,
  nextNavigation,
  request,
  resetRequest,
} from '../../../../../../lib/test/next-mocks';

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => nextHeaders);
vi.mock('next/navigation', () => nextNavigation);
vi.mock('next/cache', () => ({ revalidatePath }));

const actions = await import('./actions');

const CLIENT = MOCK_CLIENTS.demoMetals;
const api = (cookie?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });

async function signIn(email: string, mfa = false) {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  const [name, value] = cookie.split('=') as [string, string];
  request.cookies.set(name, decodeURIComponent(value));
}

const session = () =>
  createApiClient({
    baseUrl: 'http://api.test',
    fetch: mockFetch,
    cookie: `pp_session=${request.cookies.get('pp_session')}`,
  });

beforeEach(() => {
  resetRequest();
  revalidatePath.mockReset();
});

const list = async () => {
  const s = session();
  const params = { clientId: CLIENT };
  const query = { limit: '200' };
  return {
    companies: (await s.call('listCompanies', { params, query })).data.items,
    units: (await s.call('listUnits', { params, query })).data.items,
    locations: (await s.call('listLocations', { query })).data.items,
  };
};

describe('entity actions', () => {
  it('refuses arguments that aren’t what the page sends', async () => {
    await signIn('consultant@demo.test', true);
    await expect(actions.createCompanyAction('nope', { name: 'X' })).rejects.toThrow();
    await expect(actions.createCompanyAction(CLIENT, { name: '' })).rejects.toThrow();
    await expect(
      actions.renameCompanyAction(CLIENT, CLIENT, { version: 1, name: '' }),
    ).rejects.toThrow();
    await expect(
      actions.archiveCompanyAction(CLIENT, CLIENT, { version: 1, reason: '' }),
    ).rejects.toThrow();
    await expect(
      actions.createUnitAction(CLIENT, { companyId: 'x', name: 'A', locationId: CLIENT }),
    ).rejects.toThrow();
    await expect(actions.updateUnitAction(CLIENT, CLIENT, { version: 1 })).rejects.toThrow();
    await expect(
      actions.archiveUnitAction(CLIENT, 'x', { version: 1, reason: 'r' }),
    ).rejects.toThrow();
  });

  it('adds, renames and archives a company', async () => {
    await signIn('consultant@demo.test', true);
    expect(await actions.createCompanyAction(CLIENT, { name: 'Northwind Dairy' })).toEqual({
      ok: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/c/${CLIENT}/setup/entities`);
    expect(await actions.createCompanyAction(CLIENT, { name: 'northwind dairy' })).toEqual({
      ok: false,
      message: 'This client already has a company with that name.',
    });
    const dairy = (await list()).companies.find((c) => c.name === 'Northwind Dairy')!;
    expect(
      await actions.renameCompanyAction(CLIENT, dairy.id, {
        version: dairy.version,
        name: 'Northwind Milk',
      }),
    ).toEqual({ ok: true });
    expect(
      await actions.renameCompanyAction(CLIENT, dairy.id, {
        version: dairy.version,
        name: 'Again',
      }),
    ).toEqual({
      ok: false,
      message:
        'Someone else changed this while you were editing. The page now shows their version.',
    });
    const milk = (await list()).companies.find((c) => c.id === dairy.id)!;
    expect(milk.name).toBe('Northwind Milk');
    expect(
      await actions.archiveCompanyAction(CLIENT, milk.id, {
        version: milk.version,
        reason: 'Sold',
      }),
    ).toEqual({ ok: true });
    expect((await list()).companies.find((c) => c.id === milk.id)).toBeUndefined();
  });

  it('adds a unit, moves it and archives it', async () => {
    await signIn('admin@demo.test', true);
    const { companies, locations } = await list();
    const company = companies[0]!;
    const [first, second] = locations as [(typeof locations)[0], (typeof locations)[0]];
    expect(
      await actions.createUnitAction(CLIENT, {
        companyId: company.id,
        name: 'Chennai Depot',
        locationId: first.id,
      }),
    ).toEqual({ ok: true });
    expect(
      await actions.createUnitAction(CLIENT, {
        companyId: company.id,
        name: 'chennai depot',
        locationId: first.id,
      }),
    ).toEqual({ ok: false, message: 'This company already has a unit with that name.' });
    const unit = (await list()).units.find((u) => u.name === 'Chennai Depot')!;
    expect(
      await actions.updateUnitAction(CLIENT, unit.id, {
        version: unit.version,
        locationId: second.id,
      }),
    ).toEqual({ ok: true });
    const moved = (await list()).units.find((u) => u.id === unit.id)!;
    expect(moved.locationId).toBe(second.id);
    expect(
      await actions.archiveUnitAction(CLIENT, unit.id, {
        version: moved.version,
        reason: 'Closed',
      }),
    ).toEqual({ ok: true });
    expect(
      await actions.archiveUnitAction(CLIENT, unit.id, {
        version: moved.version,
        reason: 'Closed',
      }),
    ).toMatchObject({ ok: false });
  });

  it('tells an approver they cannot change the setup', async () => {
    await signIn('approver@demo.test');
    expect(await actions.createCompanyAction(CLIENT, { name: 'Anything' })).toEqual({
      ok: false,
      message: "You can no longer change this client's setup.",
    });
  });
});

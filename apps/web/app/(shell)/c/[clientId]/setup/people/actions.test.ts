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

const people = async () =>
  (
    await session().call('listClientPeople', {
      params: { clientId: CLIENT },
      query: { limit: '200' },
    })
  ).data.items;

describe('people actions', () => {
  it('refuses arguments that aren’t what the page sends', async () => {
    await signIn('consultant@demo.test', true);
    await expect(
      actions.addPersonAction(CLIENT, { displayName: 'A', email: null, role: 'FIRM_ADMIN' }),
    ).rejects.toThrow();
    await expect(
      actions.addPersonAction(CLIENT, { displayName: 'A', email: 'not-an-email', role: 'OWNER' }),
    ).rejects.toThrow();
    await expect(actions.updatePersonAction(CLIENT, CLIENT, { version: 1 })).rejects.toThrow();
    await expect(
      actions.mergePeopleAction(CLIENT, CLIENT, { version: 1, sourceIds: [CLIENT] }),
    ).rejects.toThrow('themselves');
    await expect(actions.rolesAction(CLIENT, 'x')).rejects.toThrow();
  });

  it('adds people with and without an email, and refuses a taken email', async () => {
    await signIn('consultant@demo.test', true);
    expect(
      await actions.addPersonAction(CLIENT, {
        displayName: 'Meera Rao',
        email: null,
        role: 'APPROVER',
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(revalidatePath).toHaveBeenCalledWith(`/c/${CLIENT}/setup/people`);
    expect(
      await actions.addPersonAction(CLIENT, {
        displayName: 'Divya H',
        email: 'divya.hegde@northwind.example',
        role: 'OWNER',
      }),
    ).toEqual({ ok: false, message: 'Someone in your firm already has this email.' });
    const meera = (await people()).find((p) => p.displayName === 'Meera Rao')!;
    expect(meera.status).toBe('UNCLAIMED');
    expect(await actions.rolesAction(CLIENT, meera.id)).toEqual({
      ok: true,
      value: ['Approver · all units'],
    });

    // An email makes them invited.
    expect(
      await actions.updatePersonAction(CLIENT, meera.id, {
        version: meera.version,
        email: 'meera.rao@northwind.example',
      }),
    ).toEqual({ ok: true, value: undefined });
    expect((await people()).find((p) => p.id === meera.id)!.status).toBe('INVITED');
  });

  it('keeps an active person’s email, and merges a duplicate', async () => {
    await signIn('consultant@demo.test', true);
    const all = await people();
    const divya = all.find((p) => p.displayName === 'Divya Hegde')!;
    expect(
      await actions.updatePersonAction(CLIENT, divya.id, { version: divya.version, email: null }),
    ).toEqual({
      ok: false,
      message: 'This could not be saved. An active person keeps an email to sign in with.',
    });
    expect(
      await actions.addPersonAction(CLIENT, {
        displayName: 'Divya Hegde.',
        email: null,
        role: 'OWNER',
      }),
    ).toMatchObject({ ok: true });
    const duplicate = (await people()).find((p) => p.displayName === 'Divya Hegde.')!;
    expect(
      await actions.mergePeopleAction(CLIENT, divya.id, {
        version: divya.version,
        sourceIds: [duplicate.id],
      }),
    ).toEqual({ ok: true, value: undefined });
    expect((await people()).find((p) => p.id === duplicate.id)).toBeUndefined();
    expect(
      await actions.updatePersonAction(CLIENT, duplicate.id, { version: 1, displayName: 'X' }),
    ).toEqual({
      ok: false,
      message: 'This person was removed or merged in the meantime. The page now shows who is left.',
    });
  });

  it('tells an owner they cannot change people', async () => {
    await signIn('owner@demo.test');
    expect(
      await actions.addPersonAction(CLIENT, { displayName: 'X Y', email: null, role: 'OWNER' }),
    ).toEqual({ ok: false, message: "You can no longer change this client's people." });
  });
});

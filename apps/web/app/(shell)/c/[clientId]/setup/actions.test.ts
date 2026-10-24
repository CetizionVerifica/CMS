// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk, so these run each
// setup change through the actions and read the result back from the mock API.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../../../../lib/api/client';
import { MOCK_CLIENTS, MOCK_MFA_CODE, MOCK_PASSWORD, mockFetch } from '../../../../../lib/api/mock';
import {
  nextHeaders,
  nextNavigation,
  request,
  resetRequest,
} from '../../../../../lib/test/next-mocks';

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

const departments = async () =>
  (
    await session().call('listDepartments', {
      params: { clientId: CLIENT },
      query: { limit: '200' },
    })
  ).data.items;

beforeEach(() => {
  resetRequest();
  revalidatePath.mockReset();
});

describe('department actions', () => {
  it('refuses arguments that aren’t what the page sends', async () => {
    await signIn('consultant@demo.test', true);
    await expect(
      actions.createDepartmentAction('nope', { name: 'X', aliases: [] }),
    ).rejects.toThrow();
    await expect(
      actions.createDepartmentAction(CLIENT, { name: '', aliases: [] }),
    ).rejects.toThrow();
    await expect(actions.updateDepartmentAction(CLIENT, CLIENT, { version: 1 })).rejects.toThrow();
    await expect(
      actions.mergeDepartmentsAction(CLIENT, CLIENT, { version: 1, sourceIds: [] }),
    ).rejects.toThrow();
    await expect(
      actions.mergeDepartmentsAction(CLIENT, CLIENT, { version: 1, sourceIds: [CLIENT] }),
    ).rejects.toThrow('itself');
  });

  it('adds, renames, refuses a duplicate and a stale version, then merges', async () => {
    await signIn('consultant@demo.test', true);
    expect(
      await actions.createDepartmentAction(CLIENT, { name: 'Quality', aliases: ['QA'] }),
    ).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith(`/c/${CLIENT}/setup/departments`);
    expect(await actions.createDepartmentAction(CLIENT, { name: 'quality', aliases: [] })).toEqual({
      ok: false,
      message: 'This client already has a department with that name.',
    });
    expect(
      await actions.createDepartmentAction(CLIENT, { name: 'Quality control', aliases: [] }),
    ).toEqual({ ok: true });

    const quality = (await departments()).find((d) => d.name === 'Quality')!;
    expect(quality.aliases).toEqual(['QA']);
    expect(
      await actions.updateDepartmentAction(CLIENT, quality.id, {
        version: quality.version,
        name: 'Quality assurance',
        aliases: ['QA', 'Quality'],
      }),
    ).toEqual({ ok: true });
    // The old version is now stale.
    expect(
      await actions.updateDepartmentAction(CLIENT, quality.id, {
        version: quality.version,
        aliases: [],
      }),
    ).toEqual({
      ok: false,
      message:
        'Someone else changed this while you were editing. The page now shows their version.',
    });

    const after = await departments();
    const target = after.find((d) => d.name === 'Quality assurance')!;
    const source = after.find((d) => d.name === 'Quality control')!;
    expect(
      await actions.mergeDepartmentsAction(CLIENT, target.id, {
        version: target.version,
        sourceIds: [source.id],
      }),
    ).toEqual({ ok: true });
    const merged = await departments();
    expect(merged.find((d) => d.id === source.id)).toBeUndefined();
    expect(merged.find((d) => d.id === target.id)!.aliases).toContain('Quality control');
    // Merging a department that is gone says so.
    expect(
      await actions.mergeDepartmentsAction(CLIENT, source.id, {
        version: 1,
        sourceIds: [target.id],
      }),
    ).toMatchObject({ ok: false });
  });

  it('tells an owner they cannot change the setup', async () => {
    await signIn('owner@demo.test');
    expect(await actions.createDepartmentAction(CLIENT, { name: 'Legal', aliases: [] })).toEqual({
      ok: false,
      message: "You can no longer change this client's setup.",
    });
  });
});

describe('reminder actions', () => {
  const reminders = {
    ownerDaysBefore: [7, 1],
    approverDaysAfter: [2],
    sendAtLocalTime: '08:30',
    consultantDigestWeekday: 5,
  };

  it('checks the settings before asking the API', async () => {
    await signIn('consultant@demo.test', true);
    await expect(actions.saveRemindersAction(CLIENT, { version: 0, reminders })).rejects.toThrow();
    await expect(
      actions.saveRemindersAction(CLIENT, {
        version: 1,
        reminders: { ...reminders, sendAtLocalTime: '25:00' },
      }),
    ).rejects.toThrow();
  });

  it('saves the reminders and keeps the other settings', async () => {
    await signIn('consultant@demo.test', true);
    const before = (await session().call('getClientSettings', { params: { clientId: CLIENT } }))
      .data;
    expect(
      await actions.saveRemindersAction(CLIENT, { version: before.version, reminders }),
    ).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith(`/c/${CLIENT}/setup/reminders`);
    const after = (await session().call('getClientSettings', { params: { clientId: CLIENT } }))
      .data;
    expect(after.settings.reminders).toEqual(reminders);
    expect(after.settings.timeZone).toBe(before.settings.timeZone);
    expect(after.version).toBeGreaterThan(before.version);
    expect(
      await actions.saveRemindersAction(CLIENT, { version: before.version, reminders }),
    ).toMatchObject({ ok: false });
  });

  it('tells an approver they cannot change reminders', async () => {
    await signIn('approver@demo.test');
    expect(await actions.saveRemindersAction(CLIENT, { version: 1, reminders })).toEqual({
      ok: false,
      message: "You can no longer change this client's setup.",
    });
  });

  it('lets a firm admin save reminders', async () => {
    await signIn('admin@demo.test', true);
    const view = (await session().call('getClientSettings', { params: { clientId: CLIENT } })).data;
    expect(await actions.saveRemindersAction(CLIENT, { version: view.version, reminders })).toEqual(
      { ok: true },
    );
  });
});

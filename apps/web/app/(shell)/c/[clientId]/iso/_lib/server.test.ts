// @vitest-environment node
// The gate, the shared reads and the Server Actions, run as on the server against the web app's mock API (M0's mock),
// with each user the demo has: the add-on on (consultant, owner, approver) and off (company admin).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../../../lib/api/client';
import {
  nextHeaders,
  nextNavigation,
  NotFoundError,
  RedirectError,
  request,
  resetRequest,
} from '../../../../../../lib/test/next-mocks';
import { CLIENT } from '../_test/iso-data';

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => nextHeaders);
vi.mock('next/navigation', () => nextNavigation);
vi.mock('next/cache', () => ({ revalidatePath }));

const { relayCookies, serverApi, sessionApi } = await import('../../../../../../lib/api/server');
const { isoGate, isoLoad, isoMetadata } = await import('./gate');
const data = await import('./data');
const { isoRead, isoWrite } = await import('./actions');

async function signIn(email: string) {
  await relayCookies(
    (await (await serverApi()).login({ email, password: 'demo-password' })).setCookies,
  );
  if (['consultant@demo.test', 'company@demo.test'].includes(email)) {
    await relayCookies((await (await sessionApi()).verifyMfa('123456')).setCookies);
  }
}

beforeEach(() => {
  resetRequest();
  revalidatePath.mockReset();
});

describe('isoGate and isoMetadata', () => {
  it('is on for an account with the add-on, with the person’s roles in the client', async () => {
    await signIn('consultant@demo.test');
    const gate = await isoGate(CLIENT);
    expect(gate).toMatchObject({ on: true, homeHref: `/c/${CLIENT}/overview` });
    if (!gate.on) throw new Error('expected on');
    expect(gate.roles.length).toBeGreaterThan(0);
    expect(gate.personId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await isoMetadata(CLIENT, 'Checklist')).toEqual({ title: 'Checklist · Demo Metals' });
  });

  it('is off without the add-on, and the title says only that', async () => {
    await signIn('company@demo.test');
    expect(await isoGate(CLIENT)).toMatchObject({ on: false });
    expect(await isoMetadata(CLIENT, 'Checklist')).toEqual({
      title: 'Not turned on · Demo Metals',
    });
  });

  it('is not found for a client that isn’t the user’s', async () => {
    await signIn('consultant@demo.test');
    await expect(isoGate('00000000-0000-5000-8000-000000000999')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('isoLoad', () => {
  it('returns the data, or the refusal a page words', async () => {
    expect(await isoLoad(async () => 1)).toEqual({ ok: true, data: 1 });
    const refuse = (code: ConstructorParameters<typeof ApiError>[1]) => () =>
      Promise.reject(new ApiError(409, code, 'x'));
    expect(await isoLoad(refuse('FEATURE_NOT_READY'))).toEqual({ ok: false, refusal: 'notReady' });
    expect(await isoLoad(refuse('FORBIDDEN'))).toEqual({ ok: false, refusal: 'noPermission' });
  });

  it('sends a lost session to sign-in and rethrows anything else', async () => {
    request.headers.set('x-pp-path', '/c/x/iso/checklist');
    await expect(
      isoLoad(() => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'x'))),
    ).rejects.toEqual(new RedirectError('/login?next=%2Fc%2Fx%2Fiso%2Fchecklist'));
    await expect(
      isoLoad(() => Promise.reject(new ApiError(401, 'MFA_REQUIRED', 'x'))),
    ).rejects.toEqual(new RedirectError('/login/verify?next=%2Fc%2Fx%2Fiso%2Fchecklist'));
    await expect(isoLoad(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('words the API’s own refusal when the add-on is off', async () => {
    await signIn('company@demo.test');
    const api = await serverApi();
    expect(await isoLoad(() => data.systems(api, CLIENT))).toEqual({
      ok: false,
      refusal: 'notEnabled',
    });
  });
});

describe('shared reads', () => {
  it('reads every page of a list', async () => {
    const pages = [
      { items: [1, 2], nextCursor: 'c1' },
      { items: [3], nextCursor: null },
    ];
    const read = vi.fn(async () => pages.shift()!);
    expect(await data.allPages(read)).toEqual([1, 2, 3]);
    expect(read).toHaveBeenLastCalledWith({ limit: '200', cursor: 'c1' });
  });

  it('reads the catalogue, systems, clauses, units and people', async () => {
    await signIn('consultant@demo.test');
    const api = await serverApi();
    const [standards, systems, clauses, units, people] = await Promise.all([
      data.standards(api, CLIENT),
      data.systems(api, CLIENT),
      data.clauses(api, CLIENT),
      data.units(api, CLIENT),
      data.people(api, CLIENT),
    ]);
    expect(standards.map((s) => s.title)).toEqual(['ISO 9001', 'ISO 14001', 'ISO 45001']);
    expect(systems).toHaveLength(1);
    expect(clauses.length).toBeGreaterThan(100);
    expect(units.length).toBeGreaterThan(0);
    expect(people.map((p) => p.name)).toEqual(
      [...people.map((p) => p.name)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('names no one when the people list is refused', async () => {
    const api = { call: vi.fn(async () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'x'))) };
    expect(await data.people(api as never, CLIENT)).toEqual([]);
  });
});

describe('isoWrite and isoRead', () => {
  it('runs a step, refreshes the ISO pages, and words a refusal', async () => {
    await signIn('consultant@demo.test');
    const system = (await data.systems(await serverApi(), CLIENT))[0]!;
    const rows = (
      await (
        await serverApi()
      ).call('listIsoChecklist', { params: { clientId: CLIENT, id: system.id } })
    ).data.items;
    const row = rows.find((r) => r.clauseNumber === '7.1.5.2' && r.naState === 'NONE')!;
    expect(row.allowedActions).toContain('REQUEST_NA');

    const done = await isoWrite(
      CLIENT,
      'requestIsoClauseNa',
      { id: system.id, rowId: row.id },
      {
        version: row.version,
        reason: 'No equipment needs traceable measurement.',
      },
    );
    expect(done).toMatchObject({ ok: true, data: { naState: 'REQUESTED' } });
    expect(revalidatePath).toHaveBeenCalledWith(`/c/${CLIENT}/iso`, 'layout');

    const stale = await isoWrite(
      CLIENT,
      'requestIsoClauseNa',
      { id: system.id, rowId: row.id },
      {
        version: row.version,
        reason: 'Again.',
      },
    );
    expect(stale).toMatchObject({ ok: false });
    if (stale.ok) throw new Error('expected a refusal');
    expect(stale.message).not.toBe('');
  });

  it('refuses a route that isn’t an ISO write, ids that aren’t ids and a body its schema refuses', async () => {
    await signIn('consultant@demo.test');
    await expect(isoWrite(CLIENT, 'listIsoSystems' as never, {}, {} as never)).rejects.toThrow(
      'Not an ISO write route',
    );
    await expect(
      isoWrite(CLIENT, 'updateIsoChecklistRow', { id: 'nope', rowId: 'nope' }, { version: 1 }),
    ).rejects.toThrow();
    await expect(isoWrite('not-a-client', 'createIsoDocument', {}, {} as never)).rejects.toThrow();
    await expect(isoRead(CLIENT, 'getIsoOverview' as never, {})).rejects.toThrow(
      'Not an ISO read a screen may make',
    );
  });

  it('reads a record’s files and an audit’s findings', async () => {
    await signIn('consultant@demo.test');
    const audits = (
      await (
        await serverApi()
      ).call('listIsoExternalAudits', { params: { clientId: CLIENT }, query: { limit: '50' } })
    ).data.items;
    const held = audits.find((a) => a.state === 'HELD')!;
    const findings = await isoRead(CLIENT, 'listIsoExternalFindings', { id: held.id });
    expect(findings).toMatchObject({ ok: true });
    const files = await isoRead(
      CLIENT,
      'listIsoFiles',
      {},
      {
        subjectType: 'external_audit',
        subjectId: held.id,
      },
    );
    if (!files.ok) throw new Error('expected files');
    expect(files.data.items.length).toBeGreaterThan(0);
    const link = await isoRead(CLIENT, 'isoFileDownloadUrl', { id: files.data.items[0]!.id });
    expect(link.ok).toBe(true);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('says the add-on is off when it is', async () => {
    await signIn('company@demo.test');
    const result = await isoRead(
      CLIENT,
      'listIsoFiles',
      {},
      {
        subjectType: 'external_audit',
        subjectId: CLIENT,
      },
    );
    expect(result).toEqual({
      ok: false,
      code: 'FEATURE_NOT_ENABLED',
      message: 'ISO management systems is not turned on for your account.',
    });
  });
});

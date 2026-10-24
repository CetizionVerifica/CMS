// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk. The mock answers
// every upload as the sample register, so these run the whole wizard through the actions.
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
const SHA = 'a'.repeat(64);
const FILE = { fileName: 'register.xlsx', sizeBytes: 56_974 };
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

const ok = <T>(result: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

async function uploaded(): Promise<string> {
  const { batchId, upload } = ok(await actions.startImportAction(CLIENT, FILE));
  // The demo API stores no bytes, so the browser is told not to send them.
  expect(upload).toBeNull();
  ok(await actions.confirmUploadAction(CLIENT, batchId, SHA));
  return batchId;
}

beforeEach(() => {
  resetRequest();
  revalidatePath.mockReset();
});

describe('import actions', () => {
  it('refuses arguments that aren’t what the page sends', async () => {
    await signIn('consultant@demo.test', true);
    await expect(actions.startImportAction('nope', FILE)).rejects.toThrow();
    await expect(actions.confirmUploadAction(CLIENT, CLIENT, 'ABC')).rejects.toThrow();
    await expect(
      actions.mapAndParseAction(
        CLIENT,
        CLIENT,
        'Sheet',
        [{ sourceHeader: 'A', field: 'nope' }],
        '',
      ),
    ).rejects.toThrow();
    await expect(actions.mapAndParseAction(CLIENT, CLIENT, '', [], '')).rejects.toThrow();
    await expect(
      actions.decideAction(CLIENT, CLIENT, 'k', { decision: 'EDITED' }),
    ).rejects.toThrow();
    await expect(
      actions.decideAction(CLIENT, CLIENT, 'k', { decision: 'PENDING' }),
    ).rejects.toThrow();
    await expect(actions.acceptAllAction(CLIENT, CLIENT, [])).rejects.toThrow();
    await expect(actions.dryRunAction(CLIENT, 'x')).rejects.toThrow();
    await expect(actions.commitAction('x', CLIENT)).rejects.toThrow();
    await expect(actions.cancelAction(CLIENT, 'x')).rejects.toThrow();
  });

  it('says which workbooks it takes before asking the API', async () => {
    await signIn('consultant@demo.test', true);
    expect(
      await actions.startImportAction(CLIENT, { fileName: 'register.pdf', sizeBytes: 10 }),
    ).toEqual({
      ok: false,
      message: 'Choose an .xlsx workbook of 20 MB or less.',
    });
    expect(
      await actions.startImportAction(CLIENT, {
        fileName: 'big.xlsx',
        sizeBytes: 21 * 1024 * 1024,
      }),
    ).toMatchObject({ ok: false });
  });

  it('runs the sample register from upload to commit', async () => {
    await signIn('consultant@demo.test', true);
    const batchId = await uploaded();

    // The upload saved the suggested mapping, so the step can be resumed from the batch.
    const mapped = (await session().call('getImport', { params: { id: batchId } })).data;
    expect(mapped.status).toBe('MAPPED');
    expect(mapped.sheetName).toBe('ASPxGridView1');
    expect(mapped.mapping).toHaveLength(19);
    expect(mapped.mapping!.find((m) => m.sourceHeader === 'Due Date')?.field).toBe('dueDate');

    ok(
      await actions.mapAndParseAction(
        CLIENT,
        batchId,
        'ASPxGridView1',
        mapped.mapping,
        'Register export',
      ),
    );
    const parsed = (await session().call('getImport', { params: { id: batchId } })).data;
    expect(parsed.status).toBe('PARSED');
    expect(parsed.mappingTemplateId).not.toBeNull();

    // Committing before the dry run is refused in words.
    expect(await actions.commitAction(CLIENT, batchId)).toEqual({
      ok: false,
      message: 'This import moved on in another tab. The page now shows where it is.',
    });

    const groups = (await session().call('listImportIssues', { params: { id: batchId } })).data
      .items;
    const proposed = groups
      .filter((g) => g.severity === 'WARNING' && g.proposal !== null)
      .map((g) => g.groupKey);
    ok(await actions.acceptAllAction(CLIENT, batchId, proposed));
    ok(
      await actions.decideAction(CLIENT, batchId, 'ALIAS_ACT:factories', {
        decision: 'EDITED',
        editedValue: 'Factories Act, 1948',
      }),
    );
    const decided = (await session().call('listImportIssues', { params: { id: batchId } })).data
      .items;
    expect(decided.find((g) => g.groupKey === 'ALIAS_ACT:factories')).toMatchObject({
      decision: 'EDITED',
      editedValue: 'Factories Act, 1948',
    });
    expect((await session().call('getImport', { params: { id: batchId } })).data.status).toBe(
      'REVIEWED',
    );

    ok(await actions.dryRunAction(CLIENT, batchId));
    revalidatePath.mockReset();
    ok(await actions.commitAction(CLIENT, batchId));
    expect((await session().call('getImport', { params: { id: batchId } })).data.status).toBe(
      'COMMITTED',
    );
    // The register and dashboards count the new rows.
    expect(revalidatePath).toHaveBeenCalledWith(`/c/${CLIENT}/import`);
    expect(revalidatePath).toHaveBeenCalledWith(`/c/${CLIENT}`, 'layout');
  });

  it('cancels an import, and then refuses to go on with it', async () => {
    await signIn('admin@demo.test', true);
    const batchId = await uploaded();
    ok(await actions.cancelAction(CLIENT, batchId));
    expect((await session().call('getImport', { params: { id: batchId } })).data.status).toBe(
      'CANCELLED',
    );
    expect(await actions.dryRunAction(CLIENT, batchId)).toMatchObject({ ok: false });
  });

  it('tells a person without import access in words', async () => {
    await signIn('owner@demo.test');
    expect(await actions.startImportAction(CLIENT, FILE)).toEqual({
      ok: false,
      message: 'You can no longer import for this client.',
    });
  });
});

// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk.
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

/** Signs a demo account in for the actions' requests, as the browser's cookie would. */
async function signIn(email: string, mfa = false) {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  const [name, value] = cookie.split('=') as [string, string];
  request.cookies.set(name, decodeURIComponent(value));
}

beforeEach(() => {
  resetRequest();
  revalidatePath.mockReset();
});

describe('register actions', () => {
  it('refuses arguments that aren’t what the page sends', async () => {
    await signIn('approver@demo.test');
    await expect(actions.loadMoreRows('not-an-id', '', 'c1')).rejects.toThrow();
    await expect(actions.loadMoreRows(CLIENT, 'status=NOPE', 'c1')).rejects.toThrow();
    await expect(actions.loadMoreRows(CLIENT, '', '')).rejects.toThrow();
    await expect(actions.bulkApproveRows(CLIENT, [])).rejects.toThrow();
    await expect(actions.bulkApproveRows(CLIENT, [{ id: CLIENT, version: 0 }])).rejects.toThrow();
    await expect(actions.waitingRows(CLIENT, 'dueFrom=x')).rejects.toThrow();
    await expect(actions.waitingRows('not-an-id', '')).rejects.toThrow();
    await expect(actions.startRegisterExport(CLIENT, 'limit=5')).rejects.toThrow();
    await expect(actions.registerExportState('../x')).rejects.toThrow();
  });

  it('loads the next page as the signed-in person', async () => {
    await signIn('consultant@demo.test', true);
    const first = await createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch,
      cookie: `pp_session=${request.cookies.get('pp_session')}`,
    }).call('listInstances', { params: { clientId: CLIENT }, query: { limit: '2' } });
    const cursor = first.data.nextCursor!;
    expect(cursor).toBeTruthy();
    const page = await actions.loadMoreRows(CLIENT, 'sort=dueDate', cursor);
    expect(page.rows.length).toBeGreaterThan(0);
  });

  it('lists the waiting rows with their versions, and approves exactly those', async () => {
    await signIn('approver@demo.test');
    const waiting = await actions.waitingRows(CLIENT, 'sort=dueDate');
    expect(waiting.length).toBeGreaterThan(0);
    for (const item of waiting) expect(item.version).toBeGreaterThanOrEqual(1);

    // A row whose version moved on since it was listed is skipped, not approved.
    const [first, ...rest] = waiting;
    const stale = await actions.bulkApproveRows(CLIENT, [
      { ...first!, version: first!.version + 1 },
    ]);
    expect(stale.message).toBe(
      'Approved 0 instances. Not approved: 1 changed since you opened the register.',
    );
    expect(revalidatePath).not.toHaveBeenCalled();

    const result = await actions.bulkApproveRows(CLIENT, [first!, ...rest]);
    expect(result).toEqual({
      tone: 'success',
      message: `Approved ${waiting.length} ${waiting.length === 1 ? 'instance' : 'instances'}.`,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/c/${CLIENT}`, 'layout');
    // Nothing is left waiting.
    expect(await actions.waitingRows(CLIENT, 'sort=dueDate')).toEqual([]);
  });

  it('reports selected rows it could not approve', async () => {
    await signIn('approver@demo.test');
    const result = await actions.bulkApproveRows(CLIENT, [
      { id: '00000000-0000-5000-8000-0000000fffff', version: 1 },
    ]);
    expect(result).toEqual({
      tone: 'warn',
      message: 'Approved 0 instances. Not approved: 1 isn’t yours to approve.',
    });
  });

  it('exports the view and hands back its download link', async () => {
    await signIn('consultant@demo.test', true);
    const id = await actions.startRegisterExport(CLIENT, 'status=OVERDUE&sort=dueDate');
    expect(await actions.registerExportState(id)).toMatchObject({ status: 'ready' });
  });
});

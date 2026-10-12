import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  nextHeaders,
  nextNavigation,
  RedirectError,
  request,
  resetRequest,
} from '../test/next-mocks';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => nextHeaders);
vi.mock('next/navigation', () => nextNavigation);

const { loadShell, requestPath, shellLayoutHint } = await import('./server');
const { relayCookies, serverApi, sessionApi } = await import('../api/server');
const { MOCK_APPROVALS_WAITING } = await import('../api/mock');

async function signIn(email: string, mfa: boolean) {
  await relayCookies(
    (await (await serverApi()).login({ email, password: 'demo-password' })).setCookies,
  );
  if (mfa) await relayCookies((await (await sessionApi()).verifyMfa('123456')).setCookies);
}

describe('shell server data', () => {
  beforeEach(() => {
    resetRequest();
    vi.unstubAllEnvs();
  });

  it('reads the requested path from the proxy header', async () => {
    expect(await requestPath()).toBe('/');
    request.headers.set('x-pp-path', '/c/x/register?fy=2022-23');
    expect(await requestPath()).toBe('/c/x/register?fy=2022-23');
  });

  it('redirects to login, coming back to the requested path', async () => {
    request.headers.set('x-pp-path', '/portfolio');
    await expect(loadShell()).rejects.toEqual(new RedirectError('/login?next=%2Fportfolio'));
  });

  it('adds overdue counts from the portfolio for firm users', async () => {
    await signIn('consultant@demo.test', true);
    const model = await loadShell();
    expect(model.clients.map((c) => [c.name, c.overdueCount])).toEqual([
      ['Demo Metals', 5],
      ['Northwind Textiles', 0],
    ]);
  });

  it('skips the portfolio for client users', async () => {
    await signIn('owner@demo.test', false);
    const model = await loadShell();
    expect(model.clients.map((c) => c.overdueCount)).toEqual([0]);
    expect(model.approvalsWaiting).toBe(0);
  });

  it('counts the approvals waiting for an approver', async () => {
    await signIn('approver@demo.test', true);
    expect((await loadShell()).approvalsWaiting).toBe(MOCK_APPROVALS_WAITING);
  });

  it('hides counts it could not load', async () => {
    await signIn('consultant@demo.test', true);
    const api = await serverApi();
    vi.spyOn(api, 'portfolio').mockRejectedValue(new Error('down'));
    const serverModule = await import('../api/server');
    vi.spyOn(serverModule, 'serverApi').mockResolvedValue(api);
    const model = await loadShell();
    expect(model.clients.map((c) => c.overdueCount)).toEqual([0, 0]);
    vi.restoreAllMocks();
  });

  it('guesses the layout from the cookie and headers', async () => {
    expect(await shellLayoutHint()).toBe('sidebar');
    request.headers.set('sec-ch-ua-mobile', '?1');
    expect(await shellLayoutHint()).toBe('sheet');
    request.cookies.set('pp_layout', 'rail');
    expect(await shellLayoutHint()).toBe('rail');
  });
});

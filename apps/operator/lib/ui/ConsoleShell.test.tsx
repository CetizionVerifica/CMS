import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { navigation, router } from '../test/navigation';

vi.mock('next/navigation', () => navigation);

const { ConsoleShell, pageTitle } = await import('./ConsoleShell');
const { SessionProvider, loginHref, useSession } = await import('../session');
const { apiError, fakeApi, ME } = await import('../test/fake-api');

afterEach(() => {
  vi.unstubAllGlobals();
  router.replace.mockReset();
  router.push.mockReset();
});

describe('the console shell', () => {
  it('shows the operator, the four areas, and signs out', async () => {
    const api = fakeApi({ 'POST /auth/logout': { status: 204 } });
    vi.stubGlobal('fetch', api.fetch);
    render(
      <ConsoleShell>
        <h1>Accounts</h1>
      </ConsoleShell>,
    );
    expect(screen.getByRole('status').textContent).toMatch(/Checking your session/);
    expect(await screen.findByRole('heading', { name: 'Accounts', level: 1 })).toBeTruthy();
    const nav = screen.getByRole('navigation');
    for (const label of ['Accounts', 'Renewals', 'Plans', 'Operator audit']) {
      expect(within(nav).getByRole('link', { name: label })).toBeTruthy();
    }
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Meera Iyer/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
    const logout = api.sent.find((s) => s.path === '/auth/logout')!;
    expect(logout.headers.get('x-csrf-token')).toBe(ME.csrfToken);
  });

  it('sends a signed-out operator to sign in and back, and reports a session it cannot read', async () => {
    vi.stubGlobal(
      'fetch',
      fakeApi({ 'GET /me': apiError(401, 'UNAUTHENTICATED', 'Sign in.') }).fetch,
    );
    const { unmount } = render(<ConsoleShell>page</ConsoleShell>);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login?next=%2Faccounts'));
    unmount();
    vi.stubGlobal('fetch', fakeApi({ 'GET /me': apiError(500, 'INTERNAL', 'Boom.') }).fetch);
    render(<ConsoleShell>page</ConsoleShell>);
    expect(await screen.findByText(/could not load your session/)).toBeTruthy();
  });

  it('names every page', () => {
    expect(pageTitle('/accounts')).toBe('Accounts · PlanetPulse Operator Console');
    expect(pageTitle('/accounts/new')).toMatch(/^New account/);
    expect(pageTitle('/accounts/0190')).toMatch(/^Account ·/);
    expect(pageTitle('/audit')).toMatch(/^Operator audit/);
    expect(pageTitle('/elsewhere')).toMatch(/^Accounts/);
  });
});

describe('the session', () => {
  it('only sends the operator back to console paths', () => {
    expect(loginHref('/plans')).toBe('/login?next=%2Fplans');
    expect(loginHref('/')).toBe('/login');
    expect(loginHref('//evil.example')).toBe('/login');
    expect(loginHref('/login?next=x')).toBe('/login');
  });

  it('refuses to be used outside its provider, and signs out even when the API fails', async () => {
    const Broken = () => {
      useSession();
      return null;
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Broken />)).toThrow(/outside SessionProvider/);
    const api = fakeApi({ 'POST /auth/logout': apiError(500, 'INTERNAL', 'Boom.') });
    const navigate = vi.fn();
    let signOut: (() => Promise<void>) | undefined;
    const Grab = () => {
      signOut = useSession().signOut;
      return <p>ready</p>;
    };
    render(
      <SessionProvider path="/plans" navigate={navigate} fetchImpl={api.fetch}>
        {(s) => (s.state === 'ready' ? <Grab /> : null)}
      </SessionProvider>,
    );
    await screen.findByText('ready');
    await expect(signOut!()).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(navigate).toHaveBeenCalledWith('/login');
  });
});

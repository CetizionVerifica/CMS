import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setViewport } from '../test/viewport';
import type { ShellModel } from './model';

const nav = { pathname: '/c/c1/register', search: 'fy=2022-23&q=Q3', push: vi.fn() };
const signOut = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../auth/actions', () => ({ signOut: () => signOut() }));

const { ShellFrame, usePrimaryAction, useSettledTitle } = await import('./ShellFrame');

const period = {
  thisPeriod: { fy: '2022-23', quarter: 4 as const },
  availableFys: ['2022-23', '2023-24'],
  availableUntil: '2023-03',
};
const model: ShellModel = {
  user: { name: 'Consultant 01', detail: 'Consultant', email: 'c@demo.test' },
  isFirmUser: true,
  clients: [
    {
      id: 'c1',
      name: 'Demo Metals',
      meta: '3 units',
      overdueCount: 5,
      fyStartMonth: 4,
      timeZone: 'Asia/Kolkata',
      ...period,
    },
    {
      id: 'c2',
      name: 'Northwind Textiles',
      meta: '1 unit',
      overdueCount: 0,
      fyStartMonth: 4,
      timeZone: 'Asia/Kolkata',
      ...period,
    },
  ],
  roles: { firm: ['CONSULTANT'], byClient: { c1: ['CONSULTANT'], c2: ['CONSULTANT'] } },
  approvalsWaiting: 0,
  features: [],
};

function renderShell(
  props: Partial<Parameters<typeof ShellFrame>[0]> = {},
  child: ReactNode = <h1>Register</h1>,
) {
  return render(
    <ShellFrame model={model} initialLayout="sidebar" {...props}>
      {child}
    </ShellFrame>,
  );
}

describe('ShellFrame', () => {
  beforeEach(() => {
    nav.pathname = '/c/c1/register';
    nav.search = 'fy=2022-23&q=Q3';
    nav.push.mockReset();
    signOut.mockReset();
  });

  it('renders the client sidebar with the current page marked, and the brand', () => {
    renderShell();
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(within(main).getByRole('link', { name: 'Register' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(main).getByRole('link', { name: 'Register' }).getAttribute('href')).toBe(
      '/c/c1/register',
    );
    expect(within(main).getByText('PlanetPulse Compliance')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/canopy/i);
    expect(document.title).toBe('Register · Demo Metals · PlanetPulse Compliance');
  });

  it('shows the ISO group with its icons only when the account has the ISO add-on', () => {
    const { unmount } = renderShell();
    const main = () => screen.getByRole('navigation', { name: 'Main' });
    expect(within(main()).queryByRole('link', { name: 'Nonconformities' })).toBeNull();
    expect(within(main()).queryByText('ISO')).toBeNull();
    unmount();
    renderShell({ model: { ...model, features: ['isoManagement'] } });
    const link = within(main()).getByRole('link', { name: 'Nonconformities' });
    expect(link.getAttribute('href')).toBe('/c/c1/iso/nonconformities');
    expect(link.querySelector('svg')).toBeTruthy();
    expect(within(main()).getByText('ISO')).toBeTruthy();
  });

  it('titles an ISO page as not turned on when the account lacks the add-on', () => {
    nav.pathname = '/c/c1/iso/audits';
    const { unmount } = renderShell({}, <h1>ISO management systems</h1>);
    expect(document.title).toBe('Not turned on · Demo Metals · PlanetPulse Compliance');
    unmount();
    renderShell({ model: { ...model, features: ['isoManagement'] } }, <h1>Audits</h1>);
    expect(document.title).toBe('Audits · Demo Metals · PlanetPulse Compliance');
  });

  it('shows the approvals waiting as a badge on Approvals, and none at zero', () => {
    const approver = { ...model.roles, byClient: { c1: ['APPROVER' as const] } };
    const { unmount } = renderShell({ model: { ...model, roles: approver } });
    const approvals = () =>
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: /Approvals/,
      });
    expect(approvals().textContent).toBe('Approvals');
    unmount();
    renderShell({ model: { ...model, roles: approver, approvalsWaiting: 4 } });
    expect(approvals().textContent).toContain('4');
    // The count covers every client the user approves in, not just this one.
    expect(within(approvals()).getByText(/4 waiting across all your clients/)).toBeTruthy();
  });

  it('shows the period from the URL and writes a new one into it', async () => {
    renderShell();
    const trigger = screen.getByRole('button', { name: /FY 2022–23, quarter 3/ });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('button', { name: /This period/ }));
    expect(nav.push).toHaveBeenCalledWith('/c/c1/register?fy=2022-23&q=Q4');
  });

  it('falls back to the engine’s current period when the URL has none', () => {
    nav.search = '';
    renderShell();
    expect(screen.getByRole('button', { name: /FY 2022–23, quarter 4/ })).toBeTruthy();
  });

  it('switches client and keeps the page and period', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: /Demo Metals/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Northwind Textiles/ }));
    expect(nav.push).toHaveBeenCalledWith('/c/c2/register?fy=2022-23&q=Q3');
    expect(JSON.parse(window.localStorage.getItem('pp.recentClients')!)).toEqual(['c1']);
  });

  it('shows only firm items and no period picker without a client', () => {
    nav.pathname = '/library/obligations';
    nav.search = '';
    renderShell({}, <h1>Obligations</h1>);
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(
      within(main)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['PlanetPulse Compliance', 'Portfolio', 'Library']);
    expect(within(main).getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.queryByRole('button', { name: /FY/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Choose a client/ })).toBeTruthy();
    expect(document.title).toBe('Obligations · PlanetPulse Compliance');
  });

  it('treats a client id the user doesn’t have as no client', () => {
    nav.pathname = '/c/other/register';
    renderShell();
    expect(screen.queryByRole('link', { name: 'Register' })).toBeNull();
  });

  it('hides the switcher for a user with no clients', () => {
    nav.pathname = '/library/acts';
    renderShell({
      model: { ...model, clients: [], isFirmUser: false, roles: { firm: [], byClient: {} } },
    });
    expect(screen.queryByRole('button', { name: /Choose a client/ })).toBeNull();
  });

  it('searches the register for the current client', async () => {
    renderShell();
    const box = screen.getByRole('searchbox', { name: 'Search this client’s register' });
    await userEvent.type(box, 'x{Enter}');
    expect(nav.push).not.toHaveBeenCalled();
    await userEvent.type(box, 'factories{Enter}');
    expect(nav.push).toHaveBeenCalledWith('/c/c1/register?q=xfactories');
  });

  it('searches the library without a client', async () => {
    nav.pathname = '/portfolio';
    renderShell();
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search the obligation library' }),
      'gratuity{Enter}',
    );
    expect(nav.push).toHaveBeenCalledWith('/library/obligations?q=gratuity');
  });

  it('signs out from the user menu', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu, Consultant 01' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalled();
  });

  it('renders the server’s layout guess first, then follows the viewport and saves it', async () => {
    setViewport(390);
    const { container } = renderShell({ initialLayout: 'sheet' });
    expect(container.querySelector('[data-layout]')?.getAttribute('data-layout')).toBe('sheet');
    expect(document.cookie).toContain('pp_layout=sheet');
    act(() => setViewport(800));
    expect(container.querySelector('[data-layout]')?.getAttribute('data-layout')).toBe('rail');
    expect(document.cookie).toContain('pp_layout=rail');
  });

  it('lets a page set the top-bar primary action', async () => {
    const { Upload } = await import('lucide-react');
    const action = { label: 'Import file', icon: Upload, href: '/c/c1/import' };
    function Page() {
      usePrimaryAction(action);
      return <h1>Import</h1>;
    }
    const { unmount } = renderShell({}, <Page />);
    expect((await screen.findByRole('link', { name: 'Import file' })).getAttribute('href')).toBe(
      '/c/c1/import',
    );
    unmount();
  });

  it('moves focus to the new page’s h1 once it renders', async () => {
    const { rerender } = renderShell();
    nav.pathname = '/c/c1/calendar';
    // The URL changes first; the old page is still showing (loading).
    rerender(
      <ShellFrame model={model} initialLayout="sidebar">
        <h1>Register</h1>
      </ShellFrame>,
    );
    expect(document.title).toBe('Register · Demo Metals · PlanetPulse Compliance');
    rerender(
      <ShellFrame model={model} initialLayout="sidebar">
        <h1>Calendar</h1>
      </ShellFrame>,
    );
    await vi.waitFor(() =>
      expect(document.title).toBe('Calendar · Demo Metals · PlanetPulse Compliance'),
    );
    expect(document.activeElement?.textContent).toBe('Calendar');
  });
});

describe('useSettledTitle', () => {
  function Probe({
    title,
    h1,
    busy,
    maxWaitMs,
  }: {
    title: string;
    h1?: string;
    busy?: boolean;
    maxWaitMs?: number;
  }) {
    const settled = useSettledTitle(title, 50, maxWaitMs);
    return (
      <main>
        <div aria-busy={busy ? 'true' : undefined}>Content</div>
        {h1 ? <h1>{h1}</h1> : null}
        <p data-testid="settled">{settled}</p>
      </main>
    );
  }

  it('applies the title when the loading state ends by dropping aria-busy alone', async () => {
    const { rerender } = render(<Probe title="A" h1="Overview" />);
    rerender(<Probe title="B" h1="Register" busy />);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.getByTestId('settled').textContent).toBe('A');
    // Same tree, only the attribute changes.
    rerender(<Probe title="B" h1="Register" />);
    await vi.waitFor(() => expect(screen.getByTestId('settled').textContent).toBe('B'));
  });

  it('gives up waiting after the cap, for a page that never renders an h1', async () => {
    const { rerender } = render(<Probe title="A" h1="Overview" maxWaitMs={150} />);
    rerender(<Probe title="B" busy maxWaitMs={150} />);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.getByTestId('settled').textContent).toBe('A');
    await vi.waitFor(() => expect(screen.getByTestId('settled').textContent).toBe('B'));
  });

  it('waits past the timeout for a slow page’s h1, then applies the title', async () => {
    const { rerender } = render(<Probe title="A" h1="Overview" />);
    // Navigating: the loading skeleton replaces the old page and has no h1.
    rerender(<Probe title="B" busy />);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.getByTestId('settled').textContent).toBe('A');
    rerender(<Probe title="B" h1="Register" busy />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('settled').textContent).toBe('A');
    rerender(<Probe title="B" h1="Register" />);
    await vi.waitFor(() => expect(screen.getByTestId('settled').textContent).toBe('B'));
  });

  it('applies the title after a timeout when the h1 never changes', async () => {
    const { rerender } = render(<Probe title="A" h1="Same" />);
    rerender(<Probe title="B" h1="Same" />);
    expect(screen.getByTestId('settled').textContent).toBe('A');
    await vi.waitFor(() => expect(screen.getByTestId('settled').textContent).toBe('B'));
  });

  it('applies the title as soon as the h1 changes', async () => {
    const { rerender } = render(<Probe title="A" h1="One" />);
    rerender(<Probe title="B" h1="Two" />);
    await vi.waitFor(() => expect(screen.getByTestId('settled').textContent).toBe('B'));
  });

  it('shows the account notice above the page, and leaves the switcher out when asked', () => {
    renderShell({ model: { ...model, notice: { kind: 'trial', endsOn: '2026-11-23' } } });
    const notice = screen.getByRole('note', { name: 'Account' });
    expect(notice.textContent).toBe(
      'Trial account. Your trial ends on 23 Nov 2026. Contact PlanetPulse to continue.',
    );
    expect(screen.getByRole('button', { name: /Demo Metals/ })).toBeTruthy();
  });

  it('words a support visit and a closing account, and hides the switcher for one company client', () => {
    const { unmount } = renderShell({
      model: {
        ...model,
        notice: { kind: 'support' },
        showClientSwitcher: false,
        showPortfolio: false,
      },
    });
    expect(screen.queryByRole('link', { name: 'Portfolio' })).toBeNull();
    expect(screen.getByRole('note', { name: 'Account' }).textContent).toContain(
      'PlanetPulse support. You are in this account with the access its admins granted.',
    );
    expect(screen.queryByRole('button', { name: /Demo Metals/ })).toBeNull();
    unmount();
    renderShell({ model: { ...model, notice: { kind: 'closing' } } });
    expect(screen.getByRole('note', { name: 'Account' }).textContent).toContain(
      'This account is closing.',
    );
  });
});

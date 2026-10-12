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
    expect(within(approvals()).getByText(/4 waiting/)).toBeTruthy();
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
  function Probe({ title, h1 }: { title: string; h1: string }) {
    const settled = useSettledTitle(title, 50);
    return (
      <main>
        <h1>{h1}</h1>
        <p data-testid="settled">{settled}</p>
      </main>
    );
  }

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
});

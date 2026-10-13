import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  FileUp,
  FolderOpen,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Plus,
  User,
} from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { setViewport } from '../../test/viewport';
import { AppShell, currentHref, type AppShellProps, type NavGroup } from './AppShell';

const nav: NavGroup[] = [
  {
    items: [
      { label: 'Overview', href: '/c/1/overview', icon: LayoutDashboard },
      { label: 'Register', href: '/c/1/register', icon: ListChecks },
      { label: 'Calendar', href: '/c/1/calendar', icon: CalendarDays },
      {
        label: 'Approvals',
        href: '/c/1/approvals',
        icon: ClipboardCheck,
        badge: { count: 4, label: '4 waiting' },
      },
      {
        label: 'Evidence',
        href: '/c/1/evidence',
        icon: FolderOpen,
        badge: { count: 0, label: 'none' },
      },
    ],
  },
  { label: 'Setup', items: [{ label: 'Import', href: '/c/1/import', icon: FileUp }] },
  { label: 'Reporting', items: [{ label: 'Reports', href: '/c/1/reports', icon: BookOpen }] },
];

function Shell(props: Partial<AppShellProps>) {
  return (
    <AppShell
      nav={nav}
      activeHref="/c/1/register"
      helpCard={{ title: 'Need help?', body: 'Ask your consultant.', href: '/help' }}
      topBar={{
        clientSwitcher: <button type="button">Kestrel Aluminium Belur</button>,
        periodPicker: <button type="button">FY 2022–23</button>,
        search: <input aria-label="Search register" type="search" />,
        primaryAction: { label: 'Assign obligation', icon: Plus, onClick: () => {} },
        user: {
          name: 'Priya Rane',
          detail: 'Owner · Kestrel Aluminium Belur',
          items: [
            { label: 'Profile', icon: User, href: '/profile' },
            { label: 'Sign out', icon: LogOut, onSelect: () => {}, destructive: true },
          ],
        },
      }}
      {...props}
    >
      <h1>Register</h1>
      <input aria-label="Filter" />
    </AppShell>
  );
}

describe('AppShell at 1280px (sidebar)', () => {
  it('has one nav, header and main, and marks the current page', async () => {
    render(<Shell />);
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Register' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Overview' }).hasAttribute('aria-current')).toBe(
      false,
    );
    expect(within(nav).getByRole('link', { name: /^Approvals ?, 4 waiting$/ })).toBeTruthy();
    // A zero count shows no badge.
    expect(within(nav).getByRole('link', { name: 'Evidence' })).toBeTruthy();
    expect(within(nav).getByText('Setup')).toBeTruthy();
    expect(within(nav).getByText('Need help?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Assign obligation' }).textContent).toBe(
      'Assign obligation',
    );
    await expectNoAxeViolations();
  });

  it('tabs skip link → sidebar → top bar → main; Enter on the skip link focuses main', async () => {
    const user = userEvent.setup();
    render(<Shell />);
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(document.activeElement).toBe(skip);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Overview' }));
    for (let i = 0; i < 7; i++) await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Get help' }));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Kestrel Aluminium Belur' }),
    );
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search register' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Assign obligation' }));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Account menu, Priya Rane' }),
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Filter' }));

    skip.focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('"/" focuses search unless typing in a field', async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const search = screen.getByRole('searchbox', { name: 'Search register' });
    const filter = screen.getByRole('textbox', { name: 'Filter' });
    await user.click(filter);
    await user.keyboard('/');
    expect(document.activeElement).toBe(filter);
    expect((filter as HTMLInputElement).value).toBe('/');
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('/');
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('on a title change sets document.title, focuses the h1 and announces it', async () => {
    const { rerender } = render(
      <Shell title="Overview · Kestrel Aluminium Belur · PlanetPulse Compliance" />,
    );
    expect(document.title).toBe('Overview · Kestrel Aluminium Belur · PlanetPulse Compliance');
    expect(document.activeElement).toBe(document.body);
    rerender(<Shell title="Register · Kestrel Aluminium Belur · PlanetPulse Compliance" />);
    expect(document.title).toBe('Register · Kestrel Aluminium Belur · PlanetPulse Compliance');
    const h1 = screen.getByRole('heading', { level: 1, name: 'Register' });
    expect(document.activeElement).toBe(h1);
    expect(h1.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByText('Register', { selector: '[aria-live] *, [aria-live]' })).toBeTruthy();
  });

  it('does not focus or announce on first load under StrictMode', () => {
    render(
      <StrictMode>
        <Shell title="Overview · Kestrel Aluminium Belur · PlanetPulse Compliance" />
      </StrictMode>,
    );
    expect(document.activeElement).toBe(document.body);
    expect(document.querySelector('[aria-live]')?.textContent).toBe('');
  });

  it('shows the client-facing product name by default', () => {
    render(<Shell />);
    expect(document.body.textContent).toContain('PlanetPulse Compliance');
    expect(document.body.textContent).not.toContain('Canopy');
  });

  it('opens the account menu and runs an item', async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(
      <Shell
        topBar={{
          user: { name: 'Priya Rane', items: [{ label: 'Sign out', onSelect: onSignOut }] },
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Account menu, Priya Rane' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('borders the top bar once the page scrolls', () => {
    render(<Shell />);
    const header = screen.getByRole('banner');
    expect(header.className).toContain('border-transparent');
    act(() => {
      window.scrollY = 120;
      window.dispatchEvent(new Event('scroll'));
    });
    expect(header.className).toContain('border-line');
    window.scrollY = 0;
  });

  it('uses a custom link renderer and brand link', () => {
    const renderLink = vi.fn(({ children, ...p }) => (
      <a data-router="yes" {...p}>
        {children}
      </a>
    ));
    render(<Shell brand={{ name: 'PlanetPulse', href: '/' }} renderLink={renderLink} />);
    expect(screen.getByRole('link', { name: 'PlanetPulse' }).getAttribute('data-router')).toBe(
      'yes',
    );
    expect(screen.getByRole('link', { name: 'Register' }).getAttribute('data-router')).toBe('yes');
  });

  it('renders a primary action that is a link', () => {
    render(
      <Shell
        topBar={{
          primaryAction: { label: 'Import register', icon: FileUp, href: '/import' },
          user: { name: 'A B', items: [] },
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Import register' }).getAttribute('href')).toBe(
      '/import',
    );
  });
});

describe('AppShell at 800px (rail)', () => {
  it('shows icons only, names links with their badge and shows a tooltip on focus', async () => {
    setViewport(800);
    const user = userEvent.setup();
    render(<Shell />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.className).toContain('w-rail');
    const approvals = within(nav).getByRole('link', { name: 'Approvals, 4 waiting' });
    expect(approvals.textContent).toBe('');
    expect(within(nav).getByRole('separator', { name: 'Setup' })).toBeTruthy();
    expect(within(nav).queryByText('Need help?')).toBeNull();
    // Primary action collapses to an icon button.
    expect(screen.getByRole('button', { name: 'Assign obligation' }).textContent).toBe('');
    await expectNoAxeViolations();

    approvals.focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}{Tab}');
    expect((await screen.findByRole('tooltip')).textContent).toBe('Approvals');
  });

  it('collapses a link primary action too', () => {
    setViewport(800);
    render(
      <Shell
        topBar={{
          primaryAction: { label: 'Import register', icon: FileUp, href: '/import' },
          user: { name: 'A B', items: [] },
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Import register' }).textContent).toBe('');
  });
});

describe('AppShell at 375px (sheet)', () => {
  it('opens the nav as a bottom sheet; Esc closes it and focus returns to the menu button', async () => {
    setViewport(375);
    const user = userEvent.setup();
    render(<Shell />);
    expect(screen.queryByRole('navigation')).toBeNull();
    const menuButton = screen.getByRole('button', { name: 'Open menu' });
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(menuButton);
    await user.keyboard('{Enter}');
    const sheet = await screen.findByRole('dialog', { name: 'Menu' });
    expect(within(sheet).getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'Register' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await expectNoAxeViolations();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menuButton);
  });

  it('closes the sheet when a nav link is followed', async () => {
    setViewport(375);
    const user = userEvent.setup();
    const renderLink = ({
      children,
      onClick,
      ...p
    }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a
        {...p}
        onClick={(e) => {
          e.preventDefault();
          onClick?.(e);
        }}
      >
        {children}
      </a>
    );
    render(<Shell renderLink={renderLink as AppShellProps['renderLink']} />);
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('link', { name: 'Calendar' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('collapses search into a button; "/" opens and focuses it', async () => {
    setViewport(375);
    const user = userEvent.setup();
    render(<Shell />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Search' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(screen.getByRole('searchbox', { name: 'Search register' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('/');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('searchbox', { name: 'Search register' }),
      ),
    );
  });

  it('switches layout live when the viewport changes', () => {
    render(<Shell />);
    expect(screen.getByRole('navigation').className).toContain('w-sidebar');
    act(() => setViewport(375));
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});

describe('AppShell fixed layouts for demos', () => {
  it('honours a fixed layout regardless of the viewport', () => {
    render(<Shell layout="rail" />);
    expect(screen.getByRole('navigation').className).toContain('w-rail');
  });
});

describe('currentHref', () => {
  it('matches exactly, else the longest nav href that prefixes the page at a path boundary', () => {
    const groups: NavGroup[] = [
      ...nav,
      { items: [{ label: 'Client', href: '/c/1', icon: LayoutDashboard }] },
    ];
    expect(currentHref(groups, '/c/1/register')).toBe('/c/1/register');
    expect(currentHref(groups, '/c/1/register/TAX-CL-033')).toBe('/c/1/register');
    expect(currentHref(groups, '/c/1/register?status=overdue')).toBe('/c/1/register');
    expect(currentHref(groups, '/c/1/registers')).toBe('/c/1');
    expect(currentHref(groups, '/c/2/register')).toBeUndefined();
  });
});

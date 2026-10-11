import {
  BookOpen,
  Building2,
  CalendarDays,
  ClipboardCheck,
  FileClock,
  FileUp,
  FolderOpen,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Plus,
  Repeat,
  Search,
  User,
  Users,
} from 'lucide-react';

import { AppShell, Button, type AppShellLayout, type NavGroup } from '../../src';
import { Page, Section } from '../Page';
import { useRoute } from '../router';
import { shellVariants } from '../routes';

function clientNav(approvals: number): NavGroup[] {
  return [
    {
      items: [
        { label: 'Overview', href: '#/shell/overview', icon: LayoutDashboard },
        { label: 'Register', href: '#/shell/register', icon: ListChecks },
        { label: 'Calendar', href: '#/shell/calendar', icon: CalendarDays },
        {
          label: 'Approvals',
          href: '#/shell/approvals',
          icon: ClipboardCheck,
          badge: { count: approvals, label: `${approvals} waiting` },
        },
        { label: 'Evidence', href: '#/shell/evidence', icon: FolderOpen },
      ],
    },
    {
      label: 'Reporting',
      items: [
        { label: 'Reports', href: '#/shell/reports', icon: BookOpen },
        { label: 'Audit trail', href: '#/shell/audit', icon: FileClock },
      ],
    },
    {
      label: 'Setup',
      items: [
        { label: 'Entities', href: '#/shell/entities', icon: Building2 },
        { label: 'People', href: '#/shell/people', icon: Users },
        { label: 'Import', href: '#/shell/import', icon: FileUp },
      ],
    },
  ];
}

const firmNav: NavGroup[] = [
  {
    items: [
      { label: 'Portfolio', href: '#/shell/portfolio', icon: LayoutDashboard },
      { label: 'Library', href: '#/shell/library', icon: BookOpen },
    ],
  },
];

const titles: Record<string, string> = {
  overview: 'Overview',
  register: 'Register',
  calendar: 'Calendar',
  approvals: 'Approvals',
  evidence: 'Evidence',
  reports: 'Reports',
  audit: 'Audit trail',
  entities: 'Entities',
  people: 'People',
  import: 'Import',
  portfolio: 'Portfolio',
  library: 'Library',
};

/** A full-page shell. Query: layout, badge, client=long|none. Used directly and inside the gallery's frames. */
export function ShellFrame() {
  const { path, params } = useRoute();
  const layout = (params.get('layout') ?? 'auto') as AppShellLayout;
  const badge = Number(params.get('badge') ?? 4);
  const client = params.get('client');
  const noClient = client === 'none';
  const clientName =
    client === 'long'
      ? 'Hindalco Industries Limited, Belur Aluminium Rolling Plant'
      : 'Hindalco Belur';
  const page = path.split('/')[2] || (noClient ? 'portfolio' : 'overview');
  const query = params.toString();
  const withQuery = (groups: NavGroup[]) =>
    groups.map((g) => ({
      ...g,
      items: g.items.map((i) => ({ ...i, href: query ? `${i.href}?${query}` : i.href })),
    }));
  const nav = withQuery(noClient ? firmNav : clientNav(badge));
  const title = titles[page] ?? 'Overview';

  return (
    <AppShell
      layout={layout}
      nav={nav}
      activeHref={
        nav.flatMap((g) => g.items).find((i) => i.href.startsWith(`#/shell/${page}`))?.href ?? ''
      }
      title={`${title} · ${noClient ? 'Firm' : clientName} · PlanetPulse Compliance`}
      helpCard={{
        title: 'Need help?',
        body: 'Your consultant answers within one working day.',
        href: '#/shell/help',
      }}
      topBar={{
        clientSwitcher: (
          <Button size="sm" className="max-w-full justify-start sm:max-w-72">
            <span className="truncate">{noClient ? 'Choose a client' : clientName}</span>
          </Button>
        ),
        periodPicker: noClient ? undefined : (
          <span className="inline-flex h-control-compact items-center rounded-chip bg-sage px-3 text-meta font-bold text-forest">
            FY 2022–23
          </span>
        ),
        search: (
          <label className="relative block">
            <span className="sr-only">Search obligations</span>
            <Search
              aria-hidden
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              type="search"
              placeholder="Search obligations  /"
              className="h-control w-full rounded-control border border-line-strong bg-surface pl-9 pr-3 text-body text-ink placeholder:text-muted"
            />
          </label>
        ),
        primaryAction: noClient
          ? undefined
          : { label: 'Assign obligation', icon: Plus, onClick: () => {} },
        user: {
          name: 'Priya Rane',
          detail: 'Consultant · Cetizion',
          items: [
            { label: 'Profile', icon: User, href: '#/shell/profile' },
            { label: 'Switch firm', icon: Repeat, onSelect: () => {} },
            { label: 'Sign out', icon: LogOut, onSelect: () => {}, destructive: true },
          ],
        },
      }}
    >
      <h1 className="text-page text-ink">{title}</h1>
      <p className="mt-1 text-body text-muted">5 items are overdue, 2 are super critical.</p>
      <div className="mt-3.5 grid gap-3.5 sm:grid-cols-2">
        {['Compliance score', 'Open', 'Overdue', 'Awaiting approval'].map((k) => (
          <div key={k} className="rounded-card border border-line bg-surface px-4 py-3.5">
            <p className="text-card text-ink">{k}</p>
            <p className="mt-2 text-kpi tabular text-ink">—</p>
          </div>
        ))}
      </div>
      <div aria-hidden className="h-[120vh]" />
    </AppShell>
  );
}

export function ShellPage() {
  return (
    <Page
      title="AppShell"
      intro="Sidebar at 1100px and up, icon rail from 640px, bottom sheet below. Open a variant on its own to try the keyboard path."
    >
      <p className="text-body text-ink">
        <a className="font-semibold text-forest underline" href="#/shell">
          Open the responsive shell
        </a>{' '}
        and resize the window.
      </p>
      {shellVariants.map((v) => (
        <Section key={v.query} title={v.label} className="block">
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label={`${v.label}, scrollable`}
          >
            <iframe
              title={`AppShell: ${v.label}`}
              src={`#/shell?${v.query}`}
              style={{ width: v.width }}
              className="h-[420px] rounded-chip border border-line"
            />
          </div>
        </Section>
      ))}
    </Page>
  );
}

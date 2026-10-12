'use client';
// The signed-in frame: AppShell with Next links, the client switcher, the period picker (URL state) and the search
// box. Server layouts pass plain data in; everything that needs the router or the viewport lives here.
import {
  AppShell,
  ClientSwitcher,
  PeriodPicker,
  Toaster,
  useMediaQuery,
  type AppShellLayout,
  type LinkRenderer,
  type NavGroup,
  type Period,
  type PrimaryAction,
} from '@canopy/ui';
import {
  BookOpen,
  Briefcase,
  Building2,
  CalendarDays,
  ChartColumn,
  CheckCheck,
  FolderOpen,
  History,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Upload,
  Users,
  type LucideIcon,
} from 'lucide-react';
import NextLink from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';

import { signOut } from '../auth/actions';
import { documentTitle, PRODUCT_NAME } from '../brand';
import { LAYOUT_COOKIE, layoutForWidth, type ShellLayout } from '../layout-hint';
import { periodFromParams, withPeriod } from '../period';
import { clientIdFromPath, findRoute, switchClientHref } from '../routes';
import { navSections, type ShellModel } from './model';
import { rememberClient, recentClients } from './recent';
import { SearchBox } from './SearchBox';

const ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  register: ListChecks,
  calendar: CalendarDays,
  approvals: CheckCheck,
  evidence: FolderOpen,
  reports: ChartColumn,
  audit: History,
  'setup/entities': Building2,
  'setup/people': Users,
  import: Upload,
  portfolio: Briefcase,
  'library/acts': BookOpen,
};

const renderLink: LinkRenderer = ({ href, children, ...rest }) => (
  <NextLink href={href} {...rest}>
    {children}
  </NextLink>
);

type PrimaryActionContext = (action: PrimaryAction | undefined) => void;
const SetPrimaryAction = createContext<PrimaryActionContext>(() => {});

/**
 * Lets a page put its main action in the top bar ("Submit for approval", "Import file"). Call it from a Client
 * Component with a memoised action (useMemo), so it isn't re-set on every render; it is removed on unmount.
 */
export function usePrimaryAction(action: PrimaryAction | undefined): void {
  const set = useContext(SetPrimaryAction);
  useEffect(() => {
    set(action);
    return () => set(undefined);
  }, [set, action]);
}

export type ShellFrameProps = {
  model: ShellModel;
  /** Server guess of the layout (lib/layout-hint.ts), used until hydration so phones don't flash the sidebar. */
  initialLayout: ShellLayout;
  children: ReactNode;
};

export function ShellFrame({ model, initialLayout, children }: ShellFrameProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [primaryAction, setPrimaryAction] = useState<PrimaryAction | undefined>();
  const layout = useHydratedLayout(initialLayout);

  // The client in the URL, if it is one of the user's (the client layout 404s any other).
  const urlClientId = clientIdFromPath(pathname);
  const current = model.clients.find((c) => c.id === urlClientId);
  const nav = navSections(
    current ? (model.roles.byClient[current.id] ?? []) : model.roles.firm,
    current?.id,
  );
  const search = searchParams.toString();
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    setRecentIds(current ? rememberClient(current.id) : recentClients());
  }, [current]);

  const navGroups: NavGroup[] = nav.map((section) => ({
    label: section.label,
    items: section.items.map((item) => ({
      label: item.label,
      href: item.href,
      icon: ICONS[item.path] ?? LayoutDashboard,
      ...(item.path === 'approvals'
        ? {
            // GET /me/approvals counts across every client the user approves in, so the label says so.
            badge: {
              count: model.approvalsWaiting,
              label: `${model.approvalsWaiting} waiting across all your clients`,
            },
          }
        : {}),
    })),
  }));

  const title = useMemo(() => {
    const scope = clientIdFromPath(pathname) ? 'client' : 'firm';
    const segments = pathname
      .split('/')
      .filter(Boolean)
      .slice(scope === 'client' ? 2 : 0);
    // A record page (/register/123) takes its list's title.
    let route;
    for (let n = segments.length; n > 0 && !route; n--)
      route = findRoute(scope, segments.slice(0, n));
    return documentTitle(route?.label, current?.name);
  }, [pathname, current?.name]);

  const settledTitle = useSettledTitle(title);

  // A path under /library keeps the Library item current, whichever library page it is.
  const activeHref = pathname.startsWith('/library') ? '/library/acts' : pathname;

  const period: Period | undefined = current
    ? (periodFromParams(searchParams) ?? current.thisPeriod)
    : undefined;

  const onPeriodChange = useCallback(
    (next: Period) => router.push(`${pathname}?${withPeriod(search, next).toString()}`),
    [router, pathname, search],
  );

  return (
    <SetPrimaryAction.Provider value={setPrimaryAction}>
      <AppShell
        nav={navGroups}
        activeHref={activeHref}
        brand={{ name: PRODUCT_NAME, href: model.isFirmUser ? '/portfolio' : '/' }}
        title={settledTitle}
        layout={layout}
        renderLink={renderLink}
        helpCard={{
          title: 'Need help?',
          body: 'Your consultant can explain any obligation or deadline.',
        }}
        topBar={{
          clientSwitcher:
            model.clients.length > 0 ? (
              <ClientSwitcher
                current={current}
                clients={model.clients}
                recentIds={recentIds}
                hrefFor={(id) => switchClientHref(pathname, search, id)}
                onNavigate={(href) => router.push(href)}
                overviewHref={model.isFirmUser ? '/portfolio' : undefined}
                renderLink={renderLink}
              />
            ) : undefined,
          periodPicker:
            current && period ? (
              <PeriodPicker
                value={period}
                onChange={onPeriodChange}
                fyStartMonth={current.fyStartMonth}
                availableFys={current.availableFys}
                thisPeriod={current.thisPeriod}
                availableUntil={current.availableUntil ?? undefined}
              />
            ) : undefined,
          search: <SearchBox clientId={current?.id} />,
          primaryAction,
          user: {
            name: model.user.name,
            detail: model.user.detail,
            items: [
              {
                label: 'Sign out',
                icon: LogOut,
                onSelect: () => startTransition(() => signOut()),
              },
            ],
          },
        }}
      >
        {children}
      </AppShell>
      <Toaster />
    </SetPrimaryAction.Provider>
  );
}

/**
 * The route's title, applied once the new page's h1 is in the DOM. AppShell focuses the h1 and announces the title
 * when the title changes; during a client navigation the URL changes first and the page streams in after the
 * loading skeleton, so changing the title straight away would focus the old page's h1, or none.
 */
export function useSettledTitle(title: string, fallbackMs = 1500): string {
  const [settled, setSettled] = useState(title);
  const lastH1 = useRef<{ node: Element | null; text: string | null }>({ node: null, text: null });

  useEffect(() => {
    const h1 = document.querySelector('main h1');
    lastH1.current = { node: h1, text: h1?.textContent ?? null };
  }, []);

  useEffect(() => {
    if (title === settled) return;
    const main = document.querySelector('main');
    const ready = () => {
      const h1 = main?.querySelector('h1');
      if (!h1 || (h1 === lastH1.current.node && h1.textContent === lastH1.current.text))
        return false;
      lastH1.current = { node: h1, text: h1.textContent };
      setSettled(title);
      return true;
    };
    if (ready()) return;
    const observer = new MutationObserver(() => {
      if (ready()) observer.disconnect();
    });
    if (main) observer.observe(main, { childList: true, subtree: true, characterData: true });
    // The same h1 text on both pages (one client to another) never mutates; apply the title anyway.
    const timer = setTimeout(() => {
      observer.disconnect();
      lastH1.current = {
        node: main?.querySelector('h1') ?? null,
        text: main?.querySelector('h1')?.textContent ?? null,
      };
      setSettled(title);
    }, fallbackMs);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [title, settled, fallbackMs]);

  return settled;
}

/**
 * The server's layout guess until hydration, then AppShell's `auto` (matchMedia). The browser's real layout is saved
 * in a cookie so the next server render matches it exactly.
 */
function useHydratedLayout(initial: ShellLayout): AppShellLayout {
  const [hydrated, setHydrated] = useState(false);
  const lg = useMediaQuery('(min-width: 1100px)', initial === 'sidebar');
  const sm = useMediaQuery('(min-width: 640px)', initial !== 'sheet');
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    if (!hydrated) return;
    const actual = layoutForWidth(lg ? 1100 : sm ? 640 : 0);
    document.cookie = `${LAYOUT_COOKIE}=${actual}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, [hydrated, lg, sm]);
  return hydrated ? 'auto' : initial;
}

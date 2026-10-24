'use client';
// The console's frame: the design system's AppShell with the operator's four areas, and sign-out in the user menu.
import { AppShell, Toaster, type LinkRenderer, type NavGroup } from '@canopy/ui';
import { Building2, CalendarClock, History, Layers, LogOut, Plus } from 'lucide-react';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

import { CONSOLE_NAME, formatInstant } from '../format';
import { SessionProvider, useSession } from '../session';
import { Loading, LoadError } from './parts';

export const NAV: NavGroup[] = [
  {
    items: [
      { label: 'Accounts', href: '/accounts', icon: Building2 },
      { label: 'Renewals', href: '/renewals', icon: CalendarClock },
      { label: 'Plans', href: '/plans', icon: Layers },
      { label: 'Operator audit', href: '/audit', icon: History },
    ],
  },
];

/** The document title for a console path; the shell sets it and announces the page. */
export function pageTitle(pathname: string): string {
  const name =
    pathname === '/accounts/new'
      ? 'New account'
      : pathname.startsWith('/accounts/')
        ? 'Account'
        : (NAV[0]!.items.find((i) => pathname.startsWith(i.href))?.label ?? 'Accounts');
  return `${name} · ${CONSOLE_NAME}`;
}

const renderLink: LinkRenderer = ({ href, children, ...rest }) => (
  <NextLink href={href} prefetch={false} {...rest}>
    {children}
  </NextLink>
);

function Frame({ children }: { children: ReactNode }) {
  const { me, signOut } = useSession();
  const pathname = usePathname() ?? '/accounts';
  const router = useRouter();
  return (
    <AppShell
      nav={NAV}
      activeHref={pathname}
      brand={{ name: CONSOLE_NAME, href: '/accounts' }}
      title={pageTitle(pathname)}
      renderLink={renderLink}
      topBar={{
        primaryAction: {
          label: 'New account',
          icon: Plus,
          onClick: () => router.push('/accounts/new'),
        },
        user: {
          name: me.operator.displayName,
          detail: `Session ends ${formatInstant(me.session.expiresAt)}`,
          items: [
            { label: 'Sign out', icon: LogOut, onSelect: () => void signOut(), destructive: true },
          ],
        },
      }}
    >
      {children}
    </AppShell>
  );
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/accounts';
  const router = useRouter();
  return (
    <SessionProvider path={pathname} navigate={(href) => router.replace(href)}>
      {(state) =>
        state.state === 'ready' ? (
          <>
            <Frame>{children}</Frame>
            <Toaster />
          </>
        ) : (
          <main className="mx-auto max-w-3xl p-4 sm:p-8">
            {state.state === 'loading' ? (
              <Loading label="Checking your session" />
            ) : (
              <LoadError message={state.message} />
            )}
          </main>
        )
      }
    </SessionProvider>
  );
}

import { Leaf, Menu as MenuIcon, Search, X, type LucideIcon } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cx } from '../lib/cx';
import { defaultLink, type LinkRenderer } from '../lib/link';
import { useMediaQuery } from '../lib/useMediaQuery';
import { Avatar } from '../primitives/Avatar';
import { Badge } from '../primitives/Badge';
import { Button, IconButton } from '../primitives/Button';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from '../primitives/Menu';
import { Tooltip, TooltipProvider } from '../primitives/Tooltip';

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Count badge; `label` is the accessible text with its noun, e.g. "4 waiting". Hidden when count is 0. */
  badge?: { count: number; label: string };
};

export type NavGroup = { label?: string; items: NavItem[] };

export type UserMenuItem = {
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  href?: string;
  destructive?: boolean;
};

export type UserMenuProps = {
  name: string;
  detail?: string;
  avatarUrl?: string;
  items: UserMenuItem[];
};

export type PrimaryAction = {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
};

export type { LinkRenderer };

export type AppShellLayout = 'auto' | 'sidebar' | 'rail' | 'sheet';

export type AppShellProps = {
  nav: NavGroup[];
  /**
   * Href of the current page. The matching nav item gets aria-current="page": an exact match, else the longest
   * item href that prefixes it at a path boundary (a record page keeps its list's item current).
   */
  activeHref: string;
  /** Product name next to the logo mark. Client-facing, so it defaults to "PlanetPulse Compliance". */
  brand?: { name: string; href?: string };
  topBar: {
    clientSwitcher?: ReactNode;
    periodPicker?: ReactNode;
    /** A search field. It is focused by the `/` key and collapses to a button under 640px. */
    search?: ReactNode;
    /** The page's main action. Collapses to an icon button with a tooltip under 1100px. */
    primaryAction?: PrimaryAction;
    user: UserMenuProps;
  };
  helpCard?: { title: string; body: string; href?: string; linkLabel?: string };
  /**
   * Full document title ("Register · Kestrel Aluminium Riverbend · PlanetPulse Compliance"). When it changes, the shell sets document.title,
   * moves focus to the page h1 and announces it.
   */
  title?: string;
  /** `auto` follows the viewport (sidebar ≥1100px, rail 640-1099px, sheet <640px). Fixed values are for demos. */
  layout?: AppShellLayout;
  /** Renders links (pass Next's Link here). Defaults to a plain anchor. */
  renderLink?: LinkRenderer;
  children: ReactNode;
};

function useLayout(layout: AppShellLayout): Exclude<AppShellLayout, 'auto'> {
  const lg = useMediaQuery('(min-width: 1100px)', true);
  const sm = useMediaQuery('(min-width: 640px)', true);
  if (layout !== 'auto') return layout;
  return lg ? 'sidebar' : sm ? 'rail' : 'sheet';
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * Spec 01 · AppShell. Forest sidebar (rail under 1100px, bottom sheet under 640px), top bar and main region.
 * Landmarks: one nav[aria-label=Main], one header, one main. Skip link first.
 */
export function AppShell({
  nav,
  activeHref,
  brand = { name: 'PlanetPulse Compliance' },
  topBar,
  helpCard,
  title,
  layout = 'auto',
  renderLink = defaultLink,
  children,
}: AppShellProps) {
  const mode = useLayout(layout);
  const mainRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  // The last title applied. Compared, not flagged, so StrictMode's double effect on mount doesn't count as a route change.
  const lastTitle = useRef<string | undefined>(undefined);

  // Title change = route change: update document.title, focus the page h1 and announce it.
  useEffect(() => {
    if (!title) return;
    document.title = title;
    const previous = lastTitle.current;
    lastTitle.current = title;
    if (previous === undefined || previous === title) return;
    const h1 = mainRef.current?.querySelector('h1');
    if (h1) {
      if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
      h1.focus();
    }
    setAnnouncement(h1?.textContent || title);
  }, [title]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // "/" focuses search unless the user is typing in a field.
  useEffect(() => {
    if (!topBar.search) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      if (mode === 'sheet') setSearchOpen(true);
      requestAnimationFrame(() => focusSearch(searchRef.current));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [topBar.search, mode]);

  const navContent = (variant: 'sidebar' | 'rail' | 'sheet') => (
    <NavList
      nav={nav}
      activeHref={activeHref}
      variant={variant}
      renderLink={renderLink}
      onNavigate={() => setSheetOpen(false)}
    />
  );

  const logo = (compact: boolean) => {
    const content = (
      <>
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-chip bg-on-forest-selected">
          <Leaf aria-hidden size={18} strokeWidth={1.75} className="text-moss" />
        </span>
        <span
          className={compact ? 'sr-only' : 'text-[15px] font-extrabold leading-5 text-on-forest'}
        >
          {brand.name}
        </span>
      </>
    );
    const classes = cx(
      'flex h-control items-center gap-2 rounded-chip px-1.5',
      compact && 'justify-center',
    );
    return brand.href ? (
      renderLink({ href: brand.href, className: classes, children: content })
    ) : (
      <div className={classes}>{content}</div>
    );
  };

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-mist text-ink" data-layout={mode}>
        <a
          href="#main"
          onClick={(e) => {
            e.preventDefault();
            mainRef.current?.focus();
          }}
          className="sr-only z-dialog rounded-control bg-surface px-3 py-2 text-body font-bold text-forest shadow-overlay focus:not-sr-only focus:fixed focus:left-2 focus:top-2"
        >
          Skip to content
        </a>

        {mode !== 'sheet' ? (
          <nav
            aria-label="Main"
            data-surface="forest"
            className={cx(
              'fixed inset-y-0 left-0 z-shell flex flex-col gap-1 overflow-y-auto bg-forest py-3.5',
              mode === 'sidebar' ? 'w-sidebar px-3' : 'w-rail items-center px-2',
            )}
          >
            <div className="mb-3">{logo(mode === 'rail')}</div>
            {navContent(mode)}
            {helpCard && mode === 'sidebar' ? (
              <HelpCard {...helpCard} renderLink={renderLink} />
            ) : null}
          </nav>
        ) : null}

        <div className={cx(mode === 'sidebar' && 'pl-sidebar', mode === 'rail' && 'pl-rail')}>
          <header
            className={cx(
              'sticky top-0 z-shell flex h-topbar items-center gap-2 border-b bg-mist px-4 sm:gap-3 sm:px-5.5',
              scrolled ? 'border-line' : 'border-transparent',
            )}
          >
            {mode === 'sheet' ? (
              <Dialog.Root open={sheetOpen} onOpenChange={setSheetOpen}>
                <Dialog.Trigger asChild>
                  <IconButton label="Open menu" icon={MenuIcon} hideTooltip />
                </Dialog.Trigger>
                <Dialog.Portal>
                  <Dialog.Overlay className="fixed inset-0 z-dialog bg-scrim" />
                  <Dialog.Content
                    data-surface="forest"
                    aria-describedby={undefined}
                    className="fixed inset-x-0 bottom-0 z-dialog flex max-h-[85vh] flex-col gap-1 overflow-y-auto rounded-t-card bg-forest px-3 pb-5.5 pt-2 shadow-overlay"
                  >
                    <span
                      aria-hidden
                      className="mx-auto mb-2 h-1 w-10 rounded-pill bg-on-forest-selected"
                    />
                    <div className="mb-2 flex items-center justify-between">
                      <Dialog.Title className="text-section text-on-forest">Menu</Dialog.Title>
                      <Dialog.Close asChild>
                        <IconButton
                          label="Close menu"
                          icon={X}
                          hideTooltip
                          className="text-on-forest hover:bg-on-forest-hover"
                        />
                      </Dialog.Close>
                    </div>
                    <nav aria-label="Main">{navContent('sheet')}</nav>
                    {helpCard ? <HelpCard {...helpCard} renderLink={renderLink} /> : null}
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
            ) : null}

            {topBar.clientSwitcher ? (
              <div className="min-w-0 shrink">{topBar.clientSwitcher}</div>
            ) : null}
            {topBar.periodPicker && mode !== 'sheet' ? (
              <div className="shrink-0">{topBar.periodPicker}</div>
            ) : null}

            {topBar.search && mode !== 'sheet' ? (
              <div ref={searchRef} className="ml-1 w-full max-w-80 min-w-0">
                {topBar.search}
              </div>
            ) : null}

            <div className="ml-auto flex shrink-0 items-center gap-2">
              {topBar.search && mode === 'sheet' ? (
                <IconButton
                  label={searchOpen ? 'Close search' : 'Search'}
                  icon={searchOpen ? X : Search}
                  aria-expanded={searchOpen}
                  onClick={() => setSearchOpen((o) => !o)}
                />
              ) : null}
              {topBar.primaryAction ? (
                <PrimaryActionButton
                  action={topBar.primaryAction}
                  compact={mode !== 'sidebar'}
                  renderLink={renderLink}
                />
              ) : null}
              <UserMenu {...topBar.user} renderLink={renderLink} />
            </div>
          </header>

          {/* Under 640px the period picker gets its own row so the top bar keeps 44px touch targets. */}
          {topBar.periodPicker && mode === 'sheet' ? (
            <div className="flex items-center bg-mist px-4 pb-2">{topBar.periodPicker}</div>
          ) : null}

          {topBar.search && mode === 'sheet' && searchOpen ? (
            <div ref={searchRef} className="border-b border-line bg-mist px-4 pb-3">
              {topBar.search}
            </div>
          ) : null}

          <main
            id="main"
            ref={mainRef}
            tabIndex={-1}
            className="px-4 py-4 outline-none sm:px-5.5 sm:py-[18px]"
          >
            {children}
          </main>
        </div>

        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>
      </div>
    </TooltipProvider>
  );
}

function focusSearch(container: HTMLElement | null) {
  const field = container?.querySelector<HTMLElement>(
    'input, [role="searchbox"], [role="combobox"], textarea',
  );
  field?.focus();
}

/**
 * The nav item for the current page: an exact match, else the longest item href that prefixes it at a path
 * boundary, so /c/x/register/123 keeps Register current.
 */
export function currentHref(nav: NavGroup[], activeHref: string): string | undefined {
  const hrefs = nav.flatMap((g) => g.items.map((i) => i.href));
  if (hrefs.includes(activeHref)) return activeHref;
  return hrefs
    .filter(
      (h) => activeHref.startsWith(h) && ['/', '?', '#'].includes(activeHref.charAt(h.length)),
    )
    .sort((a, b) => b.length - a.length)[0];
}

type NavListProps = {
  nav: NavGroup[];
  activeHref: string;
  variant: 'sidebar' | 'rail' | 'sheet';
  renderLink: LinkRenderer;
  onNavigate: () => void;
};

function NavList({ nav, activeHref, variant, renderLink, onNavigate }: NavListProps) {
  const rail = variant === 'rail';
  const current = currentHref(nav, activeHref);
  return (
    <div className={cx('flex flex-col gap-1', rail && 'items-center')}>
      {nav.map((group, gi) => (
        <div
          key={group.label ?? gi}
          className={cx('flex flex-col gap-0.5', rail && 'items-center')}
        >
          {group.label ? (
            rail ? (
              <span
                role="separator"
                aria-label={group.label}
                className="my-2 h-px w-8 bg-on-forest-selected"
              />
            ) : (
              <span className="mt-3.5 px-2.5 pb-1 text-label uppercase text-on-forest-muted">
                {group.label}
              </span>
            )
          ) : null}
          <ul className={cx('flex flex-col gap-0.5', rail && 'items-center')}>
            {group.items.map((item) => (
              <li key={item.href}>
                <NavLink
                  item={item}
                  active={item.href === current}
                  rail={rail}
                  renderLink={renderLink}
                  onNavigate={onNavigate}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function NavLink({
  item,
  active,
  rail,
  renderLink,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  rail: boolean;
  renderLink: LinkRenderer;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  const badge = item.badge && item.badge.count > 0 ? item.badge : undefined;
  const classes = cx(
    'relative flex h-control items-center gap-2.5 rounded-chip text-body transition-colors duration-fast ease-out touch-target',
    rail ? 'w-control justify-center' : 'px-2.5',
    active
      ? 'bg-on-forest-selected font-bold text-on-forest'
      : 'font-medium text-on-forest-muted hover:bg-on-forest-hover hover:text-on-forest',
  );

  const link = renderLink({
    href: item.href,
    className: classes,
    onClick: onNavigate,
    ...(active ? { 'aria-current': 'page' as const } : {}),
    ...(rail ? { 'aria-label': badge ? `${item.label}, ${badge.label}` : item.label } : {}),
    children: (
      <>
        <Icon aria-hidden size={18} strokeWidth={1.75} className="shrink-0" />
        {rail ? (
          badge ? (
            <span
              aria-hidden
              className="absolute right-1.5 top-1.5 size-2 rounded-pill bg-on-forest"
            />
          ) : null
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {badge ? <Badge count={badge.count} label={badge.label} on="forest" /> : null}
          </>
        )}
      </>
    ),
  });

  return rail ? (
    <Tooltip content={item.label} side="right" delay={200}>
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function HelpCard({
  title,
  body,
  href,
  linkLabel = 'Get help',
  renderLink,
}: NonNullable<AppShellProps['helpCard']> & { renderLink: LinkRenderer }) {
  return (
    <div className="mt-auto rounded-[10px] bg-on-forest-hover p-3 pt-2.5 text-meta text-on-forest">
      <p className="mb-0.5 font-bold text-on-forest">{title}</p>
      <p>{body}</p>
      {href
        ? renderLink({
            href,
            className: 'mt-1.5 inline-block font-bold text-on-forest underline underline-offset-2',
            children: linkLabel,
          })
        : null}
    </div>
  );
}

function PrimaryActionButton({
  action,
  compact,
  renderLink,
}: {
  action: PrimaryAction;
  compact: boolean;
  renderLink: LinkRenderer;
}) {
  if (compact) {
    const button = (
      <IconButton
        label={action.label}
        icon={action.icon}
        variant="primary"
        onClick={action.onClick}
      />
    );
    if (!action.href) return button;
    return (
      <Tooltip content={action.label}>
        {renderLink({
          href: action.href,
          'aria-label': action.label,
          className:
            'inline-flex size-control items-center justify-center rounded-control bg-forest text-on-forest hover:bg-forest-hover touch-target',
          children: <action.icon aria-hidden size={18} strokeWidth={1.75} />,
        })}
      </Tooltip>
    );
  }
  if (action.href) {
    return (
      <Button variant="primary" icon={action.icon} asChild>
        {renderLink({ href: action.href, children: action.label })}
      </Button>
    );
  }
  return (
    <Button variant="primary" icon={action.icon} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

function UserMenu({
  name,
  detail,
  avatarUrl,
  items,
  renderLink,
}: UserMenuProps & { renderLink: LinkRenderer }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu, ${name}`}
          className="inline-flex size-control shrink-0 cursor-pointer items-center justify-center rounded-pill touch-target"
        >
          <Avatar name={name} src={avatarUrl} size={32} decorative />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel className="normal-case tracking-normal">
          <span className="block text-body-strong text-ink">{name}</span>
          {detail ? <span className="block text-meta text-muted">{detail}</span> : null}
        </MenuLabel>
        <MenuSeparator />
        {items.map((item) =>
          item.href ? (
            <MenuItem key={item.label} icon={item.icon} destructive={item.destructive} asChild>
              {renderLink({ href: item.href, children: item.label })}
            </MenuItem>
          ) : (
            <MenuItem
              key={item.label}
              icon={item.icon}
              destructive={item.destructive}
              onSelect={item.onSelect}
            >
              {item.label}
            </MenuItem>
          ),
        )}
      </MenuContent>
    </Menu>
  );
}

import { ChevronsUpDown, Search, X } from 'lucide-react';
import { Dialog, Popover as RadixPopover } from 'radix-ui';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cx } from '../lib/cx';
import { formatNumber } from '../lib/format';
import { defaultLink, type LinkRenderer } from '../lib/link';
import { useMediaQuery } from '../lib/useMediaQuery';
import { Avatar } from '../primitives/Avatar';
import { IconButton } from '../primitives/Button';
import { overlayClasses } from '../primitives/Menu';
import { Skeleton } from '../primitives/Skeleton';

export type ClientSummary = {
  id: string;
  name: string;
  /** Industry · unit count, e.g. "Metals · 3 units". */
  meta: string;
  /** Overdue instances, from the API. */
  overdueCount: number;
};

export type ClientSwitcherProps = {
  /** The client in the URL; undefined shows "Choose a client". */
  current?: ClientSummary;
  clients: ClientSummary[];
  /** Most recent first; the popover shows up to three. */
  recentIds?: string[];
  /** Built by the web app from the current path, so switching keeps the page. */
  hrefFor: (clientId: string) => string;
  /** Called with the chosen client's href. Defaults to a full page navigation; the web app passes router.push. */
  onNavigate?: (href: string) => void;
  /** Footer link to the portfolio. */
  overviewHref?: string;
  renderLink?: LinkRenderer;
  loading?: boolean;
  /** Ctrl/Cmd+K opens this switcher. Turn it off when a page shows more than one. */
  shortcut?: boolean;
  className?: string;
};

type Row = { client: ClientSummary; group: 'recent' | 'all' };

const browserNavigate = (href: string) => window.location.assign(href);

/** Spec 02 · ClientSwitcher. Top-bar trigger and a searchable client list; a full-height sheet under 640px. */
export function ClientSwitcher({
  current,
  clients,
  recentIds = [],
  hrefFor,
  onNavigate = browserNavigate,
  overviewHref = '/portfolio',
  renderLink = defaultLink,
  loading = false,
  shortcut = true,
  className,
}: ClientSwitcherProps) {
  const sm = useMediaQuery('(min-width: 640px)', true);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Ctrl/Cmd+K opens the switcher from anywhere.
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcut]);

  if (current && clients.length === 1 && !loading) {
    return (
      <div className={cx('flex h-10 min-w-0 items-center gap-2', className)}>
        <Avatar name={current.name} size={32} decorative />
        <TriggerText client={current} compact={!sm} />
      </div>
    );
  }

  const choose = (client: ClientSummary) => {
    setOpen(false);
    onNavigate(hrefFor(client.id));
  };

  const label = current ? `Client: ${current.name}, change client` : 'Choose a client';
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={current?.name}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setOpen(true);
        }
      }}
      className={cx(
        'flex h-10 min-w-0 max-w-full items-center gap-2 rounded-[10px] border border-line bg-surface px-3 text-left',
        'transition-colors duration-fast ease-out hover:border-line-strong',
        'aria-expanded:border-forest aria-expanded:hover:border-forest',
        current ? 'pl-1.5' : '',
        className,
      )}
    >
      {current ? <Avatar name={current.name} size={32} decorative /> : null}
      {current ? (
        <TriggerText client={current} compact={!sm} />
      ) : (
        <span className="truncate text-body-strong text-ink">Choose a client</span>
      )}
      <ChevronsUpDown aria-hidden size={16} className="shrink-0 text-muted" />
    </button>
  );

  const panel = (
    <ClientPanel
      current={current}
      clients={clients}
      recentIds={recentIds}
      loading={loading}
      overviewHref={overviewHref}
      renderLink={renderLink}
      onChoose={choose}
      onFollowLink={() => setOpen(false)}
    />
  );

  if (!sm) {
    return (
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-dialog bg-scrim" />
          <Dialog.Content
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement)
                .querySelector<HTMLElement>('[role="combobox"]')
                ?.focus();
            }}
            className="fixed inset-0 z-dialog flex flex-col bg-surface"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <Dialog.Title className="text-section text-ink">Change client</Dialog.Title>
              <Dialog.Close asChild>
                <IconButton label="Close" icon={X} variant="ghost" hideTooltip />
              </Dialog.Close>
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-3">{panel}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          aria-label="Change client"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={cx(overlayClasses, 'flex max-h-[420px] w-[360px] flex-col p-2')}
        >
          {panel}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

function TriggerText({ client, compact }: { client: ClientSummary; compact: boolean }) {
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="max-w-[220px] truncate text-body-strong text-ink" title={client.name}>
        {client.name}
      </span>
      {compact ? null : <span className="truncate text-meta text-muted">{client.meta}</span>}
    </span>
  );
}

type PanelProps = {
  current?: ClientSummary;
  clients: ClientSummary[];
  recentIds: string[];
  loading: boolean;
  overviewHref: string;
  renderLink: LinkRenderer;
  onChoose: (client: ClientSummary) => void;
  onFollowLink: () => void;
};

function ClientPanel({
  current,
  clients,
  recentIds,
  loading,
  overviewHref,
  renderLink,
  onChoose,
  onFollowLink,
}: PanelProps) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const rows = useMemo<Row[]>(() => {
    const sorted = [...clients].sort((a, b) => a.name.localeCompare(b.name));
    const q = query.trim().toLowerCase();
    if (q) {
      return sorted
        .filter((c) => c.name.toLowerCase().includes(q) || c.meta.toLowerCase().includes(q))
        .map((client) => ({ client, group: 'all' }));
    }
    const byId = new Map(clients.map((c) => [c.id, c]));
    const recent = recentIds
      .map((id) => byId.get(id))
      .filter((c): c is ClientSummary => !!c)
      .slice(0, 3)
      .map((client): Row => ({ client, group: 'recent' }));
    return [...recent, ...sorted.map((client): Row => ({ client, group: 'all' }))];
  }, [clients, recentIds, query]);

  const optionId = (i: number) => `${listId}-opt-${i}`;
  const last = rows.length - 1;

  // Focus stays in the search field, so keep the highlighted option in view as it moves (WCAG 2.4.11).
  useEffect(() => {
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, rows, listId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(i + 1, last));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(last);
        break;
      case 'Enter': {
        const row = rows[active];
        if (row) {
          e.preventDefault();
          onChoose(row.client);
        }
        break;
      }
    }
  };

  const renderGroup = (group: Row['group'], heading: string): ReactNode => {
    const entries = rows.map((row, i) => ({ row, i })).filter(({ row }) => row.group === group);
    if (entries.length === 0) return null;
    const headingId = `${listId}-${group}`;
    return (
      <div role="group" aria-labelledby={headingId} className="flex flex-col">
        <div id={headingId} role="presentation" className="px-2 pb-1 pt-2 text-label text-muted">
          {heading}
        </div>
        {entries.map(({ row, i }) => (
          <ClientOption
            key={`${group}-${row.client.id}`}
            id={optionId(i)}
            client={row.client}
            active={i === active}
            selected={row.client.id === current?.id}
            onHover={() => setActive(i)}
            onChoose={() => onChoose(row.client)}
          />
        ))}
      </div>
    );
  };

  const activeRow = loading ? undefined : rows[active];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="relative">
        <Search
          aria-hidden
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          // Radix moves focus to the first focusable element, which is this field.
          aria-label="Find a client"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeRow ? optionId(active) : undefined}
          autoComplete="off"
          placeholder="Find a client"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-control w-full rounded-control border border-line-strong bg-surface pl-9 pr-3 text-body text-ink placeholder:text-muted touch-target"
        />
      </div>

      <div
        id={listId}
        role="listbox"
        aria-label="Clients"
        aria-busy={loading || undefined}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {loading ? (
          <div role="presentation" className="flex flex-col gap-2 p-2">
            <span className="sr-only">Loading clients</span>
            {[0, 1, 2, 3].map((n) => (
              <div key={n} className="flex items-center gap-2">
                <Skeleton className="size-8 rounded-pill" />
                <div className="flex flex-1 flex-col gap-1">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p role="presentation" className="px-2 py-3 text-body text-muted">
            No client matches “{query.trim()}”.
          </p>
        ) : (
          <>
            {renderGroup('recent', 'Recent')}
            {renderGroup('all', 'All clients')}
          </>
        )}
      </div>

      <div className="border-t border-line px-2 pt-2">
        {renderLink({
          href: overviewHref,
          onClick: onFollowLink,
          className:
            'inline-flex min-h-control items-center text-body-strong text-forest underline-offset-2 hover:underline touch-target',
          children: 'All clients overview',
        })}
      </div>
    </div>
  );
}

type OptionProps = {
  id: string;
  client: ClientSummary;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onChoose: () => void;
};

function ClientOption({ id, client, active, selected, onHover, onChoose }: OptionProps) {
  const overdue = client.overdueCount;
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={`${client.name}, ${client.meta}${overdue > 0 ? `, ${formatNumber(overdue)} overdue` : ''}`}
      // Keep focus in the search field; a click chooses without blurring it first.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onChoose}
      className={cx(
        'flex min-h-11 cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5',
        active && 'bg-mist',
        selected && 'shadow-[inset_2px_0_0_var(--forest)]',
      )}
    >
      <Avatar name={client.name} size={32} decorative />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-body-strong text-ink">{client.name}</span>
        <span className="truncate text-meta text-muted">{client.meta}</span>
      </span>
      {overdue > 0 ? (
        <span aria-hidden className="shrink-0 text-meta text-crit-ink tabular">
          {formatNumber(overdue)} overdue
        </span>
      ) : null}
    </div>
  );
}

import { CheckCircle2, Inbox, Keyboard } from 'lucide-react';
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

import { cx } from '../lib/cx';
import { formatDate, formatNumber } from '../lib/format';
import { defaultLink, type LinkRenderer } from '../lib/link';
import { Button, IconButton } from '../primitives/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../primitives/Popover';
import { Skeleton } from '../primitives/Skeleton';
import { EmptyState } from './EmptyState';
import { statusLabel, type DerivedStatus } from './StatusPill';

export type TaskItem = {
  id: string;
  title: string;
  /** Act short name, from the API. */
  meta: string;
  dueDate: string;
  status: DerivedStatus;
  days?: number;
  href: string;
};

export type TaskListProps = {
  items: TaskItem[];
  /** `approver` adds Approve and Send back on each row and the A/S shortcuts. */
  mode?: 'owner' | 'approver';
  /** Approve without a confirm; the app shows a Toast with Undo. */
  onApprove?: (id: string) => void;
  /** The app opens a ConfirmDialog with a required reason. */
  onSendBack?: (id: string) => void;
  /** Rows with a request in flight: dimmed, buttons disabled. */
  processingIds?: string[];
  max?: number;
  viewAllHref?: string;
  loading?: boolean;
  /** Accessible name of the list, e.g. "My open items". */
  label: string;
  renderLink?: LinkRenderer;
  className?: string;
};

type Marker = 'todo' | 'waiting' | 'attention' | 'done';

function marker(status: DerivedStatus): Marker {
  if (status === 'SUBMITTED') return 'waiting';
  if (status === 'SENT_BACK' || status === 'OVERDUE') return 'attention';
  if (status === 'COMPLIED' || status === 'COMPLIED_LATE' || status === 'NOT_APPLICABLE')
    return 'done';
  return 'todo';
}

/** 16px state marker: an indicator, never a checkbox (completing needs evidence and approval). */
function StateMarker({ kind }: { kind: Marker }) {
  return (
    <span
      aria-hidden
      data-marker={kind}
      className={cx(
        'mt-0.5 inline-block size-4 shrink-0 rounded-pill border-[1.5px]',
        kind === 'todo' && 'border-line-strong',
        kind === 'waiting' &&
          'border-warn bg-[linear-gradient(90deg,var(--warn)_50%,transparent_50%)]',
        kind === 'attention' && 'border-2 border-crit',
        kind === 'done' && 'border-ok bg-ok',
      )}
    />
  );
}

function toneWord(
  item: TaskItem,
  mode: 'owner' | 'approver',
): { text: string; className: string } | null {
  if (item.status === 'OVERDUE') return { text: 'overdue', className: 'text-crit-ink' };
  if (item.status === 'SENT_BACK') return { text: 'sent back', className: 'text-crit-ink' };
  if (item.status === 'SUBMITTED')
    return {
      text: mode === 'approver' ? 'awaiting your approval' : 'awaiting approval',
      className: 'text-warn-ink',
    };
  return null;
}

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/**
 * Spec 13 · TaskList (UI copy says "items", never "tasks"). The person's open instances, or the approvals inbox.
 * Approver mode: J/K move, Enter opens, A approves, S sends back.
 */
export function TaskList({
  items,
  mode = 'owner',
  onApprove,
  onSendBack,
  processingIds = [],
  max,
  viewAllHref,
  loading = false,
  label,
  renderLink = defaultLink,
  className,
}: TaskListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const focusedId = useRef<string | null>(null);
  const focusedIndex = useRef(0);
  const shown = max ? items.slice(0, max) : items;
  const approver = mode === 'approver';

  // When the focused row goes away (approved, sent back), move focus to the row that took its place.
  useEffect(() => {
    const id = focusedId.current;
    if (!id || shown.some((i) => i.id === id)) return;
    const links = rowLinks();
    const next = links[Math.min(focusedIndex.current, links.length - 1)];
    if (next) next.focus();
    focusedId.current = null;
  });

  const rowLinks = () => [
    ...(listRef.current?.querySelectorAll<HTMLElement>('[data-task-link]') ?? []),
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-task-id]');
    if (!row) return;
    const id = row.dataset.taskId!;
    const links = rowLinks();
    const index = links.findIndex((l) => row.contains(l));
    const key = e.key.toLowerCase();
    if (approver && e.key === '?') {
      e.preventDefault();
      setHelpOpen(true);
    } else if (key === 'j' || key === 'k') {
      e.preventDefault();
      links[index + (key === 'j' ? 1 : -1)]?.focus();
    } else if (approver && key === 'a' && onApprove && !processingIds.includes(id)) {
      e.preventDefault();
      onApprove(id);
    } else if (approver && key === 's' && onSendBack && !processingIds.includes(id)) {
      e.preventDefault();
      onSendBack(id);
    }
  };

  if (loading) {
    return (
      <div aria-busy="true" className={cx('flex flex-col', className)}>
        <span className="sr-only">Loading {label.toLowerCase()}</span>
        {[0, 1, 2, 3].map((n) => (
          <div
            key={n}
            className={cx('flex min-h-14 items-center gap-3 py-2', n > 0 && 'border-t border-line')}
          >
            <Skeleton className="size-4 rounded-pill" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return approver ? (
      <EmptyState
        variant="done"
        icon={Inbox}
        title="Nothing waiting for your approval."
        className={className}
      />
    ) : (
      <EmptyState
        variant="done"
        icon={CheckCircle2}
        title="You're all caught up."
        className={className}
      />
    );
  }

  return (
    <div className={cx('flex flex-col', className)}>
      <ul
        ref={listRef}
        aria-label={label}
        onKeyDown={onKeyDown}
        onBlur={(e: FocusEvent<HTMLUListElement>) => {
          // Focus left the list: stop following the row.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusedId.current = null;
        }}
        className="flex flex-col"
      >
        {shown.map((item, i) => {
          const processing = processingIds.includes(item.id);
          const tone = toneWord(item, mode);
          const name = [
            item.title,
            `due ${formatDate(item.dueDate)}`,
            statusLabel(item.status, item.days).full,
          ].join(', ');
          return (
            <li
              key={item.id}
              data-task-id={item.id}
              aria-busy={processing || undefined}
              onFocus={() => {
                focusedId.current = item.id;
                focusedIndex.current = i;
              }}
              className={cx(
                'group/task flex min-h-14 items-start gap-3 py-2 transition-opacity duration-base',
                i > 0 && 'border-t border-line',
                processing && 'opacity-60',
              )}
            >
              <StateMarker kind={marker(item.status)} />
              {renderLink({
                href: item.href,
                'aria-label': name,
                // Data attribute for J/K; spreads onto Next's Link too.
                ...({ 'data-task-link': '' } as object),
                className: 'flex min-w-0 flex-1 flex-col rounded-tag hover:underline',
                children: (
                  <>
                    <span className="line-clamp-2 text-body-strong text-ink">{item.title}</span>
                    <span className="text-meta text-muted">
                      {item.meta} · due {formatDate(item.dueDate).replace(/ \d{4}$/, '')}
                      {tone ? (
                        <>
                          {' · '}
                          <span className={tone.className}>{tone.text}</span>
                        </>
                      ) : null}
                    </span>
                  </>
                ),
              })}
              {approver ? (
                <span
                  className={cx(
                    'flex shrink-0 gap-1.5 opacity-0 transition-opacity duration-fast',
                    'group-hover/task:opacity-100 group-focus-within/task:opacity-100 pointer-coarse:opacity-100',
                  )}
                >
                  <Button
                    size="sm"
                    disabled={processing}
                    onClick={() => onSendBack?.(item.id)}
                    aria-label={`Send back ${item.title}`}
                  >
                    Send back
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={processing}
                    loading={processing}
                    onClick={() => onApprove?.(item.id)}
                    aria-label={`Approve ${item.title}`}
                  >
                    Approve
                  </Button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-2 pt-2">
        {viewAllHref && max && items.length > max ? (
          renderLink({
            href: viewAllHref,
            className:
              'inline-flex min-h-6 items-center text-meta font-bold text-forest hover:underline touch-target',
            children: `View all ${formatNumber(items.length)}`,
          })
        ) : (
          <span />
        )}
        {approver ? <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} /> : null}
      </div>
    </div>
  );
}

function ShortcutsHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <IconButton label="Keyboard shortcuts" icon={Keyboard} variant="ghost" size="sm" />
      </PopoverTrigger>
      <PopoverContent aria-label="Keyboard shortcuts" align="end" className="w-64 p-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-body">
          {[
            ['J / K', 'Next / previous item'],
            ['Enter', 'Open the item'],
            ['A', 'Approve'],
            ['S', 'Send back'],
            ['?', 'Show these shortcuts'],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt>
                <kbd className="rounded-tag border border-line bg-mist px-1.5 text-meta text-ink">
                  {k}
                </kbd>
              </dt>
              <dd className="text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

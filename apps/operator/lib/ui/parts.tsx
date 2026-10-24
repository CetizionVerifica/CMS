// Small building blocks the console's screens share. Tokens only (packages/ui/CLAUDE.md).
import type { AccountStatus } from '@canopy/contracts';
import { cx, EmptyState, Skeleton } from '@canopy/ui';
import type { ReactNode } from 'react';

import { STATUS, toneClasses, type Tone } from '../format';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-page text-ink">{title}</h1>
        {description ? <p className="mt-1 text-body text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex h-[22px] shrink-0 items-center whitespace-nowrap rounded-pill px-[9px] text-meta font-bold',
        toneClasses[tone],
      )}
    >
      {children}
    </span>
  );
}

export function AccountStatusPill({ status }: { status: AccountStatus }) {
  const { label, tone } = STATUS[status];
  return <Pill tone={tone}>{label}</Pill>;
}

export function Card({
  title,
  actions,
  children,
  id,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      aria-labelledby={headingId}
      className="mb-4 rounded-card border border-line bg-surface p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-section text-ink">
          {title}
        </h2>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Label and value pairs, two columns from 640px. */
export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-meta text-muted">{item.label}</dt>
          <dd className="text-body text-ink tabular break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        {label}
      </span>
      <div aria-hidden>
        <Skeleton className="mb-4 h-7 w-56" />
        <Skeleton className="h-72 rounded-card" />
      </div>
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <EmptyState
      variant="error"
      title="This page did not load"
      body={message}
      {...(onRetry ? { action: { label: 'Try again', onClick: onRetry } } : {})}
    />
  );
}

/** A form's error line, announced when it appears. */
export function FormError({ message }: { message: string | null }) {
  return (
    <p role="alert" className={cx('text-body text-crit-ink', message ? 'mb-3' : 'sr-only')}>
      {message ?? ''}
    </p>
  );
}

/** A plain table with the console's styling: a caption for screen readers and a header row. */
export function Table({
  caption,
  head,
  children,
}: {
  caption: string;
  head: string[];
  children: ReactNode;
}) {
  return (
    // A region that keyboard users can focus and scroll when the table is wider than the screen (axe
    // scrollable-region-focusable).
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className="overflow-x-auto rounded-card border border-line bg-surface"
    >
      <table className="w-full min-w-[640px] border-collapse text-left text-body">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 text-meta font-bold text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const cell = 'border-b border-line px-3 py-2 align-top tabular';

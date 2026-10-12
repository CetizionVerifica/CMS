import { ArrowDown, ArrowUp, ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { cx } from '../lib/cx';
import { formatNumber } from '../lib/format';
import { Button } from '../primitives/Button';
import { Skeleton } from '../primitives/Skeleton';
import { defaultLink, type LinkRenderer } from '../lib/link';

type ContextTone = 'ok' | 'warn' | 'crit' | 'neutral';
const toneText: Record<ContextTone, string> = {
  ok: 'text-ok-ink',
  warn: 'text-warn-ink',
  crit: 'text-crit-ink',
  neutral: 'text-muted',
};

export type KpiCardProps = {
  label: string;
  /** From the API. Numbers are formatted here (en-IN grouping). */
  value: number | string;
  unit?: string;
  /** One line in a tone; the words always carry the meaning, never the colour alone. */
  context?: { text: string; tone?: ContextTone; trend?: 'up' | 'down' };
  /** Leading visual, e.g. <ScoreRing size="md" … />. */
  visual?: ReactNode;
  /** The whole card links to the register filtered to exactly these rows. */
  href?: string;
  /** Spoken after the numbers when the card is a link. */
  linkHint?: string;
  renderLink?: LinkRenderer;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  className?: string;
};

/** Spec 04 · KpiCard. One headline number, a label and one line of context. */
export function KpiCard({
  label,
  value,
  unit,
  context,
  visual,
  href,
  linkHint = 'View in register',
  renderLink = defaultLink,
  loading = false,
  error,
  onRetry,
  className,
}: KpiCardProps) {
  const card =
    'flex h-full items-center gap-3.5 rounded-card border border-line bg-surface px-4 py-3.5';

  if (loading) {
    return (
      <div aria-busy="true" className={cx(card, className)}>
        <span role="status" className="sr-only">
          Loading {label}
        </span>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-[60px]" />
          <Skeleton className="h-[26px] w-20" />
          <Skeleton className="h-3 w-[100px]" />
        </div>
      </div>
    );
  }

  const shown = typeof value === 'number' ? formatNumber(value) : value;
  const long = shown.length + (unit ? unit.length + 1 : 0) > 9;

  const body = (
    <>
      {visual ? <span className="shrink-0">{visual}</span> : null}
      <span className="flex min-w-0 flex-col">
        <span className="text-meta text-muted">{label}</span>
        <span className="flex min-w-0 items-baseline gap-1 whitespace-nowrap">
          <span
            className={cx(
              'truncate tabular text-ink',
              long ? 'text-[22px] font-extrabold leading-[30px]' : 'text-kpi',
            )}
          >
            {error ? '—' : shown}
          </span>
          {unit && !error ? <span className="text-meta text-muted">{unit}</span> : null}
        </span>
        {error ? (
          <span className="text-meta text-muted">{error}</span>
        ) : context ? (
          <span
            className={cx(
              'inline-flex items-center gap-1 text-meta',
              toneText[context.tone ?? 'neutral'],
            )}
          >
            {context.trend === 'up' ? <ArrowUp aria-hidden size={12} strokeWidth={2.5} /> : null}
            {context.trend === 'down' ? (
              <ArrowDown aria-hidden size={12} strokeWidth={2.5} />
            ) : null}
            {context.trend ? <span className="sr-only">{context.trend} </span> : null}
            {context.text}
          </span>
        ) : null}
      </span>
    </>
  );

  if (error) {
    return (
      <div className={cx(card, className)}>
        {body}
        {onRetry ? (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  }

  if (!href) return <div className={cx(card, className)}>{body}</div>;

  const name = [
    label,
    unit ? `${shown} ${unit}` : shown,
    context ? `${context.trend ? `${context.trend} ` : ''}${context.text}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return renderLink({
    href,
    'aria-label': `${name}. ${linkHint}`,
    className: cx(
      card,
      'group relative transition-colors duration-fast ease-out hover:border-line-strong',
      className,
    ),
    children: (
      <>
        {body}
        <ArrowUpRight
          aria-hidden
          size={16}
          className="absolute right-3 top-3 text-muted opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </>
    ),
  });
}

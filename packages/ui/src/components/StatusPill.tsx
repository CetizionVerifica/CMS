import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Hourglass,
  MinusCircle,
  Undo2,
  type LucideIcon,
} from 'lucide-react';

import { cx } from '../lib/cx';
import { devWarn, formatDate } from '../lib/format';

/** Instance status as derived by the engine (contracts `DerivedStatus`). Kept as literals: ui imports nothing. */
export type DerivedStatus =
  | 'UPCOMING'
  | 'DUE_SOON'
  | 'OVERDUE'
  | 'SUBMITTED'
  | 'SENT_BACK'
  | 'COMPLIED'
  | 'COMPLIED_LATE'
  | 'NOT_APPLICABLE';

export const DERIVED_STATUSES: readonly DerivedStatus[] = [
  'UPCOMING',
  'DUE_SOON',
  'OVERDUE',
  'SUBMITTED',
  'SENT_BACK',
  'COMPLIED',
  'COMPLIED_LATE',
  'NOT_APPLICABLE',
];

type Tone = 'neutral' | 'warn' | 'crit' | 'ok';

const STATUS: Record<
  DerivedStatus,
  { tone: Tone; dot: 'muted' | 'warn' | 'crit' | 'ok' | 'ring'; icon: LucideIcon }
> = {
  UPCOMING: { tone: 'neutral', dot: 'muted', icon: CalendarClock },
  DUE_SOON: { tone: 'warn', dot: 'warn', icon: Clock },
  OVERDUE: { tone: 'crit', dot: 'crit', icon: AlertCircle },
  SUBMITTED: { tone: 'warn', dot: 'warn', icon: Hourglass },
  SENT_BACK: { tone: 'crit', dot: 'crit', icon: Undo2 },
  COMPLIED: { tone: 'ok', dot: 'ok', icon: CheckCircle2 },
  // The only mixed case: ok pill, warn dot. The word "late" carries the meaning.
  COMPLIED_LATE: { tone: 'ok', dot: 'warn', icon: CheckCircle2 },
  NOT_APPLICABLE: { tone: 'neutral', dot: 'ring', icon: MinusCircle },
};

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-muted',
  warn: 'bg-warn-soft text-warn-ink',
  crit: 'bg-crit-soft text-crit-ink',
  ok: 'bg-ok-soft text-ok-ink',
};

const dotClasses = {
  muted: 'bg-muted',
  warn: 'bg-warn',
  crit: 'bg-crit',
  ok: 'bg-ok',
  ring: 'border border-line-strong bg-transparent',
} as const;

const plural = (n: number) => (n === 1 ? 'day' : 'days');

/**
 * The fixed status vocabulary (spec/status-language.md). `visible` may abbreviate large day counts ("99+");
 * `full` is the exact wording for screen readers and tooltips.
 */
export function statusLabel(
  status: DerivedStatus,
  days?: number,
): { visible: string; full: string } {
  switch (status) {
    case 'UPCOMING':
      return same('Upcoming');
    case 'DUE_SOON':
      if (days === undefined) {
        devWarn('StatusPill: DUE_SOON without `days`; showing "Due soon".');
        return same('Due soon');
      }
      if (days <= 0) return same('Due today');
      if (days === 1) return same('Due tomorrow');
      return same(`Due in ${days} days`);
    case 'OVERDUE':
      if (days === undefined) {
        devWarn('StatusPill: OVERDUE without `days`; showing "Overdue".');
        return same('Overdue');
      }
      if (days <= 0) {
        devWarn(
          `StatusPill: OVERDUE with days=${days}; the engine should send 1 or more. Showing "Overdue".`,
        );
        return same('Overdue');
      }
      return {
        visible: days > 99 ? 'Overdue 99+ days' : `Overdue ${days} ${plural(days)}`,
        full: `Overdue ${days} ${plural(days)}`,
      };
    case 'SUBMITTED':
      return same('Awaiting approval');
    case 'SENT_BACK':
      return same('Sent back');
    case 'COMPLIED':
      return same('Complied');
    case 'COMPLIED_LATE':
      return same('Complied late');
    case 'NOT_APPLICABLE':
      return same('Not applicable');
  }
}

const same = (label: string) => ({ visible: label, full: label });

/** The status as a category: "Overdue", "Due soon", otherwise the fixed label. */
export function categoryLabel(status: DerivedStatus): { visible: string; full: string } {
  if (status === 'OVERDUE') return same('Overdue');
  if (status === 'DUE_SOON') return same('Due soon');
  return statusLabel(status);
}

export type StatusPillProps = {
  status: DerivedStatus;
  /** Day count from the API (engine output), used by DUE_SOON and OVERDUE. */
  days?: number;
  /** `sm` 20px for dense tables, `md` 22px default. */
  size?: 'sm' | 'md';
  /** Icon replaces the dot (md only). */
  withIcon?: boolean;
  /** YYYY-MM-DD; adds a hover title "Due 31 Mar 2027". */
  dueDate?: string;
  /**
   * Name the status as a category, without a day count ("Overdue", "Due soon"), for filters and legends where no
   * single instance is meant.
   */
  category?: boolean;
  className?: string;
};

/** Spec 07 · StatusPill. The only way to show an instance status. Presentational: no hover, no focus. */
export function StatusPill({
  status,
  days,
  size = 'md',
  withIcon = false,
  dueDate,
  category = false,
  className,
}: StatusPillProps) {
  const def = STATUS[status];
  const { visible, full } = category ? categoryLabel(status) : statusLabel(status, days);
  const Icon = def.icon;
  const title = [visible !== full ? full : null, dueDate ? `Due ${formatDate(dueDate)}` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      title={title || undefined}
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill px-[9px] text-meta font-bold',
        size === 'sm' ? 'h-5' : 'h-[22px]',
        toneClasses[def.tone],
        className,
      )}
    >
      {withIcon && size === 'md' ? (
        <Icon aria-hidden size={14} className="shrink-0" />
      ) : (
        <span aria-hidden className={cx('size-1.5 shrink-0 rounded-pill', dotClasses[def.dot])} />
      )}
      {visible === full ? (
        visible
      ) : (
        <>
          <span aria-hidden>{visible}</span>
          <span className="sr-only">{full}</span>
        </>
      )}
    </span>
  );
}

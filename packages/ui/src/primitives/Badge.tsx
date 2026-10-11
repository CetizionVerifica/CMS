import { cx } from '../lib/cx';

/** Formats a count for a badge: above 99 shows "99+". */
export function formatCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

export type BadgeProps = {
  count: number;
  /** Accessible text with the noun, e.g. "4 waiting". The visible number is hidden from screen readers. */
  label: string;
  /** Surface the badge sits on. */
  on?: 'surface' | 'forest';
  className?: string;
};

/** Spec 00 · Badge (count). Pill, min 20px, meta 700. Accessible name includes the noun: "Approvals, 4 waiting". */
export function Badge({ count, label, on = 'surface', className }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-pill px-1.5 text-meta font-bold tabular',
        on === 'forest' ? 'bg-on-forest-selected text-on-forest' : 'bg-neutral-soft text-ink',
        className,
      )}
    >
      <span aria-hidden>{formatCount(count)}</span>
      <span className="sr-only">, {label}</span>
    </span>
  );
}

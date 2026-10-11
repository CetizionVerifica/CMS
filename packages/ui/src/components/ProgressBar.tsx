import { cx } from '../lib/cx';
import { formatNumber, formatPercent } from '../lib/format';

type Band = 'ok' | 'warn' | 'crit';
const bandFill: Record<Band, string> = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit' };

export type SegmentKey = 'ok' | 'warn' | 'crit' | 'neutral';
export type Segment = { key: SegmentKey; label: string; count: number };

const SEGMENT_ORDER: SegmentKey[] = ['ok', 'warn', 'crit', 'neutral'];
const segmentFill: Record<SegmentKey, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  // Status charts: neutral is --neutral-soft with a --line-strong outline (foundations §1.5).
  neutral: 'bg-neutral-soft shadow-[inset_0_0_0_1px_var(--line-strong)]',
};

type Common = {
  /** Accessible name, e.g. the department or Act. */
  label: string;
  /** Show the label above the bar (in tables the row already names it). */
  showLabel?: boolean;
  /** Fixed 120px for table cells; fluid otherwise. */
  width?: 'table' | 'fluid';
  loading?: boolean;
  className?: string;
};

export type ProgressBarProps =
  | (Common & {
      variant?: 'single' | 'tone';
      value: number;
      max?: number;
      /** Fill colour from the API's band (tone variant only). */
      band?: Band;
      showValue?: boolean;
      /** `percent` "82%" or `count` "171 of 208". */
      valueFormat?: 'percent' | 'count';
    })
  | (Common & {
      variant: 'stacked';
      segments: Segment[];
      legend?: 'below' | 'none';
    });

/** Spec 06 · ProgressBar: single (leaf), tone (band) or stacked status breakdown. Values come from the API. */
export function ProgressBar(props: ProgressBarProps) {
  const { label, showLabel = false, width = 'fluid', loading = false, className } = props;
  const box = cx(
    'flex min-w-0 flex-col gap-1',
    width === 'table' ? 'w-[120px]' : 'w-full',
    className,
  );
  const labelEl = showLabel ? <span className="text-body text-ink">{label}</span> : null;

  if (loading) {
    return (
      <div className={box} aria-busy="true">
        {labelEl}
        <span
          role="progressbar"
          aria-label={`${label}: loading`}
          className="block h-[7px] w-full rounded-pill bg-sage animate-[canopy-pulse_1.2s_ease-in-out_infinite] motion-reduce:animate-none"
        />
      </div>
    );
  }

  if (props.variant === 'stacked') {
    const segments = [...props.segments].sort(
      (a, b) => SEGMENT_ORDER.indexOf(a.key) - SEGMENT_ORDER.indexOf(b.key),
    );
    const total = segments.reduce((s, x) => s + x.count, 0);
    const sentence = `${label}: ${segments.map((s) => `${formatNumber(s.count)} ${s.label.toLowerCase()}`).join(', ')}`;
    return (
      <div className={box}>
        {labelEl}
        <div
          role="img"
          aria-label={sentence}
          className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-pill bg-sage"
        >
          {total > 0
            ? segments
                .filter((s) => s.count > 0)
                .map((s) => (
                  <span
                    key={s.key}
                    data-segment={s.key}
                    className={cx('h-full min-w-[3px]', segmentFill[s.key])}
                    style={{ flexGrow: s.count, flexBasis: 0 }}
                  />
                ))
            : null}
        </div>
        {props.legend !== 'none' ? (
          <ul aria-hidden className="flex flex-wrap gap-x-3 gap-y-1">
            {segments.map((s) => (
              <li key={s.key} className="inline-flex items-center gap-1.5 text-meta text-muted">
                <span className={cx('size-[9px] rounded-[2px]', segmentFill[s.key])} />
                {s.label} <span className="tabular text-ink">{formatNumber(s.count)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  const { value, max = 100, band, showValue = true, valueFormat = 'percent' } = props;
  // aria-valuenow must sit within min and max, so out-of-range input is clamped like the fill.
  const clamped = max > 0 ? Math.min(Math.max(value, 0), max) : 0;
  const pct = max > 0 ? (clamped / max) * 100 : 0;
  const valueText =
    valueFormat === 'count'
      ? `${formatNumber(value)} of ${formatNumber(max)}`
      : formatPercent(max > 0 ? (value / max) * 100 : 0);
  const fill = props.variant === 'tone' && band ? bandFill[band] : 'bg-leaf';

  return (
    <div className={box}>
      {labelEl}
      <div className="flex items-center gap-2">
        <span
          role="progressbar"
          aria-label={label}
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={Math.max(max, 0)}
          aria-valuetext={valueText}
          className="relative block h-[7px] min-w-0 flex-1 overflow-hidden rounded-pill bg-sage"
        >
          <span
            className={cx(
              'absolute inset-y-0 left-0 rounded-pill transition-[width] duration-300 ease-out',
              fill,
            )}
            style={{ width: `${pct}%` }}
          />
        </span>
        {showValue ? (
          <span className="shrink-0 text-body tabular text-ink">{valueText}</span>
        ) : null}
      </div>
    </div>
  );
}

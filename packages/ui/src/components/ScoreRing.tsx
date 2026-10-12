import { useEffect, useState } from 'react';

import { cx } from '../lib/cx';
import { devWarn } from '../lib/format';

const SIZES = {
  sm: { d: 40, stroke: 5 },
  md: { d: 58, stroke: 7 },
  lg: { d: 96, stroke: 10 },
} as const;

const bandStroke = { ok: 'stroke-ok', warn: 'stroke-warn', crit: 'stroke-crit' } as const;

export type ScoreRingProps = {
  /** 0-100 from the API; null when there is no score yet. */
  value: number | null;
  size?: 'sm' | 'md' | 'lg';
  /** What the score is, e.g. "Compliance score". */
  label: string;
  /** `brand` fills forest whatever the value; `status` fills by the API's `band`. */
  tone?: 'brand' | 'status';
  band?: 'ok' | 'warn' | 'crit';
  className?: string;
};

/** Spec 05 · ScoreRing. Sage track, forest arc from 12 o'clock clockwise; animates once on mount. */
export function ScoreRing({
  value,
  size = 'md',
  label,
  tone = 'brand',
  band,
  className,
}: ScoreRingProps) {
  const { d, stroke } = SIZES[size];
  const r = (d - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (value !== null && (value < 0 || value > 100))
    devWarn(`ScoreRing: value ${value} is outside 0-100.`);
  const clamped = value === null ? 0 : Math.min(100, Math.max(0, value));
  const shown = value === null ? null : Math.round(clamped);
  const offset = circumference * (1 - (drawn ? clamped : 0) / 100);
  const fill = tone === 'status' && band ? bandStroke[band] : 'stroke-forest';

  return (
    <span
      role="img"
      aria-label={shown === null ? `${label}: no score yet` : `${label}: ${shown}%`}
      className={cx('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: d, height: d }}
    >
      <svg aria-hidden width={d} height={d} viewBox={`0 0 ${d} ${d}`} className="-rotate-90">
        <circle
          cx={d / 2}
          cy={d / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-sage"
          strokeDasharray={value === null ? '4 4' : undefined}
        />
        {value !== null && clamped > 0 ? (
          <circle
            data-part="fill"
            cx={d / 2}
            cy={d / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className={cx(fill, 'transition-[stroke-dashoffset] duration-300 ease-out')}
          />
        ) : null}
      </svg>
      {size === 'lg' ? (
        <span aria-hidden className="absolute inset-0 flex items-center justify-center text-ink">
          {shown === null ? (
            <span className="text-kpi">—</span>
          ) : (
            <>
              <span className="text-kpi tabular">{shown}</span>
              <span className="text-meta text-muted">%</span>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}

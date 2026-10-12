import { OctagonAlert } from 'lucide-react';

import { cx } from '../lib/cx';

/** Obligation criticality (contracts `Criticality`), in enum order. */
export type Criticality = 'SUPER_CRITICAL' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Sort and filter order: never alphabetical. */
export const CRITICALITY_ORDER: readonly Criticality[] = [
  'SUPER_CRITICAL',
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
];

/** Sentence-case labels; the importer and enum keep the Excel's "Super Critical". */
export const CRITICALITY_LABEL: Record<Criticality, string> = {
  SUPER_CRITICAL: 'Super critical',
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

const levelClasses: Record<Criticality, string> = {
  SUPER_CRITICAL: 'bg-crit-soft text-crit-ink font-bold',
  CRITICAL: 'border border-crit text-crit-ink font-semibold',
  HIGH: 'border border-warn text-warn-ink font-semibold',
  MEDIUM: 'border border-line-strong text-muted font-semibold',
  LOW: 'bg-neutral-soft text-muted font-semibold',
};

export type CriticalityTagProps = {
  level: Criticality;
  size?: 'sm' | 'md';
  /** In free text (not a table column) prefix a visually hidden "Criticality:". */
  announcePrefix?: boolean;
  className?: string;
};

/** Spec 08 · CriticalityTag. Square 6px tag, never a pill, so it never looks like a status. */
export function CriticalityTag({
  level,
  size = 'md',
  announcePrefix = false,
  className,
}: CriticalityTagProps) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-tag px-2 text-meta',
        size === 'sm' ? 'h-5' : 'h-[22px]',
        levelClasses[level],
        className,
      )}
    >
      {level === 'SUPER_CRITICAL' ? (
        <OctagonAlert aria-hidden size={14} className="shrink-0" />
      ) : null}
      {announcePrefix ? <span className="sr-only">Criticality: </span> : null}
      {CRITICALITY_LABEL[level]}
    </span>
  );
}

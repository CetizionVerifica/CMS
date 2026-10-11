import type { ReactNode } from 'react';

import { cx } from '../lib/cx';

/** Spec 00 · Skeleton block: neutral-soft with a 1.2s opacity pulse (no pulse under reduced motion). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        'block rounded-control bg-neutral-soft animate-[canopy-pulse_1.2s_ease-in-out_infinite] motion-reduce:animate-none',
        className,
      )}
    />
  );
}

export type LoadingRegionProps = {
  loading: boolean;
  /** One message for the whole region, e.g. "Loading overview". */
  label: string;
  /** Skeleton shown while loading. */
  skeleton: ReactNode;
  children: ReactNode;
  className?: string;
};

/** A region that shows a skeleton while loading, with aria-busy and a single visually hidden message. */
export function LoadingRegion({
  loading,
  label,
  skeleton,
  children,
  className,
}: LoadingRegionProps) {
  return (
    <div aria-busy={loading || undefined} className={className}>
      {loading ? (
        <>
          <span role="status" className="sr-only">
            {label}
          </span>
          {skeleton}
        </>
      ) : (
        children
      )}
    </div>
  );
}

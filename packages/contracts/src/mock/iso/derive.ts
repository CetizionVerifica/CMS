// Derived ISO values the mock shows, standing in for M4's ISO engine (docs/iso/model.md §5). They follow the
// IsoEngineApi contract in src/engine-api.ts closely enough for screens and tests; M4 owns the real rules.
import type { z } from 'zod';
import type { IsoDueStatus, IsoTiming } from '../../schemas/iso-results.js';
import { daysFrom } from './common.js';

type Timing = z.input<typeof IsoTiming>;

/** `riskRating`: likelihood × severity (1-25). */
export const riskRating = (likelihood: number, severity: number): number => likelihood * severity;

/**
 * `isSignificant`: a manual override wins; otherwise the rating at or above `significantAt`, or (when the rule says so)
 * any item linked to a legal or other requirement.
 */
export function isSignificant(
  item: { rating: number; significantOverride: boolean | null; legalLinked?: boolean },
  rule: { significantAt: number; legalLinkMakesSignificant: boolean },
): boolean {
  if (item.significantOverride !== null) return item.significantOverride;
  return (
    item.rating >= rule.significantAt ||
    (rule.legalLinkMakesSignificant && item.legalLinked === true)
  );
}

/**
 * Where a dated item stands on `today`: CLOSED once `closed`, else OVERDUE after `dueOn`, DUE_SOON within
 * `dueSoonDays` of it, ON_TIME otherwise (or without a date).
 */
export function isoTiming(
  dueOn: string | null,
  closed: boolean,
  today: string,
  dueSoonDays: number,
): z.input<typeof IsoDueStatus> {
  if (closed) return { timing: 'CLOSED', overdueDays: null };
  if (dueOn === null) return { timing: 'ON_TIME', overdueDays: null };
  const days = daysFrom(today, dueOn);
  if (days < 0) return { timing: 'OVERDUE', overdueDays: -days };
  const timing: Timing = days <= dueSoonDays ? 'DUE_SOON' : 'ON_TIME';
  return { timing, overdueDays: null };
}

/** Clause readiness points: IMPLEMENTED 1, PARTIAL 0.5, others 0; score 0-100 with one decimal, null when none count. */
export function readinessScore(
  rows: { clauseId: string; status: string; naState: string; exclusionAllowed: boolean }[],
) {
  const implemented: string[] = [];
  const partial: string[] = [];
  const notStarted: string[] = [];
  const naPending: string[] = [];
  const excluded: string[] = [];
  for (const row of rows) {
    if (row.naState === 'APPROVED' && row.exclusionAllowed) excluded.push(row.clauseId);
    else if (row.naState === 'REQUESTED') naPending.push(row.clauseId);
    else if (row.status === 'IMPLEMENTED') implemented.push(row.clauseId);
    else if (row.status === 'PARTIAL') partial.push(row.clauseId);
    else notStarted.push(row.clauseId);
  }
  const counted = implemented.length + partial.length + notStarted.length + naPending.length;
  const score =
    counted === 0
      ? null
      : Math.round(((implemented.length + partial.length / 2) / counted) * 1000) / 10;
  return { score, implemented, partial, notStarted, naPending, excluded };
}

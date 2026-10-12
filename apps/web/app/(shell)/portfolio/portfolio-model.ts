// What the portfolio page shows for each client. Display only: the score, counts and dates come from GET /portfolio
// (engine output via M10); this file orders rows, words the summary and builds links (apps/web/CLAUDE.md).
import type { PortfolioRow } from '@canopy/contracts';

import { clientHref } from '../../../lib/routes';

export type PortfolioItem = {
  clientId: string;
  clientName: string;
  /** 0-100 from the API; null = no items due. */
  score: number | null;
  overdue: number;
  dueThisWeek: number;
  lastActivityAt: string | null;
  /** The client's time zone, for showing the last activity time (root CLAUDE.md rule 4). */
  timeZone: string;
  overviewHref: string;
  /** The register filtered to the overdue rows behind `overdue`. */
  overdueHref: string;
};

const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** The register filtered to one derived status, in the filter language of api-conventions.md §3. */
export function registerHref(clientId: string, status: string): string {
  return `${clientHref(clientId, 'register')}?${new URLSearchParams({ status }).toString()}`;
}

/** Rows for the table: most overdue first, then lowest score, then name, so the client needing attention leads. */
export function portfolioItems(
  rows: readonly PortfolioRow[],
  timeZones: Readonly<Record<string, string>>,
): PortfolioItem[] {
  return rows
    .map((row) => ({
      clientId: row.clientId,
      clientName: row.clientName,
      score: row.result.score,
      overdue: row.result.counts.OVERDUE,
      dueThisWeek: row.dueThisWeek,
      lastActivityAt: row.lastActivityAt,
      timeZone: timeZones[row.clientId] ?? DEFAULT_TIME_ZONE,
      overviewHref: clientHref(row.clientId),
      overdueHref: registerHref(row.clientId, 'OVERDUE'),
    }))
    .sort(
      (a, b) =>
        b.overdue - a.overdue ||
        (a.score ?? Infinity) - (b.score ?? Infinity) ||
        a.clientName.localeCompare(b.clientName, 'en'),
    );
}

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** The line under the heading states the top issue in words (apps/web/CLAUDE.md, Overview rule). */
export function portfolioSummary(items: readonly PortfolioItem[]): string {
  const clients = plural(items.length, 'client', 'clients');
  const late = items.filter((i) => i.overdue > 0);
  if (late.length === 0) return `No overdue items across ${clients}.`;
  const total = late.reduce((sum, i) => sum + i.overdue, 0);
  const lead = `${plural(total, 'overdue item', 'overdue items')} across ${plural(late.length, 'client', 'clients')}.`;
  if (late.length === 1) return lead;
  const top = late[0]!;
  return `${lead} ${top.clientName} has the most (${top.overdue}).`;
}

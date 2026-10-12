// What the client overview shows, from GET /clients/{id}/overview and /breakdowns. Display only (apps/web/CLAUDE.md):
// scores, counts, statuses and overdue days are the API's (engine output). This file groups statuses into the cards'
// words, picks the greeting line and builds the register links, each filtered to exactly the rows behind a number.
import type {
  Breakdown,
  ClientOverview,
  DerivedStatus,
  InstanceRow,
  ScoreResult,
} from '@canopy/contracts';
import type { DeadlineItem, Segment, TaskItem } from '@canopy/ui';

import { withPeriod, type Period } from '../../../../../lib/period';
import { clientHref } from '../../../../../lib/routes';

/** Statuses still to be done by the owner. SUBMITTED is waiting on the approver, so it has its own card. */
export const OPEN_STATUSES = ['UPCOMING', 'DUE_SOON', 'OVERDUE'] as const satisfies DerivedStatus[];
const COMPLIED_STATUSES = ['COMPLIED', 'COMPLIED_LATE'] as const satisfies DerivedStatus[];
const PENDING_STATUSES = ['UPCOMING', 'DUE_SOON', 'SUBMITTED'] as const satisfies DerivedStatus[];

const sum = (result: ScoreResult, statuses: readonly DerivedStatus[]) =>
  statuses.reduce((n, s) => n + result.counts[s], 0);

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/**
 * A register link in the filter language of api-conventions.md §3, carrying the page's period (`?fy=&q=`) so the
 * register opens on the same rows the number counted.
 */
export function registerHref(
  clientId: string,
  filters: Record<string, string>,
  period?: Period,
  path = 'register',
): string {
  const params = new URLSearchParams(filters);
  const query = (period ? withPeriod(params, period) : params).toString();
  return `${clientHref(clientId, path)}${query ? `?${query}` : ''}`;
}

/** The greeting states the top issue in words: "5 items are overdue, 2 are super critical." */
export function greeting(result: ScoreResult, byCriticality: Breakdown | undefined): string {
  const overdue = result.counts.OVERDUE;
  if (overdue > 0) {
    const superCritical =
      byCriticality?.rows.find((r) => r.key === 'SUPER_CRITICAL')?.result.counts.OVERDUE ?? 0;
    const lead = overdue === 1 ? '1 item is overdue' : `${overdue} items are overdue`;
    if (superCritical === 0) return `${lead}.`;
    if (overdue === 1) return '1 item is overdue, and it is super critical.';
    return `${lead}, ${superCritical} ${superCritical === 1 ? 'is' : 'are'} super critical.`;
  }
  const waiting = result.counts.SUBMITTED;
  if (waiting > 0) {
    return `Nothing is overdue. ${plural(waiting, 'item is', 'items are')} awaiting approval.`;
  }
  if (sum(result, OPEN_STATUSES) === 0 && sum(result, COMPLIED_STATUSES) === 0) {
    return 'Nothing is due in this period.';
  }
  return 'Nothing is overdue.';
}

export type Kpi = {
  label: string;
  value: number | string;
  unit?: string;
  score?: number | null;
  context?: { text: string; tone: 'ok' | 'warn' | 'crit' | 'neutral' };
  href: string;
  linkHint: string;
};

export function kpis(
  clientId: string,
  result: ScoreResult,
  period: Period | undefined,
  byCriticality: Breakdown | undefined,
): Kpi[] {
  const open = sum(result, OPEN_STATUSES);
  const overdue = result.counts.OVERDUE;
  const superCritical =
    byCriticality?.rows.find((r) => r.key === 'SUPER_CRITICAL')?.result.counts.OVERDUE ?? 0;
  const complied = sum(result, COMPLIED_STATUSES);
  const link = (statuses: readonly DerivedStatus[]) =>
    registerHref(clientId, { status: statuses.join(',') }, period);
  return [
    {
      label: 'Compliance score',
      value: result.score ?? 'No items due',
      unit: result.score === null ? undefined : '%',
      score: result.score,
      context:
        result.onTimeRate === null
          ? undefined
          : { text: `${result.onTimeRate}% complied on time`, tone: 'neutral' },
      href: link(COMPLIED_STATUSES),
      linkHint: `Open the ${plural(complied, 'complied instance', 'complied instances')}`,
    },
    {
      label: 'Open',
      value: open,
      context:
        result.counts.DUE_SOON > 0
          ? { text: `${result.counts.DUE_SOON} due soon`, tone: 'warn' }
          : undefined,
      href: link(OPEN_STATUSES),
      linkHint: 'Open these instances in the register',
    },
    {
      label: 'Overdue',
      value: overdue,
      context:
        superCritical > 0
          ? { text: `${superCritical} super critical`, tone: 'crit' }
          : overdue > 0
            ? { text: 'Needs action', tone: 'crit' }
            : { text: 'None overdue', tone: 'ok' },
      href: link(['OVERDUE']),
      linkHint: 'Open the overdue instances in the register',
    },
    {
      label: 'Awaiting approval',
      value: result.counts.SUBMITTED,
      href: link(['SUBMITTED']),
      linkHint: 'Open the instances awaiting approval in the register',
    },
  ];
}

export type DepartmentRow = {
  id: string;
  name: string;
  /** The department's score from the API; null = no items due. */
  score: number | null;
  complied: number;
  overdue: number;
  href: string;
  overdueHref: string;
};

/** Readiness by department: most overdue first, then the lowest score, then the name. */
export function departmentRows(
  clientId: string,
  breakdown: Breakdown,
  period: Period | undefined,
): DepartmentRow[] {
  return breakdown.rows
    .map((row) => ({
      id: row.key,
      name: row.label,
      score: row.result.score,
      complied: sum(row.result, COMPLIED_STATUSES),
      overdue: row.result.counts.OVERDUE,
      href: registerHref(clientId, { departmentId: row.key }, period),
      overdueHref: registerHref(clientId, { departmentId: row.key, status: 'OVERDUE' }, period),
    }))
    .sort(
      (a, b) =>
        b.overdue - a.overdue ||
        (a.score ?? Infinity) - (b.score ?? Infinity) ||
        a.name.localeCompare(b.name, 'en'),
    );
}

export type ActRow = { id: string; name: string; segments: Segment[]; href: string };

/** Status by Act: complied, pending, overdue and not applicable, most overdue first. */
export function actRows(
  clientId: string,
  breakdown: Breakdown,
  period: Period | undefined,
): ActRow[] {
  return breakdown.rows
    .map((row) => ({
      id: row.key,
      name: row.label,
      segments: [
        { key: 'ok', label: 'Complied', count: sum(row.result, COMPLIED_STATUSES) },
        { key: 'warn', label: 'Pending', count: sum(row.result, PENDING_STATUSES) },
        { key: 'crit', label: 'Overdue', count: row.result.counts.OVERDUE },
        { key: 'neutral', label: 'Not applicable', count: row.result.counts.NOT_APPLICABLE },
      ] satisfies Segment[],
      href: registerHref(clientId, { actId: row.key }, period),
    }))
    .sort(
      (a, b) => b.segments[2]!.count - a.segments[2]!.count || a.name.localeCompare(b.name, 'en'),
    );
}

const instanceHref = (row: InstanceRow, period: Period | undefined) =>
  registerHref(row.clientId, {}, period, `register/${encodeURIComponent(row.id)}`);

export function deadlineItems(rows: readonly InstanceRow[], period?: Period): DeadlineItem[] {
  return rows.map((row) => ({
    id: row.id,
    dueDate: row.dueDate,
    title: row.title,
    meta: `${row.departmentName} · ${row.ownerName}`,
    status: row.status,
    days: row.overdueDays ?? undefined,
    href: instanceHref(row, period),
  }));
}

export function taskItems(rows: readonly InstanceRow[], period?: Period): TaskItem[] {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    meta: row.actName,
    dueDate: row.dueDate,
    status: row.status,
    days: row.overdueDays ?? undefined,
    href: instanceHref(row, period),
  }));
}

export type OverviewModel = {
  greeting: string;
  kpis: Kpi[];
  departments: DepartmentRow[];
  acts: ActRow[];
  upcoming: DeadlineItem[];
  myTasks: TaskItem[];
  /** The API's as-of date, for grouping deadlines by week (never the browser clock). */
  today: string;
  calendarHref: string;
  myItemsHref: string;
};

export function overviewModel(input: {
  clientId: string;
  period?: Period;
  overview: ClientOverview;
  byDepartment: Breakdown;
  byAct: Breakdown;
  byCriticality?: Breakdown;
}): OverviewModel {
  const { clientId, period, overview } = input;
  return {
    greeting: greeting(overview.result, input.byCriticality),
    kpis: kpis(clientId, overview.result, period, input.byCriticality),
    departments: departmentRows(clientId, input.byDepartment, period),
    acts: actRows(clientId, input.byAct, period),
    upcoming: deadlineItems(overview.upcoming, period),
    myTasks: taskItems(overview.myTasks, period),
    today: overview.result.asOf,
    calendarHref: registerHref(clientId, {}, period, 'calendar'),
    myItemsHref: registerHref(clientId, { ownerId: 'me', status: OPEN_STATUSES.join(',') }, period),
  };
}

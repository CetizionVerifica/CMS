// What the client overview shows, from GET /clients/{id}/overview and /breakdowns. Display only (apps/web/CLAUDE.md):
// scores, counts, statuses and overdue days are the API's (engine output). This file groups statuses into the cards'
// words, picks the greeting line and builds the register links, each filtered to exactly the rows behind a number.
import type {
  ActivitySource,
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

/** The add-on that puts ISO activities in the register beside the statutory work (`ShellModel.features`). */
const ISO_FEATURE = 'isoManagement';

/**
 * The source every link from a statutory number carries: `LAW` while the account has the ISO add-on, because the
 * register, calendar and approvals then list ISO activities too, while the numbers count STATUTE-act instances only
 * (docs/iso/plan.md §4.6). Without the add-on the register is statutory anyway, so links stay as they were.
 */
export function lawSource(features: readonly string[]): ActivitySource | undefined {
  return features.includes(ISO_FEATURE) ? 'LAW' : undefined;
}

/**
 * A register link in the filter language of api-conventions.md §3, carrying the page's period (`?fy=&q=`) so the
 * register opens on the same rows the number counted, and the `source` those rows come from (see `lawSource`).
 */
export function registerHref(
  clientId: string,
  filters: Record<string, string>,
  period?: Period,
  path = 'register',
  source?: ActivitySource,
): string {
  const params = new URLSearchParams(filters);
  if (source) params.set('source', source);
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
  /** Words only. A number under the headline is a `detail`, with its own link to exactly its rows. */
  context?: { text: string; tone: Tone };
  href: string;
  linkHint: string;
  detail?: KpiDetail;
};

type Tone = 'ok' | 'warn' | 'crit' | 'neutral';

/** A second number on a card ("3 due soon"), shown under it as its own link: one link can't sit inside another. */
export type KpiDetail = { text: string; tone: Tone; href: string; label: string };

export function kpis(
  clientId: string,
  result: ScoreResult,
  period: Period | undefined,
  byCriticality: Breakdown | undefined,
  source?: ActivitySource,
): Kpi[] {
  const open = sum(result, OPEN_STATUSES);
  const overdue = result.counts.OVERDUE;
  const superCritical =
    byCriticality?.rows.find((r) => r.key === 'SUPER_CRITICAL')?.result.counts.OVERDUE ?? 0;
  const complied = sum(result, COMPLIED_STATUSES);
  const link = (statuses: readonly DerivedStatus[], filters: Record<string, string> = {}) =>
    registerHref(clientId, { status: statuses.join(','), ...filters }, period, 'register', source);
  const dueSoon = result.counts.DUE_SOON;
  return [
    {
      label: 'Compliance score',
      value: result.score ?? 'No items due',
      unit: result.score === null ? undefined : '%',
      score: result.score,
      href: link(COMPLIED_STATUSES),
      linkHint: `Open the ${plural(complied, 'complied instance', 'complied instances')}`,
      detail:
        result.onTimeRate === null
          ? undefined
          : {
              text: `${result.onTimeRate}% complied on time`,
              tone: 'neutral',
              href: link(['COMPLIED']),
              label: `${result.onTimeRate}% complied on time, open the instances complied on time`,
            },
    },
    {
      label: 'Open',
      value: open,
      href: link(OPEN_STATUSES),
      linkHint: 'Open these instances',
      detail:
        dueSoon > 0
          ? {
              text: `${dueSoon} due soon`,
              tone: 'warn',
              href: link(['DUE_SOON']),
              label: `${dueSoon} due soon, open the instances due soon`,
            }
          : undefined,
    },
    {
      label: 'Overdue',
      value: overdue,
      context:
        overdue > 0 ? { text: 'Needs action', tone: 'crit' } : { text: 'None overdue', tone: 'ok' },
      href: link(['OVERDUE']),
      linkHint: 'Open the overdue instances',
      detail:
        superCritical > 0
          ? {
              text: `${superCritical} super critical`,
              tone: 'crit',
              href: link(['OVERDUE'], { criticality: 'SUPER_CRITICAL' }),
              label: `${superCritical} super critical overdue, open these instances`,
            }
          : undefined,
    },
    {
      label: 'Awaiting approval',
      value: result.counts.SUBMITTED,
      href: link(['SUBMITTED']),
      linkHint: 'Open the instances awaiting approval',
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
  compliedHref: string;
};

/** Readiness by department: most overdue first, then the lowest score, then the name. */
export function departmentRows(
  clientId: string,
  breakdown: Breakdown,
  period: Period | undefined,
  source?: ActivitySource,
): DepartmentRow[] {
  const link = (filters: Record<string, string>) =>
    registerHref(clientId, filters, period, 'register', source);
  return breakdown.rows
    .map((row) => ({
      id: row.key,
      name: row.label,
      score: row.result.score,
      complied: sum(row.result, COMPLIED_STATUSES),
      overdue: row.result.counts.OVERDUE,
      href: link({ departmentId: row.key }),
      overdueHref: link({ departmentId: row.key, status: 'OVERDUE' }),
      compliedHref: link({ departmentId: row.key, status: COMPLIED_STATUSES.join(',') }),
    }))
    .sort(
      (a, b) =>
        b.overdue - a.overdue ||
        (a.score ?? Infinity) - (b.score ?? Infinity) ||
        a.name.localeCompare(b.name, 'en'),
    );
}

/** One part of an Act's bar, with a link to exactly the instances it counts. */
export type ActSegment = Segment & { href: string };
export type ActRow = { id: string; name: string; segments: ActSegment[]; href: string };

const ACT_SEGMENTS: readonly {
  key: Segment['key'];
  label: string;
  statuses: readonly DerivedStatus[];
}[] = [
  { key: 'ok', label: 'Complied', statuses: COMPLIED_STATUSES },
  { key: 'warn', label: 'Pending', statuses: PENDING_STATUSES },
  { key: 'crit', label: 'Overdue', statuses: ['OVERDUE'] },
  { key: 'neutral', label: 'Not applicable', statuses: ['NOT_APPLICABLE'] },
];

/** Status by Act: complied, pending, overdue and not applicable, most overdue first. */
export function actRows(
  clientId: string,
  breakdown: Breakdown,
  period: Period | undefined,
  source?: ActivitySource,
): ActRow[] {
  const link = (filters: Record<string, string>) =>
    registerHref(clientId, filters, period, 'register', source);
  return breakdown.rows
    .map((row) => ({
      id: row.key,
      name: row.label,
      segments: ACT_SEGMENTS.map(({ key, label, statuses }) => ({
        key,
        label,
        count: sum(row.result, statuses),
        href: link({ actId: row.key, status: statuses.join(',') }),
      })),
      href: link({ actId: row.key }),
    }))
    .sort(
      (a, b) => b.segments[2]!.count - a.segments[2]!.count || a.name.localeCompare(b.name, 'en'),
    );
}

// The register behind an instance keeps the source too, so closing the record shows the list the overview counted.
const instanceHref = (row: InstanceRow, period: Period | undefined, source?: ActivitySource) =>
  registerHref(row.clientId, {}, period, `register/${encodeURIComponent(row.id)}`, source);

export function deadlineItems(
  rows: readonly InstanceRow[],
  period?: Period,
  source?: ActivitySource,
): DeadlineItem[] {
  return rows.map((row) => ({
    id: row.id,
    dueDate: row.dueDate,
    title: row.title,
    meta: `${row.departmentName} · ${row.ownerName}`,
    status: row.status,
    days: row.overdueDays ?? undefined,
    href: instanceHref(row, period, source),
  }));
}

export function taskItems(
  rows: readonly InstanceRow[],
  period?: Period,
  source?: ActivitySource,
): TaskItem[] {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    meta: row.actName,
    dueDate: row.dueDate,
    status: row.status,
    days: row.overdueDays ?? undefined,
    href: instanceHref(row, period, source),
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
  /** The account's add-ons (`ShellModel.features`): with ISO on, every link says `source=LAW` (`lawSource`). */
  features?: readonly string[];
}): OverviewModel {
  const { clientId, period, overview } = input;
  const source = lawSource(input.features ?? []);
  return {
    greeting: greeting(overview.result, input.byCriticality),
    kpis: kpis(clientId, overview.result, period, input.byCriticality, source),
    departments: departmentRows(clientId, input.byDepartment, period, source),
    acts: actRows(clientId, input.byAct, period, source),
    upcoming: deadlineItems(overview.upcoming, period, source),
    myTasks: taskItems(overview.myTasks, period, source),
    today: overview.result.asOf,
    calendarHref: registerHref(clientId, {}, period, 'calendar', source),
    myItemsHref: registerHref(
      clientId,
      { ownerId: 'me', status: OPEN_STATUSES.join(',') },
      period,
      'register',
      source,
    ),
  };
}

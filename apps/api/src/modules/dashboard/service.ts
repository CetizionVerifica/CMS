import type {
  Action,
  ActivitySource,
  Breakdown,
  BreakdownBy,
  CalendarDay,
  ClientOverview,
  Criticality,
  DueThisWeekFilter,
  InstanceRow,
  LocalDate,
  PortfolioRow,
  RequestContext,
} from '@canopy/contracts';
import {
  addDays,
  compareDates,
  computeBreakdown,
  computeScore,
  daysBetween,
  summarizeKpis,
} from '@canopy/engine';
import { ApiError, can } from '../../auth/index.js';
import type { ClientInfo, ReportsStore, RowFilter } from './ports.js';
import {
  isoOn,
  loadRows,
  periodFilter,
  requireClientInfo,
  resolveAsOf,
  resolvePeriod,
  scopedUnits,
  scoreInput,
  sourceKinds,
  STATUTORY,
  type LoadedRows,
  type Period,
} from './scope.js';

/** Dashboard reads (docs/contracts/endpoints.md §6). Numbers come from the engine with their instance ids. */

/** Items listed in each overview panel. */
export const OVERVIEW_LIST_LIMIT = 10;
/** Longest calendar range, in days; a year view is the widest the UI shows. */
export const MAX_CALENDAR_DAYS = 366;

/** Criticality words in UI copy (packages/ui/spec/status-language.md, sentence case). */
export const CRITICALITY_LABELS: Readonly<Record<Criticality, string>> = {
  SUPER_CRITICAL: 'Super critical',
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export interface DashboardQueryInput {
  asOf?: LocalDate;
  fy?: string;
  from?: LocalDate;
  to?: LocalDate;
  unitId?: string[];
}

export interface DashboardDeps {
  store: ReportsStore;
  clock: () => Date;
}

export interface ClientRows extends LoadedRows {
  client: ClientInfo;
  period: Period;
}

/**
 * The client's rows in the requested period and units, as the actor may see them for `action`, of the act kinds in
 * `kinds`: STATUTE only unless a list of `source` says otherwise (docs/iso/plan.md §4.6).
 */
export async function clientRows(
  deps: DashboardDeps,
  ctx: RequestContext,
  clientId: string,
  query: DashboardQueryInput,
  action: Action,
  kinds: Pick<RowFilter, 'actKinds'> = STATUTORY,
): Promise<ClientRows> {
  const client = await requireClientInfo(deps.store, ctx, clientId);
  return rowsFor(deps, ctx, client, query, action, kinds);
}

async function rowsFor(
  deps: DashboardDeps,
  ctx: RequestContext,
  client: ClientInfo,
  query: DashboardQueryInput,
  action: Action,
  kinds: Pick<RowFilter, 'actKinds'>,
): Promise<ClientRows> {
  const asOf = resolveAsOf(ctx, client, query.asOf, deps.clock(), action);
  const period = resolvePeriod(query, asOf, client.settings.fyStartMonth);
  const unitIds = scopedUnits(ctx, client.id, query.unitId);
  const loaded = await loadRows(
    deps.store,
    ctx,
    client,
    { ...periodFilter(period), ...(unitIds === undefined ? {} : { unitIds }), ...kinds },
    asOf,
    action,
  );
  return { ...loaded, client, period };
}

function score({ rows, asOf, settings }: LoadedRows) {
  return computeScore(rows.map(scoreInput), asOf, settings);
}

/**
 * The register filter that lists a portfolio row's `dueThisWeek` items: OPEN and SENT_BACK work due from `asOf`
 * through `dueSoonDays` later (the engine's DUE_SOON), within the period, and with the ISO add-on on `source=LAW`, so
 * the linked register lists exactly the statutory items counted (docs/iso/plan.md §4.6). None when the register cannot
 * say it: a `unitId` filter (the link has no units) or a period that leaves no due-soon day.
 */
export function dueThisWeekFilter(
  loaded: ClientRows,
  query: DashboardQueryInput,
  iso: boolean,
): DueThisWeekFilter | undefined {
  if (query.unitId !== undefined) return undefined;
  const { asOf, period, settings } = loaded;
  const soonest = addDays(asOf, settings.dueSoonDays);
  const dueFrom = period.from !== null && compareDates(period.from, asOf) > 0 ? period.from : asOf;
  const dueTo = period.to !== null && compareDates(period.to, soonest) < 0 ? period.to : soonest;
  if (compareDates(dueFrom, dueTo) > 0) return undefined;
  return {
    dueFrom,
    dueTo,
    workflowState: ['OPEN', 'SENT_BACK'],
    ...(iso ? { source: 'LAW' as const } : {}),
  };
}

/** One row per client the consultant sees, in client name order. */
export async function portfolio(
  deps: DashboardDeps,
  ctx: RequestContext,
  query: DashboardQueryInput,
): Promise<{ items: PortfolioRow[] }> {
  const visible = ctx.clientIds.filter((clientId) =>
    can(ctx, 'dashboard.portfolio', { type: 'client', clientId }),
  );
  const clients = await deps.store.clients(ctx, visible);
  const activity = await deps.store.lastActivity(
    ctx,
    clients.map((c) => c.id),
  );
  const iso = await isoOn(ctx);
  const items: PortfolioRow[] = [];
  for (const client of clients) {
    const loaded = await rowsFor(deps, ctx, client, query, 'dashboard.portfolio', STATUTORY);
    const result = score(loaded);
    const filter = dueThisWeekFilter(loaded, query, iso);
    items.push({
      clientId: client.id,
      clientName: client.name,
      result,
      dueThisWeek: summarizeKpis(result).dueSoon.count,
      ...(filter === undefined ? {} : { dueThisWeekFilter: filter }),
      lastActivityAt: activity.get(client.id) ?? null,
    });
  }
  return { items };
}

/** Score for the period, the next open items by due date, and the actor's own open items. */
export async function overview(
  deps: DashboardDeps,
  ctx: RequestContext,
  clientId: string,
  query: DashboardQueryInput,
): Promise<ClientOverview> {
  const loaded = await clientRows(deps, ctx, clientId, query, 'dashboard.read');
  const open = (r: InstanceRow) => r.status === 'UPCOMING' || r.status === 'DUE_SOON';
  return {
    result: score(loaded),
    upcoming: loaded.rows.filter(open).slice(0, OVERVIEW_LIST_LIMIT),
    // As `GET /me/tasks`: OPEN and SENT_BACK instances the person owns.
    myTasks: loaded.rows
      .filter(
        (r) =>
          r.ownerId === ctx.personId &&
          (r.workflowState === 'OPEN' || r.workflowState === 'SENT_BACK'),
      )
      .slice(0, OVERVIEW_LIST_LIMIT),
  };
}

const GROUPS: Readonly<Record<BreakdownBy, (r: InstanceRow) => { key: string; label: string }>> = {
  department: (r) => ({ key: r.departmentId, label: r.departmentName }),
  act: (r) => ({ key: r.actId, label: r.actName }),
  criticality: (r) => ({ key: r.criticality, label: CRITICALITY_LABELS[r.criticality] }),
  unit: (r) => ({ key: r.unitId, label: r.unitName }),
  owner: (r) => ({ key: r.ownerId, label: r.ownerName }),
};

/** Engine breakdown of already loaded rows. */
export function breakdownOf(by: BreakdownBy, loaded: LoadedRows): Breakdown {
  return computeBreakdown(
    by,
    loaded.rows.map((r) => ({ ...GROUPS[by](r), item: scoreInput(r) })),
    loaded.asOf,
    loaded.settings,
  );
}

export async function breakdown(
  deps: DashboardDeps,
  ctx: RequestContext,
  clientId: string,
  query: DashboardQueryInput & { by: BreakdownBy },
  action: Action = 'dashboard.read',
): Promise<Breakdown> {
  return breakdownOf(query.by, await clientRows(deps, ctx, clientId, query, action));
}

/**
 * Instances by due date between `from` and `to` (inclusive); only dates with items are listed. The calendar is a
 * list, not a statutory number: with the ISO add-on on it takes `source` (both kinds when absent); while it is off it
 * leaves ISO activities out whatever `source` says (docs/iso/plan.md §4.4-4.6).
 */
export async function calendar(
  deps: DashboardDeps,
  ctx: RequestContext,
  clientId: string,
  query: {
    asOf?: LocalDate;
    from: LocalDate;
    to: LocalDate;
    unitId?: string[];
    source?: ActivitySource;
  },
): Promise<{ items: CalendarDay[] }> {
  if (daysBetween(query.from, query.to) + 1 > MAX_CALENDAR_DAYS) {
    throw new ApiError('VALIDATION', {
      issues: [{ path: ['to'], message: `A calendar covers at most ${MAX_CALENDAR_DAYS} days` }],
    });
  }
  const kinds = sourceKinds(await isoOn(ctx), query.source);
  const loaded = await clientRows(deps, ctx, clientId, query, 'instance.read', kinds);
  const days = new Map<LocalDate, InstanceRow[]>();
  for (const row of loaded.rows) {
    const items = days.get(row.dueDate) ?? [];
    items.push(row);
    days.set(row.dueDate, items);
  }
  return { items: [...days.entries()].map(([date, items]) => ({ date, items })) };
}

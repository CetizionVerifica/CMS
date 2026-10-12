import type {
  Action,
  Breakdown,
  BreakdownBy,
  CalendarDay,
  ClientOverview,
  Criticality,
  InstanceRow,
  LocalDate,
  PortfolioRow,
  RequestContext,
} from '@canopy/contracts';
import { computeBreakdown, computeScore, daysBetween, summarizeKpis } from '@canopy/engine';
import { ApiError, can } from '../../auth/index.js';
import type { ClientInfo, ReportsStore } from './ports.js';
import {
  loadRows,
  periodFilter,
  requireClientInfo,
  resolveAsOf,
  resolvePeriod,
  scopedUnits,
  scoreInput,
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

/** The client's rows in the requested period and units, as the actor may see them for `action`. */
export async function clientRows(
  deps: DashboardDeps,
  ctx: RequestContext,
  clientId: string,
  query: DashboardQueryInput,
  action: Action,
): Promise<ClientRows> {
  const client = await requireClientInfo(deps.store, ctx, clientId);
  return rowsFor(deps, ctx, client, query, action);
}

async function rowsFor(
  deps: DashboardDeps,
  ctx: RequestContext,
  client: ClientInfo,
  query: DashboardQueryInput,
  action: Action,
): Promise<ClientRows> {
  const asOf = resolveAsOf(ctx, client, query.asOf, deps.clock(), action);
  const period = resolvePeriod(query, asOf, client.settings.fyStartMonth);
  const unitIds = scopedUnits(ctx, client.id, query.unitId);
  const loaded = await loadRows(
    deps.store,
    ctx,
    client,
    { ...periodFilter(period), ...(unitIds === undefined ? {} : { unitIds }) },
    asOf,
    action,
  );
  return { ...loaded, client, period };
}

function score({ rows, asOf, settings }: LoadedRows) {
  return computeScore(rows.map(scoreInput), asOf, settings);
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
  const items: PortfolioRow[] = [];
  for (const client of clients) {
    const loaded = await rowsFor(deps, ctx, client, query, 'dashboard.portfolio');
    const result = score(loaded);
    items.push({
      clientId: client.id,
      clientName: client.name,
      result,
      dueThisWeek: summarizeKpis(result).dueSoon.count,
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

/** Instances by due date between `from` and `to` (inclusive); only dates with items are listed. */
export async function calendar(
  deps: DashboardDeps,
  ctx: RequestContext,
  clientId: string,
  query: { asOf?: LocalDate; from: LocalDate; to: LocalDate; unitId?: string[] },
): Promise<{ items: CalendarDay[] }> {
  if (daysBetween(query.from, query.to) + 1 > MAX_CALENDAR_DAYS) {
    throw new ApiError('VALIDATION', {
      issues: [{ path: ['to'], message: `A calendar covers at most ${MAX_CALENDAR_DAYS} days` }],
    });
  }
  const loaded = await clientRows(deps, ctx, clientId, query, 'instance.read');
  const days = new Map<LocalDate, InstanceRow[]>();
  for (const row of loaded.rows) {
    const items = days.get(row.dueDate) ?? [];
    items.push(row);
    days.set(row.dueDate, items);
  }
  return { items: [...days.entries()].map(([date, items]) => ({ date, items })) };
}

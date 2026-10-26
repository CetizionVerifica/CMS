import type {
  Action,
  ActKind,
  ActivitySource,
  FirmSettings,
  InstanceRow,
  LocalDate,
  RequestContext,
  ScoreInput,
} from '@canopy/contracts';
import { engine, fyBounds, fyLabel, fyRangeOf, fyStartYear, localDateIn } from '@canopy/engine';
import type { RegisterRow } from '@canopy/db';
import { ApiError, can, hasFeature } from '../../auth/index.js';
import type { ClientInfo, ReportsStore, RowFilter } from './ports.js';

/**
 * What every M10 read shares: who may set `asOf`, which units an actor sees, the period, and turning stored
 * rows into register rows with the engine's status. No status or score maths here (root CLAUDE.md rule 3).
 */

/** The ISO add-on's feature flag (docs/iso/plan.md §4.1). */
export const ISO_FEATURE = 'isoManagement';

/**
 * Statutory numbers (scores, KPIs, breakdowns, the act-wise, department-wise and overdue reports, the certificate)
 * read STATUTE-act instances only, with the ISO add-on on or off (docs/iso/plan.md §4.6).
 */
export const STATUTORY: Readonly<Pick<RowFilter, 'actKinds'>> = { actKinds: ['STATUTE'] };

/**
 * The act kinds a list of `source` reads (the calendar, the register export): with the ISO add-on off STATUTE only,
 * whatever `source` says; with it on `LAW` = STATUTE, `ISO` = STANDARD and both when `source` is absent
 * (docs/iso/plan.md §4.4, §4.6).
 */
export function sourceKinds(
  isoOn: boolean,
  source: ActivitySource | undefined,
): Pick<RowFilter, 'actKinds'> {
  if (!isoOn) return STATUTORY;
  if (source === undefined) return {};
  const kind: ActKind = source === 'ISO' ? 'STANDARD' : 'STATUTE';
  return { actKinds: [kind] };
}

/** Whether the request's account has the ISO add-on now (M5's `hasFeature`, read fresh on every request). */
export const isoOn = (ctx: RequestContext): Promise<boolean> => hasFeature(ctx, ISO_FEATURE);

/** Roles that may report "as at" another date (api-conventions.md §1). */
const AS_OF_ROLES = new Set(['FIRM_ADMIN', 'CONSULTANT', 'VIEWER']);

function memberships(ctx: RequestContext, clientId: string) {
  return ctx.memberships.filter(
    (m) =>
      m.archivedAt === null &&
      (m.role === 'FIRM_ADMIN' ||
        (m.role === 'CONSULTANT' && (m.consultantClientIds ?? []).includes(clientId)) ||
        m.clientId === clientId),
  );
}

/**
 * The date status is derived at: `requested` when the actor may set it for this client, else today in the
 * client's time zone. Throws FORBIDDEN (with the endpoint's action) for anyone else who sets it.
 */
export function resolveAsOf(
  ctx: RequestContext,
  client: ClientInfo,
  requested: LocalDate | undefined,
  now: Date,
  action: Action,
): LocalDate {
  if (requested === undefined) return localDateIn(now.toISOString(), client.settings.timeZone);
  if (!memberships(ctx, client.id).some((m) => AS_OF_ROLES.has(m.role))) {
    throw new ApiError('FORBIDDEN', { action }, 'Only firm staff and viewers may set asOf.');
  }
  return requested;
}

/**
 * Units the actor sees in a client: null for all, else the union of its unit-limited memberships
 * (APPROVER and OWNER with `unitIds`). Matches `can()`'s scope rule (auth/policy.ts `inScope`).
 */
export function unitScope(ctx: RequestContext, clientId: string): string[] | null {
  const units = new Set<string>();
  for (const m of memberships(ctx, clientId)) {
    const limited = (m.role === 'APPROVER' || m.role === 'OWNER') && m.unitIds !== null;
    if (!limited) return null;
    for (const id of m.unitIds ?? []) units.add(id);
  }
  return [...units].sort();
}

/** `unitScope` intersected with a requested `unitId` list. */
export function scopedUnits(
  ctx: RequestContext,
  clientId: string,
  requested: readonly string[] | undefined,
): string[] | undefined {
  const scope = unitScope(ctx, clientId);
  if (scope === null) return requested === undefined ? undefined : [...requested];
  return requested === undefined ? scope : scope.filter((id) => requested.includes(id));
}

export interface Period {
  from: LocalDate | null;
  to: LocalDate | null;
  /** The FY label when the period is one whole FY. */
  fy: string | null;
}

/** `fy`, or `from`/`to` (open-ended when one is missing), else the FY containing `asOf`. */
export function resolvePeriod(
  query: { fy?: string; from?: LocalDate; to?: LocalDate },
  asOf: LocalDate,
  fyStartMonth: number,
): Period {
  if (query.fy !== undefined) return { ...fyRangeOf(query.fy, fyStartMonth), fy: query.fy };
  if (query.from !== undefined || query.to !== undefined) {
    return { from: query.from ?? null, to: query.to ?? null, fy: null };
  }
  return {
    ...fyBounds(fyStartYear(asOf, fyStartMonth), fyStartMonth),
    fy: fyLabel(asOf, fyStartMonth),
  };
}

export function periodFilter(period: Period): Pick<RowFilter, 'dueFrom' | 'dueTo'> {
  return {
    ...(period.from === null ? {} : { dueFrom: period.from }),
    ...(period.to === null ? {} : { dueTo: period.to }),
  };
}

/** A register row with the engine's status at `asOf` (InstanceRow.status and overdueDays). */
export function withStatus(row: RegisterRow, asOf: LocalDate, s: FirmSettings): InstanceRow {
  const { status, overdueDays } = engine.deriveStatus(row, asOf, s);
  return { ...row, status, overdueDays };
}

export function scoreInput(row: RegisterRow): ScoreInput {
  return {
    instanceId: row.id,
    criticality: row.criticality,
    dueDate: row.dueDate,
    workflowState: row.workflowState,
    pendingKind: row.pendingKind,
    completedOn: row.completedOn,
  };
}

export interface LoadedRows {
  rows: InstanceRow[];
  asOf: LocalDate;
  settings: FirmSettings;
}

/**
 * The client's rows the actor may see for `action`, with status at `asOf`. The store query is limited to the
 * actor's units; each row is then checked with `can()` too, so a store bug cannot widen access.
 */
export async function loadRows(
  store: ReportsStore,
  ctx: RequestContext,
  client: ClientInfo,
  filter: RowFilter,
  asOf: LocalDate,
  action: Action,
): Promise<LoadedRows> {
  const settings = await store.firmSettings(ctx);
  const stored = await store.registerRows(ctx, client.id, filter);
  const rows = stored
    .filter((r) => can(ctx, action, { type: 'instance', clientId: client.id, unitId: r.unitId }))
    .map((r) => withStatus(r, asOf, settings));
  return { rows, asOf, settings };
}

/** The client, or NOT_FOUND when it is archived, in another firm or outside the actor's clients. */
export async function requireClientInfo(
  store: ReportsStore,
  ctx: RequestContext,
  clientId: string,
): Promise<ClientInfo> {
  const [client] = ctx.clientIds.includes(clientId) ? await store.clients(ctx, [clientId]) : [];
  if (client === undefined) throw new ApiError('NOT_FOUND');
  return client;
}

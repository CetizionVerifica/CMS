import type { ExportJob, FirmSettings, RequestContext } from '@canopy/contracts';
import {
  auditEvents,
  clients,
  DbError,
  exportJobs,
  firms,
  instances,
  tenantFromRequest,
  units,
  type Database,
  type RegisterFilter,
  type RegisterRow,
  type TenantTx,
} from '@canopy/db';
import { ApiError } from '../../auth/index.js';
import type {
  ClientInfo,
  ExportDetail,
  NewExportJob,
  ReportsStore,
  RowFilter,
  UnitInfo,
} from './ports.js';

/**
 * M10's `ReportsStore` over M3's repositories (docs/adr/M10-0001-dashboards-and-reports.md §2). Every call runs
 * in `withTenant` for the request's context, so row-level security decides what it sees; M10 builds no SQL.
 */

/** The register's page size cap (M3 MAX_LIMIT). A store read collects every page. */
const PAGE = 200;
/** `instances.exportDetails` takes at most this many ids per call. */
const DETAIL_CHUNK = 10_000;

/** Repository errors carry contract codes; their messages name tables, so callers get the default text. */
function toApiError(error: unknown): never {
  if (error instanceof DbError) throw new ApiError(error.code);
  throw error;
}

/** The M3 register filter for a resolved M10 filter, or null when a list filter is empty (nothing matches). */
export function registerFilter(filter: RowFilter): RegisterFilter | null {
  const lists = [filter.criticality, filter.workflowState, filter.domain];
  if (lists.some((list) => list !== undefined && list.length === 0)) return null;
  const copy = <T>(list: readonly T[] | undefined) => (list === undefined ? undefined : [...list]);
  return {
    unitIds: copy(filter.unitIds),
    departmentIds: copy(filter.departmentIds),
    actIds: copy(filter.actIds),
    categoryIds: copy(filter.categoryIds),
    ownerId: filter.ownerId,
    approverId: filter.approverId,
    criticality: copy(filter.criticality),
    workflowState: copy(filter.workflowState),
    timelineType: filter.timelineType,
    domain: copy(filter.domain),
    dueFrom: filter.dueFrom,
    dueTo: filter.dueTo,
    completedFrom: filter.completedFrom,
    completedTo: filter.completedTo,
    hasEvidence: filter.hasEvidence,
    q: filter.q,
  };
}

export class PostgresReportsStore implements ReportsStore {
  constructor(private readonly db: Database) {}

  private run<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.db.withTenant(tenantFromRequest(ctx), fn).catch(toApiError);
  }

  firmSettings(ctx: RequestContext): Promise<FirmSettings> {
    return this.run(ctx, async (tx) => (await firms.current(tx)).settings);
  }

  clients(ctx: RequestContext, clientIds: readonly string[]): Promise<ClientInfo[]> {
    if (clientIds.length === 0) return Promise.resolve([]);
    return this.run(ctx, async (tx) => {
      const rows = await clients.findAll(tx, { id: [...clientIds] });
      return rows
        .map((c) => ({ id: c.id, name: c.name, settings: c.settings }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    });
  }

  unit(ctx: RequestContext, clientId: string, unitId: string): Promise<UnitInfo | null> {
    return this.run(ctx, async (tx) => {
      const found = await units.withLabels(tx, unitId);
      if (found === null || found.unit.clientId !== clientId || found.unit.archivedAt !== null) {
        return null;
      }
      return {
        id: found.unit.id,
        name: found.unit.name,
        companyName: found.companyName,
        locationLabel: found.locationLabel,
      };
    });
  }

  registerRows(ctx: RequestContext, clientId: string, filter: RowFilter): Promise<RegisterRow[]> {
    const f = registerFilter(filter);
    if (f === null) return Promise.resolve([]);
    return this.run(ctx, async (tx) => {
      const rows: RegisterRow[] = [];
      let cursor: string | null = null;
      do {
        const page = await instances.register(tx, clientId, f, { limit: PAGE, cursor });
        rows.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return rows;
    });
  }

  exportDetails(
    ctx: RequestContext,
    clientId: string,
    instanceIds: readonly string[],
  ): Promise<Map<string, ExportDetail>> {
    return this.run(ctx, async (tx) => {
      const details = new Map<string, ExportDetail>();
      for (let start = 0; start < instanceIds.length; start += DETAIL_CHUNK) {
        const chunk = instanceIds.slice(start, start + DETAIL_CHUNK);
        for (const d of await instances.exportDetails(tx, chunk)) {
          details.set(d.instanceId, {
            description: d.description,
            applicabilityText: d.applicabilityText,
            naReason: d.naReason,
            firstComment: d.firstComment,
          });
        }
      }
      return details;
    });
  }

  lastActivity(
    ctx: RequestContext,
    clientIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    return this.run(ctx, async (tx) => {
      const latest = new Map((await auditEvents.latestByClient(tx)).map((r) => [r.clientId, r.at]));
      return new Map(clientIds.map((id) => [id, latest.get(id) ?? null]));
    });
  }

  createExportJob(ctx: RequestContext, job: NewExportJob): Promise<ExportJob> {
    return this.run(ctx, async (tx) => {
      const created = await exportJobs.create(tx, {
        clientId: job.clientId,
        kind: job.kind,
        params: job.params,
        requestedById: ctx.personId,
      });
      await auditEvents.append(tx, {
        clientId: job.clientId,
        requestId: ctx.requestId,
        actorId: ctx.personId,
        actorKind: 'PERSON',
        action: 'EXPORT',
        entityType: 'export',
        entityId: created.id,
        before: null,
        after: { kind: job.kind, params: job.params },
        reason: null,
      });
      return created;
    });
  }

  getExportJob(ctx: RequestContext, id: string): Promise<ExportJob | null> {
    return this.run(ctx, (tx) => exportJobs.get(tx, id));
  }

  setExportStatus(
    ctx: RequestContext,
    id: string,
    patch: Pick<ExportJob, 'status'> & { fileName?: string | null; storageKey?: string | null },
  ): Promise<ExportJob> {
    return this.run(ctx, (tx) => exportJobs.setStatus(tx, id, patch));
  }

  exportStorageKey(ctx: RequestContext, id: string): Promise<string | null> {
    return this.run(ctx, (tx) => exportJobs.storageKey(tx, id));
  }
}

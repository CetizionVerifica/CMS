import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FIRM_SETTINGS,
  ExportJob,
  type FirmSettings,
  type ObligationDomain,
  type RequestContext,
} from '@canopy/contracts';
import type { RegisterRow } from '@canopy/db';
import { ApiError } from '../../auth/index.js';
import type {
  ArchiveEvidence,
  ClientInfo,
  ExportDetail,
  NewExportJob,
  ReportsStore,
  RowFilter,
  UnitInfo,
} from './ports.js';

/** A stored instance with the columns the filters and the register export read. */
export interface MemoryRow extends RegisterRow, ExportDetail {
  firmId: string;
  categoryId: string;
  domain: ObligationDomain;
  /** All comments, oldest first; `lastComment` and `firstComment` must agree with it. */
  comments: string[];
}

export interface MemoryAuditEvent {
  firmId: string;
  clientId: string;
  at: string;
  actorId: string;
  action: 'EXPORT';
  entityType: 'export';
  entityId: string;
  after: Record<string, unknown>;
}

interface StoredJob extends ExportJob {
  storageKey: string | null;
}

/**
 * In-memory `ReportsStore` for tests and local runs before the Postgres adapter. It mimics RLS: every read
 * is limited to `ctx.firmId`, and client-level reads to the ids the caller passes (already scoped).
 */
export class MemoryReportsStore implements ReportsStore {
  readonly firms = new Map<string, FirmSettings>();
  readonly clientsById = new Map<string, ClientInfo & { firmId: string; archived?: boolean }>();
  readonly units = new Map<string, UnitInfo & { firmId: string; clientId: string }>();
  readonly rows: MemoryRow[] = [];
  readonly audit: MemoryAuditEvent[] = [];
  readonly jobs = new Map<string, StoredJob>();
  /** Evidence rows, as the evidence table holds them. */
  readonly evidence: (ArchiveEvidence & {
    firmId: string;
    clientId: string;
    scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';
    archived?: boolean;
  })[] = [];
  /** Fails the next export status update, to test job failure handling. */
  failNextStatusUpdate = false;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async firmSettings(ctx: RequestContext): Promise<FirmSettings> {
    return this.firms.get(ctx.firmId) ?? DEFAULT_FIRM_SETTINGS;
  }

  async clients(ctx: RequestContext, clientIds: readonly string[]): Promise<ClientInfo[]> {
    const wanted = new Set(clientIds);
    return [...this.clientsById.values()]
      .filter((c) => c.firmId === ctx.firmId && !c.archived && wanted.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id))
      .map(({ id, name, settings }) => ({ id, name, settings }));
  }

  async unit(ctx: RequestContext, clientId: string, unitId: string): Promise<UnitInfo | null> {
    const unit = this.units.get(unitId);
    if (!unit || unit.firmId !== ctx.firmId || unit.clientId !== clientId) return null;
    return without(unit, ['firmId', 'clientId']);
  }

  async registerRows(
    ctx: RequestContext,
    clientId: string,
    filter: RowFilter,
  ): Promise<RegisterRow[]> {
    return this.rows
      .filter((r) => r.firmId === ctx.firmId && r.clientId === clientId && matches(r, filter))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id))
      .map(toRegisterRow);
  }

  async exportDetails(
    ctx: RequestContext,
    clientId: string,
    instanceIds: readonly string[],
  ): Promise<Map<string, ExportDetail>> {
    const wanted = new Set(instanceIds);
    const out = new Map<string, ExportDetail>();
    for (const r of this.rows) {
      if (r.firmId !== ctx.firmId || r.clientId !== clientId || !wanted.has(r.id)) continue;
      out.set(r.id, {
        description: r.description,
        applicabilityText: r.applicabilityText,
        naReason: r.naReason,
        firstComment: r.firstComment,
      });
    }
    return out;
  }

  async archiveEvidence(
    ctx: RequestContext,
    clientId: string,
  ): Promise<{ clean: ArchiveEvidence[]; withheld: number }> {
    const live = this.evidence.filter(
      (e) => e.firmId === ctx.firmId && e.clientId === clientId && !e.archived,
    );
    return {
      clean: live
        .filter((e) => e.scanStatus === 'CLEAN')
        .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt) || a.id.localeCompare(b.id))
        .map((e) => without(e, ['firmId', 'clientId', 'scanStatus', 'archived'])),
      withheld: live.filter((e) => e.scanStatus !== 'CLEAN').length,
    };
  }

  async lastActivity(
    ctx: RequestContext,
    clientIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>(clientIds.map((id) => [id, null]));
    for (const e of this.audit) {
      if (e.firmId !== ctx.firmId || !out.has(e.clientId)) continue;
      const current = out.get(e.clientId) ?? null;
      if (current === null || e.at > current) out.set(e.clientId, e.at);
    }
    return out;
  }

  async createExportJob(ctx: RequestContext, job: NewExportJob): Promise<ExportJob> {
    const now = this.clock().toISOString();
    const stored: StoredJob = {
      id: randomUUID(),
      firmId: ctx.firmId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      clientId: job.clientId,
      kind: job.kind,
      params: job.params,
      status: 'QUEUED',
      fileName: null,
      requestedById: ctx.personId,
      storageKey: null,
    };
    this.jobs.set(stored.id, stored);
    this.audit.push({
      firmId: ctx.firmId,
      clientId: job.clientId,
      at: now,
      actorId: ctx.personId,
      action: 'EXPORT',
      entityType: 'export',
      entityId: stored.id,
      after: { kind: job.kind, params: job.params },
    });
    return toJob(stored);
  }

  async getExportJob(ctx: RequestContext, id: string): Promise<ExportJob | null> {
    const job = this.jobs.get(id);
    return job && job.firmId === ctx.firmId ? toJob(job) : null;
  }

  async setExportStatus(
    ctx: RequestContext,
    id: string,
    patch: Pick<ExportJob, 'status'> & { fileName?: string | null; storageKey?: string | null },
  ): Promise<ExportJob> {
    if (this.failNextStatusUpdate) {
      this.failNextStatusUpdate = false;
      throw new Error('store unavailable');
    }
    const job = this.jobs.get(id);
    if (!job || job.firmId !== ctx.firmId) throw new ApiError('NOT_FOUND');
    Object.assign(job, patch, { updatedAt: this.clock().toISOString() });
    return toJob(job);
  }

  async exportStorageKey(ctx: RequestContext, id: string): Promise<string | null> {
    const job = this.jobs.get(id);
    return job && job.firmId === ctx.firmId ? job.storageKey : null;
  }
}

function toJob(job: StoredJob): ExportJob {
  return ExportJob.parse(without(job, ['storageKey']));
}

/** A copy of `value` without `keys`. */
function without<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

/** The columns that are not part of a register row. */
const STORE_ONLY = [
  'firmId',
  'categoryId',
  'domain',
  'comments',
  'description',
  'applicabilityText',
  'naReason',
  'firstComment',
] as const;

function toRegisterRow(r: MemoryRow): RegisterRow {
  return without(r, STORE_ONLY);
}

const among = <T>(values: readonly T[] | undefined, value: T): boolean =>
  values === undefined || values.includes(value);

/** The register filters as the database applies them (packages/db `registerConditions`). */
function matches(r: MemoryRow, f: RowFilter): boolean {
  const q = f.q?.toLowerCase();
  return (
    among(f.unitIds, r.unitId) &&
    among(f.departmentIds, r.departmentId) &&
    among(f.actIds, r.actId) &&
    among(f.categoryIds, r.categoryId) &&
    (f.ownerId === undefined || r.ownerId === f.ownerId) &&
    (f.approverId === undefined || r.approverId === f.approverId) &&
    among(f.criticality, r.criticality) &&
    among(f.workflowState, r.workflowState) &&
    (f.timelineType === undefined || r.timelineType === f.timelineType) &&
    among(f.domain, r.domain) &&
    (f.dueFrom === undefined || r.dueDate >= f.dueFrom) &&
    (f.dueTo === undefined || r.dueDate <= f.dueTo) &&
    (f.completedFrom === undefined ||
      (r.completedOn !== null && r.completedOn >= f.completedFrom)) &&
    (f.completedTo === undefined || (r.completedOn !== null && r.completedOn <= f.completedTo)) &&
    (f.hasEvidence === undefined || r.evidenceCount > 0 === f.hasEvidence) &&
    (q === undefined ||
      [r.title, r.externalRef ?? '', r.actName, ...r.comments].some((text) =>
        text.toLowerCase().includes(q),
      ))
  );
}

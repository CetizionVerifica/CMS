import {
  ExportCreateBody,
  RegisterFilterQuery,
  type Breakdown,
  type ExportJob,
  type ExportKind,
  type InstanceRow,
  LocalDate,
  type RequestContext,
  type ScoreResult,
  type SignedUrl,
} from '@canopy/contracts';
import { compareDates, computeScore, fyRangeOf } from '@canopy/engine';
import { z } from 'zod';
import { ApiError, can } from '../../auth/index.js';
import type { ClientInfo, RowFilter, UnitInfo } from '../dashboard/ports.js';
import {
  loadRows,
  requireClientInfo,
  resolveAsOf,
  resolvePeriod,
  scopedUnits,
  scoreInput,
  type LoadedRows,
  type Period,
} from '../dashboard/scope.js';
import {
  breakdown,
  breakdownOf,
  clientRows,
  type DashboardDeps,
  type DashboardQueryInput,
} from '../dashboard/service.js';
import { clientArchive, type ArchiveInstance } from './archive.js';
import { certificatePdf } from './certificate-pdf.js';
import type { ExportFiles } from './files.js';
import { registerWorkbook } from './register-xlsx.js';
import { breakdownWorkbook, overdueWorkbook, type ReportHeading } from './report-xlsx.js';

/** Act-wise, department-wise and overdue reports, and Excel/PDF exports (docs/contracts/endpoints.md §6). */

/** Runs export work off the request. The default runs it in this process; a pg-boss worker can replace it. */
export interface ExportRunner {
  run(task: () => Promise<void>): void;
}

/** Runs tasks in this process after the response; `idle()` waits for them (tests, graceful shutdown). */
export class InProcessRunner implements ExportRunner {
  private readonly pending = new Set<Promise<void>>();

  run(task: () => Promise<void>): void {
    const promise = new Promise<void>((resolve) => setImmediate(resolve)).then(task);
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

export interface ReportsDeps extends DashboardDeps {
  files: ExportFiles;
  runner: ExportRunner;
  /** Remembers Idempotency-Key responses for 24 hours (api-conventions.md §2). */
  idempotency: IdempotencyCache;
  /** Logs an export failure. Gets ids and an error name only, never file contents or names. */
  onExportError?: (info: { jobId: string; kind: ExportKind; error: string }) => void;
  /** Export requests allowed per client IP per window; defaults to EXPORT_RATE_LIMIT. */
  exportRateLimit?: { max: number; timeWindow: string | number };
}

// ---------- reports ----------

export async function actReport(
  deps: DashboardDeps,
  ctx: RequestContext,
  clientId: string,
  query: DashboardQueryInput,
): Promise<Breakdown> {
  return breakdown(deps, ctx, clientId, { ...query, by: 'act' }, 'report.read');
}

export async function departmentReport(
  deps: DashboardDeps,
  ctx: RequestContext,
  clientId: string,
  query: DashboardQueryInput,
): Promise<Breakdown> {
  return breakdown(deps, ctx, clientId, { ...query, by: 'department' }, 'report.read');
}

/** Overdue rows, most overdue first (then by due date and title). */
export function overdueRows(rows: readonly InstanceRow[]): InstanceRow[] {
  return rows
    .filter((r) => r.status === 'OVERDUE')
    .sort(
      (a, b) =>
        (b.overdueDays ?? 0) - (a.overdueDays ?? 0) ||
        compareDates(a.dueDate, b.dueDate) ||
        a.title.localeCompare(b.title, 'en') ||
        a.id.localeCompare(b.id),
    );
}

function scoreOf(loaded: LoadedRows): ScoreResult {
  return computeScore(loaded.rows.map(scoreInput), loaded.asOf, loaded.settings);
}

export async function overdueReport(
  deps: DashboardDeps,
  ctx: RequestContext,
  clientId: string,
  query: DashboardQueryInput,
): Promise<{ result: ScoreResult; items: InstanceRow[] }> {
  const loaded = await clientRows(deps, ctx, clientId, query, 'report.read');
  return { result: scoreOf(loaded), items: overdueRows(loaded.rows) };
}

// ---------- idempotency ----------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * First responses by (firm, person, Idempotency-Key), kept 24 hours with the request they answered (client
 * and body). In memory: one API process in v1.
 */
export class IdempotencyCache {
  private readonly entries = new Map<string, { at: number; request: string; job: ExportJob }>();

  get(key: string, now: Date): { request: string; job: ExportJob } | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (now.getTime() - entry.at >= DAY_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, request: string, job: ExportJob, now: Date): void {
    for (const [k, entry] of this.entries) {
      if (now.getTime() - entry.at >= DAY_MS) this.entries.delete(k);
    }
    this.entries.set(key, { at: now.getTime(), request, job });
  }
}

export const IdempotencyKey = z.uuid();

// ---------- exports ----------

/** What a job stores in `params`: the request as given, plus the `asOf` it was resolved at. */
export const ExportParams = z.strictObject({
  filters: z.string(),
  unitId: z.string().nullable(),
  fy: z.string().nullable(),
  asOf: LocalDate,
});
export type ExportParams = z.infer<typeof ExportParams>;

type RegisterQueryOutput = z.output<typeof RegisterFilterQuery>;

function parseFilters(filters: string): RegisterQueryOutput {
  return RegisterFilterQuery.parse(Object.fromEntries(new URLSearchParams(filters)));
}

const hasPeriod = (q: RegisterQueryOutput) =>
  q.fy !== undefined || q.dueFrom !== undefined || q.dueTo !== undefined;

/** Kinds that cover one period, the current FY unless one is given. The register export covers all dates. */
const PERIOD_KINDS: ReadonlySet<ExportKind> = new Set([
  'CERTIFICATE_PDF',
  'ACT_REPORT_XLSX',
  'DEPARTMENT_REPORT_XLSX',
  'OVERDUE_REPORT_XLSX',
]);

function validation(path: string, message: string): ApiError {
  return new ApiError('VALIDATION', { issues: [{ path: [path], message }] });
}

/** The single unit a certificate is for: the body's `unitId`, else a one-unit `unitId` filter. */
function certificateUnit(params: ExportParams, query: RegisterQueryOutput): string | null {
  if (params.unitId !== null) return params.unitId;
  return query.unitId?.length === 1 ? query.unitId[0]! : null;
}

export async function createExport(
  deps: ReportsDeps,
  ctx: RequestContext,
  clientId: string,
  body: z.output<typeof ExportCreateBody>,
  idempotencyKey: string | undefined,
): Promise<ExportJob> {
  const cacheKey =
    idempotencyKey === undefined ? undefined : `${ctx.firmId}/${ctx.personId}/${idempotencyKey}`;
  const request = JSON.stringify([
    clientId,
    body.kind,
    body.filters,
    body.unitId ?? null,
    body.fy ?? null,
  ]);
  const now = deps.clock();
  const cached = cacheKey === undefined ? undefined : deps.idempotency.get(cacheKey, now);
  if (cached !== undefined) {
    // A key reused for another client or request is a client bug: refuse it rather than answer with a
    // different job.
    if (cached.request !== request) {
      throw validation('Idempotency-Key', 'This key was used for a different export request');
    }
    return cached.job;
  }

  if (body.kind === 'CLIENT_ARCHIVE_ZIP') {
    // The account export: the whole client, for account admins only (endpoints.md §6).
    if (!ctx.memberships.some((m) => m.role === 'FIRM_ADMIN')) {
      throw new ApiError('FORBIDDEN', { action: 'export.create' });
    }
    if (body.filters !== '' || body.unitId !== undefined || body.fy !== undefined) {
      throw validation(
        'kind',
        'A client archive covers the whole client: send no filters, unitId or fy',
      );
    }
  }
  const client = await requireClientInfo(deps.store, ctx, clientId);
  const query = parseFilters(body.filters);
  if (body.fy !== undefined && hasPeriod(query)) {
    throw validation('fy', 'Use fy or a period in filters, not both');
  }
  const asOf = resolveAsOf(ctx, client, query.asOf, now, 'export.create');
  const params: ExportParams = {
    filters: body.filters,
    unitId: body.unitId ?? null,
    fy: body.fy ?? null,
    asOf,
  };
  if (params.unitId !== null) await requireUnit(deps, ctx, clientId, params.unitId);
  if (body.kind === 'CERTIFICATE_PDF') {
    const unitId = certificateUnit(params, query);
    if (unitId === null) throw validation('unitId', 'A certificate is for one unit');
    await requireUnit(deps, ctx, clientId, unitId);
  }

  const job = await deps.store.createExportJob(ctx, { clientId, kind: body.kind, params });
  if (cacheKey !== undefined) deps.idempotency.set(cacheKey, request, job, now);
  deps.runner.run(() => runExport(deps, ctx, job));
  return job;
}

/** NOT_FOUND unless the unit is in the client and the actor's scope. */
async function requireUnit(
  deps: DashboardDeps,
  ctx: RequestContext,
  clientId: string,
  unitId: string,
): Promise<UnitInfo> {
  const unit = await deps.store.unit(ctx, clientId, unitId);
  if (unit === null || !can(ctx, 'export.create', { type: 'unit', clientId, unitId })) {
    throw new ApiError('NOT_FOUND');
  }
  return unit;
}

/** A job the actor requested; anyone else's job is NOT_FOUND (it may cover units they cannot see). */
async function requireOwnJob(
  deps: DashboardDeps,
  ctx: RequestContext,
  id: string,
): Promise<ExportJob> {
  const job = await deps.store.getExportJob(ctx, id);
  if (job === null || job.requestedById !== ctx.personId || !ctx.clientIds.includes(job.clientId)) {
    throw new ApiError('NOT_FOUND');
  }
  if (!can(ctx, 'export.read', { type: 'client', clientId: job.clientId })) {
    throw new ApiError('FORBIDDEN', { action: 'export.read' });
  }
  return job;
}

export async function getExport(
  deps: DashboardDeps,
  ctx: RequestContext,
  id: string,
): Promise<ExportJob> {
  return requireOwnJob(deps, ctx, id);
}

export async function exportDownloadUrl(
  deps: ReportsDeps,
  ctx: RequestContext,
  id: string,
): Promise<SignedUrl> {
  const job = await requireOwnJob(deps, ctx, id);
  const key = job.status === 'DONE' ? await deps.store.exportStorageKey(ctx, id) : null;
  if (key === null || job.fileName === null) {
    throw new ApiError('NOT_FOUND', undefined, 'The export is not ready.');
  }
  return deps.files.signedUrl(key, job.fileName, deps.clock());
}

// ---------- building the files ----------

interface ExportScope extends LoadedRows {
  client: ClientInfo;
  period: Period;
}

function periodOf(
  params: ExportParams,
  query: RegisterQueryOutput,
  client: ClientInfo,
  kind: ExportKind,
): Period {
  const fyStartMonth = client.settings.fyStartMonth;
  if (query.fy !== undefined) return { ...fyRangeOf(query.fy, fyStartMonth), fy: query.fy };
  if (query.dueFrom !== undefined || query.dueTo !== undefined) {
    return resolvePeriod({ from: query.dueFrom, to: query.dueTo }, params.asOf, fyStartMonth);
  }
  if (params.fy !== null || PERIOD_KINDS.has(kind)) {
    return resolvePeriod(params.fy === null ? {} : { fy: params.fy }, params.asOf, fyStartMonth);
  }
  return { from: null, to: null, fy: null };
}

function rowFilter(
  ctx: RequestContext,
  client: ClientInfo,
  params: ExportParams,
  query: RegisterQueryOutput,
  period: Period,
): RowFilter {
  const requested =
    params.unitId === null
      ? query.unitId
      : (query.unitId ?? [params.unitId]).filter((id) => id === params.unitId);
  const unitIds = scopedUnits(ctx, client.id, requested);
  const person = (ref: string | undefined) => (ref === 'me' ? ctx.personId : ref);
  const filter: RowFilter = {
    unitIds,
    departmentIds: query.departmentId,
    actIds: query.actId,
    categoryIds: query.categoryId,
    ownerId: person(query.ownerId),
    approverId: person(query.approverId),
    criticality: query.criticality,
    workflowState: query.workflowState,
    timelineType: query.timelineType,
    domain: query.domain,
    dueFrom: period.from ?? undefined,
    dueTo: period.to ?? undefined,
    completedFrom: query.completedFrom,
    completedTo: query.completedTo,
    hasEvidence: query.hasEvidence,
    q: query.q,
  };
  return Object.fromEntries(
    Object.entries(filter).filter(([, value]) => value !== undefined),
  ) as RowFilter;
}

async function exportScope(
  deps: DashboardDeps,
  ctx: RequestContext,
  job: ExportJob,
): Promise<ExportScope & { params: ExportParams; query: RegisterQueryOutput }> {
  const params = ExportParams.parse(job.params);
  const query = parseFilters(params.filters);
  const client = await requireClientInfo(deps.store, ctx, job.clientId);
  const period = periodOf(params, query, client, job.kind);
  const loaded = await loadRows(
    deps.store,
    ctx,
    client,
    rowFilter(ctx, client, params, query, period),
    params.asOf,
    'export.create',
  );
  const statuses = query.status;
  const rows =
    statuses === undefined ? loaded.rows : loaded.rows.filter((r) => statuses.includes(r.status));
  return { ...loaded, rows, client, period, params, query };
}

export function periodLabel(period: Period): string {
  if (period.fy !== null) return `FY ${period.fy}`;
  if (period.from !== null && period.to !== null) return `${period.from} to ${period.to}`;
  if (period.from !== null) return `From ${period.from}`;
  if (period.to !== null) return `Until ${period.to}`;
  return 'All dates';
}

function periodSlug(period: Period): string {
  if (period.fy !== null) return `fy-${period.fy}`;
  if (period.from === null && period.to === null) return 'all-dates';
  return `${period.from ?? 'start'}-to-${period.to ?? 'end'}`;
}

/** File names carry no personal data: kind, unit (for certificates) and period only. */
export function slug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unit'
  );
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface BuiltFile {
  bytes: Uint8Array;
  fileName: string;
  contentType: string;
}

async function buildFile(
  deps: DashboardDeps,
  ctx: RequestContext,
  job: ExportJob,
): Promise<BuiltFile> {
  const scope = await exportScope(deps, ctx, job);
  const { client, period, rows } = scope;
  const heading = (title: string): ReportHeading => ({
    title,
    clientName: client.name,
    periodLabel: periodLabel(period),
    asOf: scope.asOf,
  });
  const span = periodSlug(period);
  switch (job.kind) {
    case 'REGISTER_XLSX': {
      const details = await deps.store.exportDetails(
        ctx,
        client.id,
        rows.map((r) => r.id),
      );
      const sheetRows = rows.map((row) => {
        const detail = details.get(row.id);
        if (detail === undefined) throw new Error('Export detail missing for an instance');
        return { row, detail };
      });
      return {
        bytes: await registerWorkbook(client.name, sheetRows),
        fileName: `compliance-register-${span}.xlsx`,
        contentType: XLSX,
      };
    }
    case 'ACT_REPORT_XLSX':
    case 'DEPARTMENT_REPORT_XLSX': {
      const act = job.kind === 'ACT_REPORT_XLSX';
      return {
        bytes: await breakdownWorkbook(
          heading(act ? 'Act-wise report' : 'Department-wise report'),
          act ? 'Act' : 'Department',
          breakdownOf(act ? 'act' : 'department', scope),
          scoreOf(scope),
        ),
        fileName: `${act ? 'act' : 'department'}-wise-report-${span}.xlsx`,
        contentType: XLSX,
      };
    }
    case 'OVERDUE_REPORT_XLSX':
      return {
        bytes: await overdueWorkbook(heading('Overdue report'), scoreOf(scope), overdueRows(rows)),
        fileName: `overdue-report-${span}.xlsx`,
        contentType: XLSX,
      };
    case 'CERTIFICATE_PDF': {
      const unitId = certificateUnit(scope.params, scope.query);
      const unit = unitId === null ? null : await deps.store.unit(ctx, client.id, unitId);
      if (unit === null) throw new Error('Certificate unit not found');
      return {
        bytes: await certificatePdf({
          clientName: client.name,
          companyName: unit.companyName,
          unitName: unit.name,
          locationLabel: unit.locationLabel,
          periodLabel: periodLabel(period),
          asOf: scope.asOf,
          generatedAt: deps.clock().toISOString(),
          timeZone: client.settings.timeZone,
          result: scoreOf(scope),
          byAct: breakdownOf('act', scope),
          overdue: overdueRows(rows),
        }),
        fileName: `compliance-certificate-${slug(unit.name)}-${span}.pdf`,
        contentType: 'application/pdf',
      };
    }
    case 'CLIENT_ARCHIVE_ZIP':
      // Streamed by `storeArchive`, never built in memory.
      throw new Error('The client archive is streamed');
  }
}

const ZIP = 'application/zip';

/** The client archive: the whole register and the clean evidence, streamed into storage (ADR M10-0002). */
async function storeArchive(
  deps: ReportsDeps,
  ctx: RequestContext,
  job: ExportJob,
  storageKey: (fileName: string) => string,
): Promise<string> {
  const scope = await exportScope(deps, ctx, job);
  const { client, rows } = scope;
  const details = await deps.store.exportDetails(
    ctx,
    client.id,
    rows.map((r) => r.id),
  );
  const register = await registerWorkbook(
    client.name,
    rows.map((row) => {
      const detail = details.get(row.id);
      if (detail === undefined) throw new Error('Export detail missing for an instance');
      return { row, detail };
    }),
  );
  const { clean, withheld } = await deps.store.archiveEvidence(ctx, client.id);
  const instances = new Map<string, ArchiveInstance>(
    rows.map((r) => [r.id, { dueDate: r.dueDate, title: r.title, unitName: r.unitName }]),
  );
  const generatedAt = deps.clock().toISOString();
  const fileName = `client-archive-${slug(client.name)}-${generatedAt.slice(0, 10)}.zip`;
  const archive = clientArchive({
    clientName: client.name,
    register,
    evidence: clean,
    withheld,
    instances,
    open: (key) => deps.files.open(key),
    generatedAt,
  });
  await deps.files.putStream(storageKey(fileName), archive, ZIP);
  return fileName;
}

/** Builds and stores the file, then marks the job DONE; any failure marks it FAILED. Never throws. */
export async function runExport(
  deps: ReportsDeps,
  ctx: RequestContext,
  job: ExportJob,
): Promise<void> {
  try {
    await deps.store.setExportStatus(ctx, job.id, { status: 'RUNNING' });
    const keyOf = (fileName: string) =>
      `exports/${ctx.firmId}/${job.clientId}/${job.id}/${fileName}`;
    let fileName: string;
    if (job.kind === 'CLIENT_ARCHIVE_ZIP') {
      fileName = await storeArchive(deps, ctx, job, keyOf);
    } else {
      const file = await buildFile(deps, ctx, job);
      fileName = file.fileName;
      await deps.files.put(keyOf(fileName), file.bytes, file.contentType);
    }
    await deps.store.setExportStatus(ctx, job.id, {
      status: 'DONE',
      fileName,
      storageKey: keyOf(fileName),
    });
  } catch (error) {
    deps.onExportError?.({
      jobId: job.id,
      kind: job.kind,
      error: error instanceof Error ? error.name : 'Error',
    });
    await deps.store.setExportStatus(ctx, job.id, { status: 'FAILED' }).catch(() => undefined);
  }
}

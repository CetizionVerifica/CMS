import {
  ExportCreateBody,
  RegisterFilterQuery,
  type Breakdown,
  type ExportJob,
  type ExportKind,
  type InstanceRow,
  ISO_EXPORT_FILTERS,
  ISO_EXPORT_KINDS,
  type IsoExportKind,
  LocalDate,
  type RequestContext,
  type ScoreResult,
  type SignedUrl,
} from '@canopy/contracts';
import { compareDates, computeScore, fyRangeOf, localDateIn } from '@canopy/engine';
import { z } from 'zod';
import { ApiError, can } from '../../auth/index.js';
import type { ClientInfo, RowFilter, UnitInfo } from '../dashboard/ports.js';
import {
  ISO_FEATURE,
  isoOn,
  loadRows,
  requireClientInfo,
  resolveAsOf,
  resolvePeriod,
  scopedUnits,
  scoreInput,
  sourceKinds,
  STATUTORY,
  unitScope,
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
import { clientArchive, type ArchiveInstance, type ClientArchiveInput } from './archive.js';
import { auditReportPdf } from './audit-report-pdf.js';
import { certificatePdf } from './certificate-pdf.js';
import { packInputs, reviewFigureRefs, reviewPackPdf } from './review-pack-pdf.js';
import { isoRecordsWorkbook } from './iso-archive.js';
import type { ExportFiles } from './files.js';
import {
  filterWords,
  ncLogRows,
  ncLogWorkbook,
  riskRegisterRows,
  riskRegisterWorkbook,
  type IsoHeading,
} from './iso-registers.js';
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

/**
 * The kinds this module builds. A kind that joins `ExportKind` before M10 builds it (the ISO PDFs until ISO-11d's
 * later parts) is refused at create, after the add-on check, and `buildFile`'s default branch fails any such job
 * already queued.
 */
const BUILT_KINDS: ReadonlySet<ExportKind> = new Set([
  'REGISTER_XLSX',
  'ACT_REPORT_XLSX',
  'DEPARTMENT_REPORT_XLSX',
  'OVERDUE_REPORT_XLSX',
  'CERTIFICATE_PDF',
  'CLIENT_ARCHIVE_ZIP',
  'ISO_NC_LOG_XLSX',
  'ISO_RISK_REGISTER_XLSX',
  'ISO_AUDIT_REPORT_PDF',
  'ISO_REVIEW_PACK_PDF',
]);

/** The ISO export kinds are ISO data (docs/iso/plan.md §4.4). */
const isIsoKind = (kind: ExportKind): boolean =>
  (ISO_EXPORT_KINDS as readonly string[]).includes(kind);

const isIsoKindJob = (job: ExportJob): job is ExportJob & { kind: IsoExportKind } =>
  isIsoKind(job.kind);

const featureNotEnabled = () => new ApiError('FEATURE_NOT_ENABLED', { feature: ISO_FEATURE });

/**
 * 403 `FEATURE_NOT_ENABLED` for an ISO export kind while the add-on is off: creating one, reading its job and its
 * download URL (endpoints.md §6, docs/iso/plan.md §4.5). Called after the role check, so an actor who may not export
 * learns nothing of the switch.
 */
async function refuseIsoKindWhenOff(ctx: RequestContext, kind: ExportKind): Promise<void> {
  if (isIsoKind(kind) && !(await isoOn(ctx))) throw featureNotEnabled();
}

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
  await refuseIsoKindWhenOff(ctx, body.kind);
  if (!BUILT_KINDS.has(body.kind)) throw validation('kind', 'This export kind is not available');
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
  let params: ExportParams;
  if (isIsoKind(body.kind)) {
    // An ISO export takes its list's filters, units included, as of the client's today (docs/iso/model.md §9).
    for (const key of ['unitId', 'fy'] as const) {
      if (body[key] !== undefined) {
        throw validation(key, `An ISO export takes its list's filters, not ${key}`);
      }
    }
    if (!can(ctx, 'export.create', { type: 'client', clientId })) {
      throw new ApiError('FORBIDDEN', { action: 'export.create' });
    }
    const asOf = resolveAsOf(ctx, client, undefined, now, 'export.create');
    params = { filters: body.filters, unitId: null, fy: null, asOf };
    if (body.kind === 'ISO_AUDIT_REPORT_PDF') {
      // NOT_FOUND unless the audit is the client's, live, and the requester may read it (plan §3.3).
      const { internalAuditId } = ISO_EXPORT_FILTERS.ISO_AUDIT_REPORT_PDF.parse(
        Object.fromEntries(new URLSearchParams(body.filters)),
      );
      const book = await deps.store.isoInternalAudit(
        ctx,
        clientId,
        internalAuditId,
        isoScope(ctx, clientId),
      );
      if (book === null) throw new ApiError('NOT_FOUND');
    }
    if (body.kind === 'ISO_REVIEW_PACK_PDF') {
      // Likewise for the review (plan §3.3: its system's units, or its chair or an attendee); no figures yet.
      const { managementReviewId } = ISO_EXPORT_FILTERS.ISO_REVIEW_PACK_PDF.parse(
        Object.fromEntries(new URLSearchParams(body.filters)),
      );
      const book = await deps.store.isoManagementReview(
        ctx,
        clientId,
        managementReviewId,
        isoScope(ctx, clientId),
        null,
      );
      if (book === null) throw new ApiError('NOT_FOUND');
    }
  } else {
    const query = parseFilters(body.filters);
    if (body.fy !== undefined && hasPeriod(query)) {
      throw validation('fy', 'Use fy or a period in filters, not both');
    }
    const asOf = resolveAsOf(ctx, client, query.asOf, now, 'export.create');
    params = { filters: body.filters, unitId: body.unitId ?? null, fy: body.fy ?? null, asOf };
    if (params.unitId !== null) await requireUnit(deps, ctx, clientId, params.unitId);
    if (body.kind === 'CERTIFICATE_PDF') {
      const unitId = certificateUnit(params, query);
      if (unitId === null) throw validation('unitId', 'A certificate is for one unit');
      await requireUnit(deps, ctx, clientId, unitId);
    }
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
  await refuseIsoKindWhenOff(ctx, job.kind);
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
  kinds: Pick<RowFilter, 'actKinds'>,
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
    actKinds: kinds.actKinds,
  };
  return Object.fromEntries(
    Object.entries(filter).filter(([, value]) => value !== undefined),
  ) as RowFilter;
}

/**
 * The act kinds an export reads, with the add-on's state as the worker reads it now: the register export follows the
 * register (`source` while the add-on is on, STATUTE only while it is off); the client archive always holds ISO data
 * (docs/iso/plan.md §4.4); every other kind is a statutory report.
 */
function exportKinds(
  kind: ExportKind,
  query: RegisterQueryOutput,
  iso: boolean,
): Pick<RowFilter, 'actKinds'> {
  if (kind === 'REGISTER_XLSX') return sourceKinds(iso, query.source);
  if (kind === 'CLIENT_ARCHIVE_ZIP') return {};
  return STATUTORY;
}

async function exportScope(
  deps: DashboardDeps,
  ctx: RequestContext,
  job: ExportJob,
  iso: boolean,
): Promise<ExportScope & { params: ExportParams; query: RegisterQueryOutput }> {
  const params = ExportParams.parse(job.params);
  const query = parseFilters(params.filters);
  const client = await requireClientInfo(deps.store, ctx, job.clientId);
  const period = periodOf(params, query, client, job.kind);
  const loaded = await loadRows(
    deps.store,
    ctx,
    client,
    rowFilter(ctx, client, params, query, period, exportKinds(job.kind, query, iso)),
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

/** The requester's ISO unit scope (plan §3.3) as M3 takes it, or null for a reader who sees the whole client. */
function isoScope(ctx: RequestContext, clientId: string) {
  const unitIds = unitScope(ctx, clientId);
  return unitIds === null ? null : { unitIds, personId: ctx.personId };
}

const personRef = (ctx: RequestContext, ref: string | undefined) =>
  ref === 'me' ? ctx.personId : ref;

/** An ISO export, read through M3 with the requester's unit scope when the job runs (docs/iso/model.md §9). */
async function buildIsoFile(
  deps: DashboardDeps,
  ctx: RequestContext,
  job: ExportJob & { kind: IsoExportKind },
): Promise<BuiltFile> {
  const params = ExportParams.parse(job.params);
  const client = await requireClientInfo(deps.store, ctx, job.clientId);
  if (!can(ctx, 'export.create', { type: 'client', clientId: client.id })) {
    throw new ApiError('FORBIDDEN', { action: 'export.create' });
  }
  const settings = await deps.store.firmSettings(ctx);
  const raw = Object.fromEntries(new URLSearchParams(params.filters));
  const scope = isoScope(ctx, client.id);
  const timeZone = client.settings.timeZone;
  const heading = (title: string, filters: IsoHeading['filters']): IsoHeading => ({
    title,
    clientName: client.name,
    asOf: params.asOf,
    filters,
    scoped: scope !== null,
  });
  switch (job.kind) {
    case 'ISO_NC_LOG_XLSX': {
      const query = ISO_EXPORT_FILTERS.ISO_NC_LOG_XLSX.parse(raw);
      const book = await deps.store.isoNonconformities(ctx, client.id, {
        managementSystemIds: query.managementSystemId,
        unitIds: query.unitId,
        state: query.state,
        source: query.source,
        severity: query.severity,
        standards: query.standard,
        ownerId: personRef(ctx, query.ownerId),
        approverId: personRef(ctx, query.approverId),
        scope,
      });
      const rows = ncLogRows(book, query, params.asOf, settings);
      return {
        bytes: await ncLogWorkbook(
          heading('Nonconformity log', filterWords(query, book.names)),
          rows,
          book.names,
          timeZone,
        ),
        fileName: `nc-log-${params.asOf}.xlsx`,
        contentType: XLSX,
      };
    }
    case 'ISO_RISK_REGISTER_XLSX': {
      const query = ISO_EXPORT_FILTERS.ISO_RISK_REGISTER_XLSX.parse(raw);
      const book = await deps.store.isoRiskItems(ctx, client.id, {
        managementSystemIds: query.managementSystemId,
        unitIds: query.unitId,
        kind: query.kind,
        significant: query.significant,
        climateRelated: query.climateRelated,
        ownerId: personRef(ctx, query.ownerId),
        includeArchived: query.includeArchived,
        scope,
      });
      return {
        bytes: await riskRegisterWorkbook(
          heading('Risk register', filterWords(query, book.names)),
          settings.isoRisk,
          riskRegisterRows(book, query.q),
          book,
          settings,
          timeZone,
        ),
        fileName: `risk-register-${params.asOf}.xlsx`,
        contentType: XLSX,
      };
    }
    case 'ISO_AUDIT_REPORT_PDF': {
      const { internalAuditId } = ISO_EXPORT_FILTERS.ISO_AUDIT_REPORT_PDF.parse(raw);
      const book = await deps.store.isoInternalAudit(ctx, client.id, internalAuditId, scope);
      // Archived, or out of the requester's scope, since the job was queued.
      if (book === null) throw new ApiError('NOT_FOUND');
      return {
        bytes: await auditReportPdf({
          clientName: client.name,
          book,
          generatedAt: deps.clock().toISOString(),
          timeZone,
        }),
        fileName: `internal-audit-report-${book.audit.plannedStart}.pdf`,
        contentType: 'application/pdf',
      };
    }
    case 'ISO_REVIEW_PACK_PDF': {
      const { managementReviewId } = ISO_EXPORT_FILTERS.ISO_REVIEW_PACK_PDF.parse(raw);
      const generatedAt = deps.clock().toISOString();
      // A PLANNED review's figures are computed as of the client's today when the pack is made (model §9).
      const book = await deps.store.isoManagementReview(ctx, client.id, managementReviewId, scope, {
        today: localDateIn(generatedAt, timeZone),
        timeZone,
      });
      if (book === null) throw new ApiError('NOT_FOUND');
      const { refs } = reviewFigureRefs(book);
      const { visible, labels } = await deps.store.isoFigureReferences(ctx, client.id, refs, scope);
      return {
        bytes: await reviewPackPdf({
          clientName: client.name,
          book,
          inputs: packInputs(book, visible, labels, { personId: ctx.personId, timeZone }),
          generatedAt,
          timeZone,
        }),
        fileName: `management-review-pack-${book.review.heldOn ?? book.review.plannedOn}.pdf`,
        contentType: 'application/pdf',
      };
    }
  }
}

async function buildFile(
  deps: DashboardDeps,
  ctx: RequestContext,
  job: ExportJob,
  iso: boolean,
): Promise<BuiltFile> {
  if (isIsoKindJob(job)) return buildIsoFile(deps, ctx, job);
  const scope = await exportScope(deps, ctx, job, iso);
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
    default:
      // A kind that joined `ExportKind` before M10 builds it: the job ends FAILED.
      throw new Error(`No file builder for ${String(job.kind)}`);
  }
}

const ZIP = 'application/zip';

/**
 * The archive's ISO data, read with the add-on on or off and with no unit scope, since only an account admin makes it
 * (docs/iso/model.md §9): the NC log and risk register workbooks over the whole client, the other records, and the
 * clean files.
 */
async function archiveIso(
  deps: ReportsDeps,
  ctx: RequestContext,
  client: ClientInfo,
): Promise<ClientArchiveInput['iso']> {
  const settings = await deps.store.firmSettings(ctx);
  const timeZone = client.settings.timeZone;
  const asOf = localDateIn(deps.clock().toISOString(), timeZone);
  const heading = (title: string): IsoHeading => ({
    title,
    clientName: client.name,
    asOf,
    filters: [],
    scoped: false,
  });
  const ncs = await deps.store.isoNonconformities(ctx, client.id, { scope: null });
  const risks = await deps.store.isoRiskItems(ctx, client.id, {
    includeArchived: true,
    scope: null,
  });
  const records = await deps.store.isoArchive(ctx, client.id);
  return {
    ncLog: await ncLogWorkbook(
      heading('Nonconformity log'),
      ncLogRows(ncs, {}, asOf, settings),
      ncs.names,
      timeZone,
    ),
    riskRegister: await riskRegisterWorkbook(
      heading('Risk register'),
      settings.isoRisk,
      riskRegisterRows(risks, undefined),
      risks,
      settings,
      timeZone,
    ),
    records: await isoRecordsWorkbook(records),
    files: records.files.clean,
    withheld: records.files.withheld,
  };
}

/** The client archive: the whole register, the clean evidence and the ISO data, streamed into storage (ADR M10-0002). */
async function storeArchive(
  deps: ReportsDeps,
  ctx: RequestContext,
  job: ExportJob,
  storageKey: (fileName: string) => string,
): Promise<string> {
  const scope = await exportScope(deps, ctx, job, true);
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
  const iso = await archiveIso(deps, ctx, client);
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
    iso,
    open: (key) => deps.files.open(key),
    generatedAt,
  });
  await deps.files.putStream(storageKey(fileName), archive, ZIP);
  return fileName;
}

/**
 * Builds and stores the file, then marks the job DONE; any failure marks it FAILED. Never throws. It re-reads the
 * account's features when it runs, so a job queued before the ISO add-on was switched off leaves ISO data out, and an
 * ISO export kind fails (docs/iso/plan.md §4.2).
 */
export async function runExport(
  deps: ReportsDeps,
  ctx: RequestContext,
  job: ExportJob,
): Promise<void> {
  try {
    await deps.store.setExportStatus(ctx, job.id, { status: 'RUNNING' });
    const iso = (await deps.store.accountFeatures(ctx)).includes(ISO_FEATURE);
    if (isIsoKind(job.kind) && !iso) throw featureNotEnabled();
    const keyOf = (fileName: string) =>
      `exports/${ctx.firmId}/${job.clientId}/${job.id}/${fileName}`;
    let fileName: string;
    if (job.kind === 'CLIENT_ARCHIVE_ZIP') {
      fileName = await storeArchive(deps, ctx, job, keyOf);
    } else {
      const file = await buildFile(deps, ctx, job, iso);
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

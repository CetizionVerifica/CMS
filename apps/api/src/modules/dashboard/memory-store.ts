import { randomUUID } from 'node:crypto';
import {
  type ActKind,
  type AuditChecklistItem,
  type AuditFinding,
  type AuditProgramme,
  type InternalAudit,
  DEFAULT_FIRM_SETTINGS,
  ExportJob,
  type FirmSettings,
  type IsoAction,
  type LocalDate,
  type ManagementReview,
  type Nonconformity,
  type ObligationDomain,
  type RequestContext,
  type RiskControl,
  type ReviewInputFigures,
  type RiskItem,
} from '@canopy/contracts';
import type { RegisterRow, UnitScope } from '@canopy/db';
import { ApiError } from '../../auth/index.js';
import type {
  ArchiveEvidence,
  ClientInfo,
  ExportDetail,
  IsoAuditBook,
  IsoFigureRef,
  IsoNames,
  IsoNcBook,
  IsoNcFilter,
  IsoReviewBook,
  IsoReviewInputRow,
  IsoReviewOutputRow,
  IsoRiskBook,
  IsoRiskFilter,
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
  /** The kind of the instance's act; absent is a STATUTE. */
  actKind?: ActKind;
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
  /** Effective features by firm; a firm missing here has none. */
  readonly features = new Map<string, readonly string[]>();
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
  /**
   * ISO records as M3 holds them, and the names they print. `systems` gives each management system's units for the
   * unit scope (plan §3.3: a record with no unit takes its system's; a system with none covers every unit).
   */
  readonly iso = {
    systems: new Map<string, { firmId: string; clientId: string; unitIds: string[] }>(),
    nonconformities: [] as Nonconformity[],
    riskItems: [] as RiskItem[],
    controls: [] as RiskControl[],
    actions: [] as IsoAction[],
    programmes: [] as AuditProgramme[],
    audits: [] as InternalAudit[],
    checklist: [] as AuditChecklistItem[],
    findings: [] as AuditFinding[],
    reviews: [] as ManagementReview[],
    /** Input rows; `computed` stands in for M3's gather and the engine while the review is PLANNED. */
    reviewInputs: [] as (Omit<IsoReviewInputRow, 'figures'> & {
      computed: ReviewInputFigures | null;
    })[],
    reviewOutputs: [] as IsoReviewOutputRow[],
    /** Records a review figure names, by id: their table, reference and what plan §3.3 reads them by. */
    references: new Map<
      string,
      {
        clientId: string;
        table: string;
        label: string;
        managementSystemId: string;
        unitId: string | null;
        named: string[];
      }
    >(),
    names: {
      people: new Map<string, string>(),
      units: new Map<string, string>(),
      systems: new Map<string, string>(),
      clauses: new Map<string, string>(),
      obligations: new Map<string, string>(),
    } satisfies IsoNames,
  };
  /** Fails the next export status update, to test job failure handling. */
  failNextStatusUpdate = false;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async firmSettings(ctx: RequestContext): Promise<FirmSettings> {
    return this.firms.get(ctx.firmId) ?? DEFAULT_FIRM_SETTINGS;
  }

  async accountFeatures(ctx: RequestContext): Promise<readonly string[]> {
    return this.features.get(ctx.firmId) ?? [];
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

  /** M3's unit scope (plan §3.3): the record's unit, else its system's units, or a person it names. */
  private isoInScope(
    scope: UnitScope | null,
    record: { managementSystemId: string; unitId: string | null },
    named: readonly string[],
  ): boolean {
    if (scope === null) return true;
    if (scope.personId !== null && named.includes(scope.personId)) return true;
    if (record.unitId !== null) return scope.unitIds.includes(record.unitId);
    const units = this.iso.systems.get(record.managementSystemId)?.unitIds ?? [];
    return units.length === 0 || units.some((id) => scope.unitIds.includes(id));
  }

  async isoInternalAudit(
    ctx: RequestContext,
    clientId: string,
    id: string,
    scope: UnitScope | null,
  ): Promise<IsoAuditBook | null> {
    const audit = this.iso.audits.find(
      (a) =>
        a.id === id && a.firmId === ctx.firmId && a.clientId === clientId && a.archivedAt === null,
    );
    if (audit === undefined) return null;
    const programme = this.iso.programmes.find((p) => p.id === audit.programmeId)!;
    const named = [
      audit.leadAuditorId,
      ...audit.auditorIds,
      ...audit.auditeeIds,
      ...audit.reportedToIds,
    ];
    const visible =
      audit.unitIds.length === 0
        ? this.isoInScope(
            scope,
            { managementSystemId: programme.managementSystemId, unitId: null },
            named,
          )
        : scope === null ||
          named.includes(scope.personId ?? '') ||
          audit.unitIds.some((unit) => scope.unitIds.includes(unit));
    if (!visible) return null;
    const findings = this.iso.findings.filter(
      (f) => f.internalAuditId === audit.id && f.archivedAt === null,
    );
    const ncNumbers = new Map(
      this.iso.nonconformities
        .filter((n) => findings.some((f) => f.nonconformityId === n.id))
        .map((n) => [n.id, n.number]),
    );
    return {
      audit,
      programme,
      checklist: this.iso.checklist.filter(
        (c) => c.internalAuditId === audit.id && c.archivedAt === null,
      ),
      findings,
      ncNumbers,
      actions: this.isoActionsOf(new Set(findings.map((f) => f.id))),
      names: this.iso.names,
    };
  }

  async isoManagementReview(
    ctx: RequestContext,
    clientId: string,
    id: string,
    scope: UnitScope | null,
    day: { today: LocalDate; timeZone: string } | null,
  ): Promise<IsoReviewBook | null> {
    const review = this.iso.reviews.find(
      (r) =>
        r.id === id && r.firmId === ctx.firmId && r.clientId === clientId && r.archivedAt === null,
    );
    if (review === undefined) return null;
    const named = [review.chairId, ...review.attendeeIds];
    if (
      !this.isoInScope(
        scope,
        { managementSystemId: review.managementSystemId, unitId: null },
        named,
      )
    ) {
      return null;
    }
    const inputs = this.iso.reviewInputs
      .filter((i) => i.row.managementReviewId === review.id && i.row.archivedAt === null)
      .map(({ computed, ...rest }) => {
        let figures: ReviewInputFigures | null = null;
        if (rest.def.source !== 'MANUAL' && review.state === 'PLANNED') {
          figures = day === null ? null : computed;
        } else if (rest.def.source !== 'MANUAL' && review.state !== 'CANCELLED') {
          figures = rest.row.sourceFigures;
        }
        return { ...rest, figures };
      });
    return {
      review,
      inputs,
      outputs: this.iso.reviewOutputs.filter(
        (o) => o.row.managementReviewId === review.id && o.row.archivedAt === null,
      ),
      actions: this.isoActionsOf(new Set([review.id])),
      names: this.iso.names,
    };
  }

  async isoFigureReferences(
    _ctx: RequestContext,
    clientId: string,
    refs: readonly IsoFigureRef[],
    scope: UnitScope | null,
  ): Promise<{ visible: string[][]; labels: ReadonlyMap<string, string> }> {
    const labels = new Map<string, string>();
    const visible = refs.map((ref) =>
      ref.ids.filter((id) => {
        const record = this.iso.references.get(id);
        const shown =
          record !== undefined &&
          record.clientId === clientId &&
          record.table === ref.table &&
          this.isoInScope(scope, record, record.named);
        if (shown) labels.set(id, record.label);
        return shown;
      }),
    );
    return { visible, labels };
  }

  private isoActionsOf(ids: ReadonlySet<string>): IsoAction[] {
    return this.iso.actions
      .filter((a) => a.archivedAt === null && ids.has(a.subject.id))
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id));
  }

  async isoNonconformities(
    ctx: RequestContext,
    clientId: string,
    f: IsoNcFilter,
  ): Promise<IsoNcBook> {
    const has = <T>(list: readonly T[] | undefined, value: T) =>
      list === undefined || list.includes(value);
    const items = this.iso.nonconformities
      .filter(
        (n) =>
          n.firmId === ctx.firmId &&
          n.clientId === clientId &&
          n.archivedAt === null &&
          has(f.managementSystemIds, n.managementSystemId) &&
          (f.unitIds === undefined || (n.unitId !== null && f.unitIds.includes(n.unitId))) &&
          has(f.state, n.state) &&
          has(f.source, n.source) &&
          has(f.severity, n.severity) &&
          (f.standards === undefined || n.standards.some((code) => f.standards!.includes(code))) &&
          (f.ownerId === undefined || n.ownerId === f.ownerId) &&
          (f.approverId === undefined || n.approverId === f.approverId) &&
          this.isoInScope(f.scope, n, [
            n.ownerId,
            n.approverId,
            ...(n.incident?.investigatorIds ?? []),
          ]),
      )
      .sort((a, b) => a.number - b.number);
    return {
      items,
      actions: this.isoActionsOf(new Set(items.map((n) => n.id))),
      names: this.iso.names,
    };
  }

  async isoRiskItems(
    ctx: RequestContext,
    clientId: string,
    f: IsoRiskFilter,
  ): Promise<IsoRiskBook> {
    const items = this.iso.riskItems
      .filter(
        (r) =>
          r.firmId === ctx.firmId &&
          r.clientId === clientId &&
          (f.includeArchived === true || r.archivedAt === null) &&
          (f.managementSystemIds === undefined ||
            f.managementSystemIds.includes(r.managementSystemId)) &&
          (f.unitIds === undefined || (r.unitId !== null && f.unitIds.includes(r.unitId))) &&
          (f.kind === undefined || f.kind.includes(r.kind)) &&
          (f.significant === undefined || r.significant === f.significant) &&
          (f.climateRelated === undefined || r.climateRelated === f.climateRelated) &&
          (f.ownerId === undefined || r.ownerId === f.ownerId) &&
          this.isoInScope(f.scope, r, [r.ownerId]),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    const ids = new Set(items.map((r) => r.id));
    return {
      items,
      controls: this.iso.controls.filter((c) => c.archivedAt === null && ids.has(c.riskItemId)),
      actions: this.isoActionsOf(ids),
      names: this.iso.names,
    };
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
  'actKind',
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
    among(f.actKinds, r.actKind ?? 'STATUTE') &&
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

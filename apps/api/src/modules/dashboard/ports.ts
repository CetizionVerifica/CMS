import type {
  ActKind,
  AuditChecklistItem,
  AuditFinding,
  AuditProgramme,
  ClientSettings,
  Criticality,
  ExportJob,
  ExportKind,
  FirmSettings,
  InternalAudit,
  IsoAction,
  IsoReviewInputDef,
  IsoReviewOutputDef,
  IsoStandardCode,
  LocalDate,
  ManagementReview,
  NcSeverity,
  NcSource,
  NcState,
  Nonconformity,
  ObligationDomain,
  RequestContext,
  ReviewInput,
  ReviewInputFigures,
  ReviewOutput,
  RiskControl,
  RiskItem,
  RiskKind,
  TimelineType,
  WorkflowState,
} from '@canopy/contracts';
import type { RegisterRow, UnitScope } from '@canopy/db';

/**
 * What M10 reads and writes, as a narrow port (docs/adr/M10-0001-dashboards-and-reports.md).
 * The in-memory store runs the tests; a Postgres adapter over M3's repositories implements the same port.
 * Every call runs in the caller's tenant (`ctx.firmId`); the adapter wraps each call in `withTenant`.
 */

/** The register filters M10 applies in the store, already resolved (`me` → a person id, `fy` → dates). */
export interface RowFilter {
  /** Limit to these units: the actor's unit scope intersected with any `unitId` filter. Empty = nothing. */
  unitIds?: readonly string[];
  departmentIds?: readonly string[];
  actIds?: readonly string[];
  categoryIds?: readonly string[];
  ownerId?: string;
  approverId?: string;
  criticality?: readonly Criticality[];
  workflowState?: readonly WorkflowState[];
  timelineType?: TimelineType;
  domain?: readonly ObligationDomain[];
  dueFrom?: LocalDate;
  dueTo?: LocalDate;
  completedFrom?: LocalDate;
  completedTo?: LocalDate;
  hasEvidence?: boolean;
  /** Case-insensitive match on title, external ref, Act name and comments. */
  q?: string;
  /**
   * Act kinds (docs/iso/plan.md §4.6): `['STATUTE']` for statutory numbers and the LAW source, `['STANDARD']` for the
   * ISO source; absent reads both. An empty list matches nothing.
   */
  actKinds?: readonly ActKind[];
}

export interface ClientInfo {
  id: string;
  name: string;
  settings: ClientSettings;
}

/** Register-export columns the register row does not carry (obligation text, NA reason, first comment). */
export interface ExportDetail {
  description: string;
  applicabilityText: string | null;
  naReason: string | null;
  /** The instance's first comment: the "Owner Comments" an import recorded, or the first submission note. */
  firstComment: string | null;
}

/** A unit with the names a certificate shows. */
export interface UnitInfo {
  id: string;
  name: string;
  companyName: string;
  /** e.g. "India / West Bengal / Riverbend". */
  locationLabel: string;
}

/** A clean evidence file the client archive carries. `storageKey` never leaves the server. */
export interface ArchiveEvidence {
  id: string;
  instanceId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  storageKey: string;
}

export interface NewExportJob {
  clientId: string;
  kind: ExportKind;
  params: Record<string, unknown>;
}

/**
 * The names an ISO export prints for the ids its records carry, archived ones included (a record keeps naming a
 * person or unit archived since). `clauses` reads e.g. "ISO 9001 8.7".
 */
export interface IsoNames {
  people: ReadonlyMap<string, string>;
  units: ReadonlyMap<string, string>;
  systems: ReadonlyMap<string, string>;
  clauses: ReadonlyMap<string, string>;
  obligations: ReadonlyMap<string, string>;
}

/**
 * The NC log's filters the store applies (docs/iso/model.md §9): `NcQuery`'s list filters resolved (`me` → a person
 * id), and `scope`, the requester's unit scope (plan §3.3), null for a reader who sees the whole client. `incident`,
 * `overdue` and `q` are applied by M10 after the read.
 */
export interface IsoNcFilter {
  managementSystemIds?: readonly string[];
  unitIds?: readonly string[];
  state?: readonly NcState[];
  source?: readonly NcSource[];
  severity?: readonly NcSeverity[];
  standards?: readonly IsoStandardCode[];
  ownerId?: string;
  approverId?: string;
  scope: UnitScope | null;
}

/** The risk register's filters the store applies, as `IsoNcFilter`; `q` is applied by M10 after the read. */
export interface IsoRiskFilter {
  managementSystemIds?: readonly string[];
  unitIds?: readonly string[];
  kind?: readonly RiskKind[];
  significant?: boolean;
  climateRelated?: boolean;
  ownerId?: string;
  includeArchived?: boolean;
  scope: UnitScope | null;
}

/** The client's nonconformities in scope (live ones), with their corrective actions and the names they print. */
export interface IsoNcBook {
  items: Nonconformity[];
  /** The live actions of `items`, any state. */
  actions: IsoAction[];
  names: IsoNames;
}

/** The client's risk items in scope, with their controls in place, their treatment actions and the names. */
export interface IsoRiskBook {
  items: RiskItem[];
  controls: RiskControl[];
  /** The live actions of `items`, any state. */
  actions: IsoAction[];
  names: IsoNames;
}

/**
 * One internal audit for its report (docs/iso/model.md §3.7, §3.9): its programme, checklist, findings with the numbers
 * of the NCs they raised, the findings' improvement actions and the names they print. Children take the audit's units
 * (plan §3.3), so a reader who may read the audit reads them all.
 */
export interface IsoAuditBook {
  audit: InternalAudit;
  programme: AuditProgramme;
  checklist: AuditChecklistItem[];
  findings: AuditFinding[];
  /** NC number by id, for the findings that raised one. */
  ncNumbers: ReadonlyMap<string, number>;
  /** The live actions of `findings`, any state. */
  actions: IsoAction[];
  names: IsoNames;
}

/** One input row of a review pack, with the figures its review's state gives it (docs/iso/model.md §3.13 item 5). */
export interface IsoReviewInputRow {
  row: ReviewInput;
  def: IsoReviewInputDef;
  /** "ISO 9001 9.3.2 c": the definition's clause. */
  clause: string;
  /**
   * PLANNED: computed as of the pack's day over the whole system; HELD or CLOSED: the stored copy (null for a review
   * held before its system was set up); CANCELLED and MANUAL: null. Ids are not cut to the reader yet.
   */
  figures: ReviewInputFigures | null;
}

/** One output row of a review pack. */
export interface IsoReviewOutputRow {
  row: ReviewOutput;
  def: IsoReviewOutputDef;
  clause: string;
}

/** One management review for its pack (docs/iso/model.md §3.13, §9): rows in key order, its review actions, names. */
export interface IsoReviewBook {
  review: ManagementReview;
  inputs: IsoReviewInputRow[];
  outputs: IsoReviewOutputRow[];
  /** The live actions raised by the review, any state. */
  actions: IsoAction[];
  names: IsoNames;
}

/** A review figure's ids with the table `REVIEW_FIGURE_KEYS` names for them. */
export interface IsoFigureRef {
  table: string;
  ids: readonly string[];
}

export interface ReportsStore {
  firmSettings(ctx: RequestContext): Promise<FirmSettings>;
  /**
   * The account's effective features, read fresh: the export worker re-checks the ISO add-on when it runs, after the
   * request that queued the job has ended (docs/iso/plan.md §4.2).
   */
  accountFeatures(ctx: RequestContext): Promise<readonly string[]>;
  /** Non-archived clients among `clientIds`, in name order. */
  clients(ctx: RequestContext, clientIds: readonly string[]): Promise<ClientInfo[]>;
  /** A non-archived unit of the client, or null. */
  unit(ctx: RequestContext, clientId: string, unitId: string): Promise<UnitInfo | null>;
  /** Every non-archived instance of the client matching the filter, as register rows (no status), by due date then id. */
  registerRows(ctx: RequestContext, clientId: string, filter: RowFilter): Promise<RegisterRow[]>;
  exportDetails(
    ctx: RequestContext,
    clientId: string,
    instanceIds: readonly string[],
  ): Promise<Map<string, ExportDetail>>;
  /**
   * The client's non-archived evidence: `clean` the files scanned CLEAN, oldest upload first, and `withheld` how
   * many others (pending, infected or failed scans) the archive leaves out.
   */
  archiveEvidence(
    ctx: RequestContext,
    clientId: string,
  ): Promise<{ clean: ArchiveEvidence[]; withheld: number }>;
  /** Time of the latest audit event per client, null when there is none. */
  lastActivity(
    ctx: RequestContext,
    clientIds: readonly string[],
  ): Promise<Map<string, string | null>>;
  /** Stores a QUEUED job requested by `ctx.personId` and its EXPORT audit event, in one transaction. */
  createExportJob(ctx: RequestContext, job: NewExportJob): Promise<ExportJob>;
  getExportJob(ctx: RequestContext, id: string): Promise<ExportJob | null>;
  setExportStatus(
    ctx: RequestContext,
    id: string,
    patch: Pick<ExportJob, 'status'> & { fileName?: string | null; storageKey?: string | null },
  ): Promise<ExportJob>;
  /** Where a finished export's file is stored; never returned to clients. */
  exportStorageKey(ctx: RequestContext, id: string): Promise<string | null>;
  /** Every live nonconformity of the client matching `filter` and its scope (docs/iso/model.md §9). */
  isoNonconformities(
    ctx: RequestContext,
    clientId: string,
    filter: IsoNcFilter,
  ): Promise<IsoNcBook>;
  /** Every risk item of the client matching `filter` and its scope (live ones unless `includeArchived`). */
  isoRiskItems(ctx: RequestContext, clientId: string, filter: IsoRiskFilter): Promise<IsoRiskBook>;
  /** A live internal audit of the client that `scope` may read, with its report's records; null otherwise. */
  isoInternalAudit(
    ctx: RequestContext,
    clientId: string,
    id: string,
    scope: UnitScope | null,
  ): Promise<IsoAuditBook | null>;
  /**
   * A live management review of the client that `scope` may read (its system's units, or its chair or an attendee),
   * with its pack's rows; a PLANNED review's figures are computed as of `today` in `timeZone`, or not at all when
   * `day` is null (create only checks the review exists for the requester). Null otherwise.
   */
  isoManagementReview(
    ctx: RequestContext,
    clientId: string,
    id: string,
    scope: UnitScope | null,
    day: { today: LocalDate; timeZone: string } | null,
  ): Promise<IsoReviewBook | null>;
  /**
   * For each of `refs`, the ids of the client's records `scope` may read (all of the client's with no scope), in their
   * order, and a short reference for each of them ("NC 12", an audit's title): plan §3.3, through M3's `isoVisibleIds`.
   */
  isoFigureReferences(
    ctx: RequestContext,
    clientId: string,
    refs: readonly IsoFigureRef[],
    scope: UnitScope | null,
  ): Promise<{ visible: string[][]; labels: ReadonlyMap<string, string> }>;
}

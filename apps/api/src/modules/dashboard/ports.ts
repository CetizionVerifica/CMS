import type {
  ActKind,
  ClientSettings,
  Criticality,
  ExportJob,
  ExportKind,
  FirmSettings,
  IsoAction,
  IsoStandardCode,
  LocalDate,
  NcSeverity,
  NcSource,
  NcState,
  Nonconformity,
  ObligationDomain,
  RequestContext,
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
}

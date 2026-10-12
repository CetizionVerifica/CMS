import type {
  ClientSettings,
  Criticality,
  ExportJob,
  ExportKind,
  FirmSettings,
  LocalDate,
  ObligationDomain,
  RequestContext,
  TimelineType,
  WorkflowState,
} from '@canopy/contracts';
import type { RegisterRow } from '@canopy/db';

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

export interface NewExportJob {
  clientId: string;
  kind: ExportKind;
  params: Record<string, unknown>;
}

export interface ReportsStore {
  firmSettings(ctx: RequestContext): Promise<FirmSettings>;
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
}

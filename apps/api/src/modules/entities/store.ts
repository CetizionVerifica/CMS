import type {
  Act,
  Assignment,
  AuditAction,
  Category,
  Client,
  Company,
  Department,
  EntityType,
  Id,
  Location,
  Membership,
  Obligation,
  Person,
  RequestContext,
  Unit,
} from '@canopy/contracts';

/**
 * What the M6 services need from the database. Each method maps to an M3 repository (packages/db), which runs
 * inside `withTenant`, so row-level security decides what a context can see and change. The services never build
 * SQL. `MemoryStore` (memory-store.ts) implements this for the route tests; the Postgres adapter over the M3
 * repositories implements it for the running API.
 */

/** Fields the database sets: id, tenant, timestamps and version. */
type Generated = 'id' | 'firmId' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'version';

export type NewRow<T> = Omit<T, Generated>;

/** Fields an update may set. `archivedAt` is how archive and restore are written. */
export type Patch<T> = Partial<Omit<T, Exclude<Generated, 'archivedAt'>>>;

/** Equality (or membership, for an array) per field; every listed field must match. */
export type Where<T> = { [K in keyof T]?: T[K] | readonly T[K][] };

export interface ListQuery<T> {
  where?: Where<T>;
  /** Case-insensitive substring match on any of these fields. */
  search?: { text: string; fields: readonly string[] };
  /** Archived rows are left out unless this is true. */
  includeArchived?: boolean;
  /** Rows sort by this field, then id. The cursor is the last row of the previous page. */
  orderBy: keyof T & string;
  after?: { key: string; id: Id } | null;
  limit: number;
  count?: boolean;
}

export interface ListResult<T> {
  items: T[];
  /** Matching rows ignoring the cursor and limit; only when `count` was asked for. */
  total?: number;
}

export interface Repo<T extends { id: Id }> {
  /** A row the context can see, archived or not. */
  get(id: Id): Promise<T | null>;
  list(query: ListQuery<T>): Promise<ListResult<T>>;
  /** Every visible row matching `where` (archived rows excluded), unpaginated. For small sets only. */
  findAll(where: Where<T>): Promise<T[]>;
  /** Throws `DuplicateError` when a unique rule is broken. */
  insert(values: NewRow<T>): Promise<T>;
  /**
   * Applies `patch` when the row is at `version`, bumping version and updatedAt. Returns null when the row is not
   * visible or the context may not change it, 'STALE' when the version moved. Throws `DuplicateError`.
   */
  update(id: Id, version: number, patch: Patch<T>): Promise<T | 'STALE' | null>;
}

/** An instance whose owner or approver M6 changed, with the values before the change. */
export interface ReassignedInstance {
  id: Id;
  clientId: Id;
  /** Version after the change. */
  version: number;
  before: { ownerId: Id; approverId: Id };
  after: { ownerId: Id; approverId: Id };
}

/** Instance writes M6 makes: reassignment after an assignment change, and moving people on a merge. */
export interface InstanceWrites {
  /** Sets owner and/or approver on the assignment's OPEN and SENT_BACK instances. */
  reassignOpen(
    assignmentId: Id,
    to: { ownerId?: Id; approverId?: Id },
  ): Promise<ReassignedInstance[]>;
  /** Moves every live instance where `fromPersonId` is owner or approver to `toPersonId`. */
  replacePerson(fromPersonId: Id, toPersonId: Id): Promise<ReassignedInstance[]>;
}

export interface AuditInput {
  clientId: Id | null;
  action: AuditAction;
  entityType: EntityType;
  entityId: Id;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason?: string | null;
}

/** A domain event for the transactional outbox (docs/contracts/events.md). */
export interface EventInput {
  type: string;
  clientId: Id | null;
  aggregate: { type: string; id: Id };
  aggregateVersion: number;
  data: Record<string, unknown>;
}

export interface Tx {
  clients: Repo<Client>;
  companies: Repo<Company>;
  units: Repo<Unit>;
  locations: Repo<Location>;
  departments: Repo<Department>;
  people: Repo<Person>;
  memberships: Repo<Membership>;
  acts: Repo<Act>;
  categories: Repo<Category>;
  obligations: Repo<Obligation>;
  assignments: Repo<Assignment>;
  instances: InstanceWrites;
  /** People with an active membership, assignment or instance in the client. */
  clientPersonIds(clientId: Id): Promise<Id[]>;
  /** People with an active FIRM_ADMIN or CONSULTANT membership. */
  firmStaffIds(): Promise<Id[]>;
  /**
   * Where a person belongs across the whole firm, whatever the caller's context: every client where they have a live
   * membership, assignment or instance, and whether they hold a firm role. M6 uses it to refuse person writes that
   * would reach past the actor's clients; on Postgres it needs a narrow security-definer function from M3, since
   * a client context cannot see the other clients' rows.
   */
  personReach(personId: Id): Promise<{ clientIds: Id[]; firmStaff: boolean }>;
  /** Obligations with an active assignment in a client the context can see. */
  assignedObligationIds(): Promise<Id[]>;
  /** Appends an audit row in this transaction (root CLAUDE.md non-negotiable 2). */
  audit(event: AuditInput): Promise<void>;
  /** Adds an event to the outbox in this transaction. */
  emit(event: EventInput): Promise<void>;
}

export interface Store {
  /** Runs `fn` in one transaction for the request's tenant; every audit row and event commits with the change. */
  transaction<T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** A unique rule was broken (409 DUPLICATE). */
export class DuplicateError extends Error {
  constructor(
    readonly field: string,
    readonly existingId: Id,
  ) {
    super(`Duplicate ${field}`);
    this.name = 'DuplicateError';
  }
}

import type {
  Act,
  ActKind,
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
  /** 1 to `LIST_MAX`. */
  limit: number;
  count?: boolean;
  /**
   * Acts, obligations and assignments only: keep rows whose act is of these kinds (docs/iso/plan.md §4.4, ISO-2f's
   * filter). Absent reads both kinds.
   */
  actKinds?: readonly ActKind[];
}

/** The most rows one `Repo.list` call returns: M3's `MAX_LIMIT`, which is also the contract's page maximum. */
export const LIST_MAX = 200;

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

/**
 * Where a person belongs across the firm. `clientIds` can name clients the caller cannot see: use it only to allow or
 * refuse, never in a response.
 */
export interface PersonReach {
  clientIds: Id[];
  firmStaff: boolean;
}

/** One plan limit against the account's firm-wide count; `max` is null when the plan sets none. */
export interface PlanAllowance {
  max: number | null;
  used: number;
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
  /**
   * The kind of the act behind an obligation or assignment, archived or not; null when the context cannot see the
   * row. For the ISO add-on's off switch (plan §4.4).
   */
  actKindOf: {
    obligation(id: Id): Promise<ActKind | null>;
    assignment(id: Id): Promise<ActKind | null>;
  };
  /** People with an active membership, assignment or instance in the client. */
  clientPersonIds(clientId: Id): Promise<Id[]>;
  /** People with an active FIRM_ADMIN or CONSULTANT membership. */
  firmStaffIds(): Promise<Id[]>;
  /**
   * Where a person belongs across the whole firm, whatever the caller's context: every client where they have a live
   * membership, assignment or instance, and whether they hold a firm role. M6 uses it to refuse person writes that
   * would reach past the actor's clients.
   */
  personReach(personId: Id): Promise<PersonReach>;
  /**
   * Creates a person together with their first membership of a client. A client context can see a person only once
   * a membership links them to its client, so the two rows go in together.
   */
  createPersonInClient(
    person: NewRow<Person>,
    membership: Omit<NewRow<Membership>, 'personId'>,
  ): Promise<{ person: Person; membership: Membership }>;
  /** Obligations with an active assignment in a client the context can see. */
  assignedObligationIds(): Promise<Id[]>;
  /**
   * Takes the account's usage lock until the transaction ends, then reads the plan's limit and the whole account's
   * count of live rows, whatever clients the context can see (ADR M15-0001 decision 5). Two creates at the limit
   * cannot both read the count before either writes.
   */
  planAllowance(limit: 'companies' | 'units'): Promise<PlanAllowance>;
  /** Appends an audit row in this transaction (root CLAUDE.md non-negotiable 2). */
  audit(event: AuditInput): Promise<void>;
  /** Adds an event to the outbox in this transaction. */
  emit(event: EventInput): Promise<void>;
}

export interface Store {
  /** Runs `fn` in one transaction for the request's tenant; every audit row and event commits with the change. */
  transaction<T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * A unique rule was broken (409 DUPLICATE). `existingId` is null when the existing row is one the context cannot see,
 * so its id is not revealed.
 */
export class DuplicateError extends Error {
  constructor(
    readonly field: string,
    readonly existingId: Id | null,
  ) {
    super(`Duplicate ${field}`);
    this.name = 'DuplicateError';
  }
}

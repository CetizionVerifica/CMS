import { randomUUID } from 'node:crypto';
import type { ComplianceInstance, Id, Membership, Person, RequestContext } from '@canopy/contracts';
import {
  DuplicateError,
  type AuditInput,
  type EventInput,
  type ListQuery,
  type ListResult,
  type NewRow,
  type Patch,
  type ReassignedInstance,
  type Repo,
  type Store,
  type Tx,
  type Where,
} from '../store.js';

/**
 * In-memory Store for route tests. It behaves like the Postgres store under row-level security
 * (docs/adr/0001-m3-tenant-isolation-in-postgres.md): rows of other firms are invisible, client rows are visible
 * only in the context's clients, firm-wide rows (library, locations) change only for firm staff, and a failed
 * transaction leaves nothing behind. It is not a substitute for M3's isolation tests, which run on Postgres.
 */

type Row = { id: Id; firmId: Id; archivedAt: string | null } & Record<string, unknown>;

interface Scope {
  firmId: Id;
  personId: Id;
  all: boolean;
  staff: boolean;
  clientIds: readonly Id[];
}

type Kind =
  | { kind: 'client'; clientOf: (row: Row) => Id }
  | { kind: 'firmWide'; insert: 'staff' | 'any' }
  | { kind: 'person' }
  | { kind: 'membership' };

interface Unique {
  field: string;
  key: (row: Row) => string | null;
}

interface TableDef {
  policy: Kind;
  uniques: Unique[];
  versioned: boolean;
}

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : null);

const TABLES = {
  clients: { policy: { kind: 'client', clientOf: (r) => r.id }, uniques: [], versioned: true },
  companies: {
    policy: { kind: 'client', clientOf: (r) => r.clientId as Id },
    uniques: [{ field: 'name', key: (r) => `${r.clientId}|${r.name}` }],
    versioned: true,
  },
  units: {
    policy: { kind: 'client', clientOf: (r) => r.clientId as Id },
    uniques: [{ field: 'name', key: (r) => `${r.companyId}|${r.name}` }],
    versioned: true,
  },
  departments: {
    policy: { kind: 'client', clientOf: (r) => r.clientId as Id },
    uniques: [{ field: 'name', key: (r) => `${r.clientId}|${r.name}` }],
    versioned: true,
  },
  locations: {
    policy: { kind: 'firmWide', insert: 'any' },
    uniques: [
      {
        field: 'location',
        key: (r) => `${r.countryCode}|${lower(r.state) ?? ''}|${lower(r.city) ?? ''}`,
      },
    ],
    versioned: false,
  },
  people: {
    policy: { kind: 'person' },
    uniques: [{ field: 'email', key: (r) => lower(r.email) }],
    versioned: true,
  },
  memberships: { policy: { kind: 'membership' }, uniques: [], versioned: true },
  acts: {
    policy: { kind: 'firmWide', insert: 'staff' },
    uniques: [{ field: 'name', key: (r) => String(r.name) }],
    versioned: true,
  },
  categories: {
    policy: { kind: 'firmWide', insert: 'staff' },
    uniques: [{ field: 'name', key: (r) => String(r.name) }],
    versioned: true,
  },
  obligations: { policy: { kind: 'firmWide', insert: 'staff' }, uniques: [], versioned: true },
  assignments: {
    policy: { kind: 'client', clientOf: (r) => r.clientId as Id },
    uniques: [
      {
        field: 'obligationId',
        key: (r) => `${r.unitId}|${r.obligationId}|${r.departmentId}`,
      },
    ],
    versioned: true,
  },
} satisfies Record<string, TableDef>;

type TableName = keyof typeof TABLES;

export interface StoredAudit extends AuditInput {
  firmId: Id;
  actorId: Id;
  requestId: string;
}

export interface StoredEvent extends EventInput {
  firmId: Id;
  requestId: string;
}

interface Data {
  tables: Record<TableName, Map<Id, Row>>;
  instances: Map<Id, ComplianceInstance>;
  audits: StoredAudit[];
  events: StoredEvent[];
}

function emptyData(): Data {
  return {
    tables: Object.fromEntries(Object.keys(TABLES).map((t) => [t, new Map()])) as Data['tables'],
    instances: new Map(),
    audits: [],
    events: [],
  };
}

function scopeOf(ctx: RequestContext): Scope {
  const active = ctx.memberships.filter((m) => m.archivedAt === null);
  const all = active.some((m) => m.role === 'FIRM_ADMIN');
  return {
    firmId: ctx.firmId,
    personId: ctx.personId,
    all,
    staff: active.some((m) => m.role === 'FIRM_ADMIN' || m.role === 'CONSULTANT'),
    clientIds: ctx.clientIds,
  };
}

function matches<T>(row: T, where: Where<T>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const value = (row as Record<string, unknown>)[key];
    return Array.isArray(expected) ? expected.includes(value) : value === expected;
  });
}

export class MemoryStore implements Store {
  private data: Data = emptyData();
  private clock: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.clock = options.now ?? (() => new Date());
  }

  /** Audit rows written by committed transactions. */
  get audits(): readonly StoredAudit[] {
    return this.data.audits;
  }

  /** Outbox events written by committed transactions. */
  get events(): readonly StoredEvent[] {
    return this.data.events;
  }

  /** Seeds a row as the database would hold it, bypassing policies (test setup only). */
  seed<N extends TableName>(table: N, row: Row): void {
    this.data.tables[table].set(row.id, structuredClone(row));
  }

  seedInstance(row: ComplianceInstance): void {
    this.data.instances.set(row.id, structuredClone(row));
  }

  instance(id: Id): ComplianceInstance | undefined {
    return this.data.instances.get(id);
  }

  /** A row as stored, ignoring policies (test assertions only). */
  raw(table: TableName, id: Id): Row | undefined {
    return this.data.tables[table].get(id);
  }

  async transaction<T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.data);
    try {
      return await fn(this.tx(ctx));
    } catch (error) {
      this.data = snapshot;
      throw error;
    }
  }

  private now(): string {
    return this.clock()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
  }

  private visibleClient(scope: Scope, clientId: Id | null): boolean {
    if (scope.all) return true;
    return clientId !== null && scope.clientIds.includes(clientId);
  }

  /** Clients where a person has a live membership, assignment or instance (any firm context). */
  private personClients(personId: Id, firmId: Id): Set<Id> {
    const clients = new Set<Id>();
    for (const m of this.data.tables.memberships.values()) {
      if (m.firmId === firmId && m.personId === personId && m.archivedAt === null && m.clientId) {
        clients.add(m.clientId as Id);
      }
    }
    for (const a of this.data.tables.assignments.values()) {
      if (
        a.firmId === firmId &&
        a.archivedAt === null &&
        (a.defaultOwnerId === personId || a.defaultApproverId === personId)
      ) {
        clients.add(a.clientId as Id);
      }
    }
    for (const i of this.data.instances.values()) {
      if (
        i.firmId === firmId &&
        i.archivedAt === null &&
        (i.ownerId === personId || i.approverId === personId)
      ) {
        clients.add(i.clientId);
      }
    }
    return clients;
  }

  private hasFirmRole(personId: Id, firmId: Id): boolean {
    return [...this.data.tables.memberships.values()].some(
      (m) =>
        m.firmId === firmId &&
        m.personId === personId &&
        m.archivedAt === null &&
        (m.role === 'FIRM_ADMIN' || m.role === 'CONSULTANT'),
    );
  }

  private canRead(table: TableName, row: Row, scope: Scope): boolean {
    if (row.firmId !== scope.firmId) return false;
    const policy: Kind = TABLES[table].policy;
    switch (policy.kind) {
      case 'client':
        return this.visibleClient(scope, policy.clientOf(row));
      case 'firmWide':
        return true;
      case 'person':
        return (
          scope.staff ||
          row.id === scope.personId ||
          [...this.personClients(row.id, scope.firmId)].some((c) => this.visibleClient(scope, c))
        );
      case 'membership':
        return (
          this.visibleClient(scope, (row.clientId as Id | null) ?? null) ||
          row.personId === scope.personId
        );
    }
  }

  private canWrite(table: TableName, row: Row, scope: Scope, inserting: boolean): boolean {
    if (row.firmId !== scope.firmId) return false;
    const policy: Kind = TABLES[table].policy;
    switch (policy.kind) {
      case 'client':
        return this.visibleClient(scope, policy.clientOf(row));
      case 'firmWide':
        return scope.staff || (inserting && policy.insert === 'any');
      case 'person': {
        if (inserting || scope.staff) return true;
        if (!this.canRead(table, row, scope) || this.hasFirmRole(row.id, scope.firmId))
          return false;
        return (
          scope.all ||
          [...this.personClients(row.id, scope.firmId)].every((c) => scope.clientIds.includes(c))
        );
      }
      case 'membership':
        return this.visibleClient(scope, (row.clientId as Id | null) ?? null);
    }
  }

  private checkUnique(table: TableName, row: Row): void {
    for (const unique of TABLES[table].uniques as Unique[]) {
      const key = unique.key(row);
      if (key === null || row.archivedAt !== null) continue;
      for (const other of this.data.tables[table].values()) {
        if (
          other.id !== row.id &&
          other.firmId === row.firmId &&
          other.archivedAt === null &&
          unique.key(other) === key
        ) {
          throw new DuplicateError(unique.field, other.id);
        }
      }
    }
  }

  private repo<T extends { id: Id }>(table: TableName, scope: Scope): Repo<T> {
    const rows = () => this.data.tables[table];
    const visible = () => [...rows().values()].filter((r) => this.canRead(table, r, scope));
    const out = (row: Row) => structuredClone(row) as unknown as T;
    return {
      get: async (id) => {
        const row = rows().get(id);
        return row && this.canRead(table, row, scope) ? out(row) : null;
      },
      findAll: async (where) =>
        visible()
          .filter((r) => r.archivedAt === null && matches(r, where as Where<Row>))
          .map(out),
      list: async (query: ListQuery<T>): Promise<ListResult<T>> => {
        const key = (r: Row) => String(r[query.orderBy] ?? '');
        const text = query.search?.text.toLowerCase();
        const filtered = visible()
          .filter((r) => query.includeArchived === true || r.archivedAt === null)
          .filter((r) => matches(r, (query.where ?? {}) as Where<Row>))
          .filter(
            (r) =>
              text === undefined ||
              (query.search?.fields ?? []).some((f) =>
                String(r[f] ?? '')
                  .toLowerCase()
                  .includes(text),
              ),
          )
          .sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
        const after = query.after;
        const page = after
          ? filtered.filter(
              (r) =>
                key(r).localeCompare(after.key) > 0 || (key(r) === after.key && r.id > after.id),
            )
          : filtered;
        return {
          items: page.slice(0, query.limit).map(out),
          ...(query.count ? { total: filtered.length } : {}),
        };
      },
      insert: async (values: NewRow<T>) => {
        const now = this.now();
        const row: Row = {
          ...(values as Record<string, unknown>),
          id: randomUUID(),
          firmId: scope.firmId,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          ...(TABLES[table].versioned ? { version: 1 } : {}),
        };
        if (!this.canWrite(table, row, scope, true)) {
          throw new Error(`Row-level security refused an insert into ${table}`);
        }
        this.checkUnique(table, row);
        rows().set(row.id, row);
        return out(row);
      },
      update: async (id, version, patch: Patch<T>) => {
        const row = rows().get(id);
        if (!row || !this.canRead(table, row, scope) || !this.canWrite(table, row, scope, false)) {
          return null;
        }
        if (row.version !== version) return 'STALE';
        const defined = Object.fromEntries(
          Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined),
        );
        const next: Row = {
          ...row,
          ...defined,
          version: (row.version as number) + 1,
          updatedAt: this.now(),
        };
        if (!this.canWrite(table, next, scope, false)) return null;
        this.checkUnique(table, next);
        rows().set(id, next);
        return out(next);
      },
    };
  }

  private tx(ctx: RequestContext): Tx {
    const scope = scopeOf(ctx);
    const repo = <T extends { id: Id }>(t: TableName) => this.repo<T>(t, scope);
    const instancesIn = () =>
      [...this.data.instances.values()].filter(
        (i) =>
          i.firmId === scope.firmId &&
          i.archivedAt === null &&
          this.visibleClient(scope, i.clientId),
      );
    const reassign = (
      instance: ComplianceInstance,
      to: { ownerId: Id; approverId: Id },
    ): ReassignedInstance => {
      const next = {
        ...instance,
        ...to,
        version: instance.version + 1,
        updatedAt: this.now(),
      };
      this.data.instances.set(instance.id, next);
      return {
        id: instance.id,
        clientId: instance.clientId,
        version: next.version,
        before: { ownerId: instance.ownerId, approverId: instance.approverId },
        after: to,
      };
    };
    return {
      clients: repo('clients'),
      companies: repo('companies'),
      units: repo('units'),
      locations: repo('locations'),
      departments: repo('departments'),
      people: repo<Person>('people'),
      memberships: repo<Membership>('memberships'),
      acts: repo('acts'),
      categories: repo('categories'),
      obligations: repo('obligations'),
      assignments: repo('assignments'),
      instances: {
        reassignOpen: async (assignmentId, to) =>
          instancesIn()
            .filter(
              (i) =>
                i.assignmentId === assignmentId &&
                (i.workflowState === 'OPEN' || i.workflowState === 'SENT_BACK') &&
                ((to.ownerId !== undefined && to.ownerId !== i.ownerId) ||
                  (to.approverId !== undefined && to.approverId !== i.approverId)),
            )
            .map((i) =>
              reassign(i, {
                ownerId: to.ownerId ?? i.ownerId,
                approverId: to.approverId ?? i.approverId,
              }),
            ),
        replacePerson: async (from, to) =>
          instancesIn()
            .filter((i) => i.ownerId === from || i.approverId === from)
            .map((i) =>
              reassign(i, {
                ownerId: i.ownerId === from ? to : i.ownerId,
                approverId: i.approverId === from ? to : i.approverId,
              }),
            ),
      },
      clientPersonIds: async (clientId) => {
        if (!this.visibleClient(scope, clientId)) return [];
        return [...this.data.tables.people.values()]
          .filter((p) => p.firmId === scope.firmId)
          .filter((p) => this.personClients(p.id, scope.firmId).has(clientId))
          .map((p) => p.id);
      },
      firmStaffIds: async () =>
        [...this.data.tables.people.values()]
          .filter((p) => p.firmId === scope.firmId && this.hasFirmRole(p.id, scope.firmId))
          .map((p) => p.id),
      assignedObligationIds: async () => [
        ...new Set(
          [...this.data.tables.assignments.values()]
            .filter(
              (a) =>
                a.firmId === scope.firmId &&
                a.archivedAt === null &&
                this.visibleClient(scope, a.clientId as Id),
            )
            .map((a) => a.obligationId as Id),
        ),
      ],
      audit: async (event) => {
        this.data.audits.push({
          ...event,
          firmId: scope.firmId,
          actorId: ctx.personId,
          requestId: ctx.requestId,
        });
      },
      emit: async (event) => {
        this.data.events.push({ ...event, firmId: scope.firmId, requestId: ctx.requestId });
      },
    };
  }
}

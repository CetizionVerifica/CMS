import type { Id, Membership, Person, RequestContext } from '@canopy/contracts';
import {
  account,
  acts,
  assignments,
  auditEvents,
  categories,
  clients,
  companies,
  DbError,
  departments,
  domainEvents,
  instances,
  locations,
  memberships,
  people,
  tenantFromRequest,
  units,
  type Database,
  type TenantTx,
  obligations,
} from '@canopy/db';
import { checkListFields, type ListTable } from './list-fields.js';
import {
  DuplicateError,
  type ListQuery,
  type ListResult,
  type NewRow,
  type Patch,
  type PersonReach,
  type PlanAllowance,
  type Repo,
  type Store,
  type Tx,
  type Where,
} from './store.js';

/**
 * The Store over M3's repositories (packages/db). Every transaction runs in `withTenant` with the request's tenant
 * context, so Postgres row-level security decides what the context sees and changes. This is the only M6 code that
 * needs the database, so it lives in service.ts and its coverage is counted by `pnpm test:db`.
 */

/** The calls M6 makes on an M3 aggregate (packages/db/src/repositories). */
interface Aggregate<T> {
  get(tx: TenantTx, id: string): Promise<T | null>;
  query(
    tx: TenantTx,
    q: {
      where?: Where<T>;
      search?: { text: string; fields: readonly (keyof T & string)[] };
      includeArchived?: boolean;
      orderBy?: keyof T & string;
      after?: { key: string; id: string } | null;
      limit?: number;
      count?: boolean;
    },
  ): Promise<{ items: T[]; total?: number }>;
  findAll(tx: TenantTx, where: Where<T>): Promise<T[]>;
  create(tx: TenantTx, input: never): Promise<T>;
  update?(tx: TenantTx, id: string, version: number, patch: never): Promise<T>;
  archive?(tx: TenantTx, id: string, version: number): Promise<T>;
  restore?(tx: TenantTx, id: string, version: number): Promise<T>;
}

/** The unique rule a table has and how to find the row a clash is with. */
interface UniqueRule<T> {
  constraint: string;
  field: string;
  find(tx: TenantTx, row: T): Promise<{ id: Id } | null>;
}

type Row = Record<string, unknown>;
const str = (row: Row, key: string) => row[key] as string;
const strOrNull = (row: Row, key: string) => (row[key] ?? null) as string | null;

const UNIQUE: Partial<Record<ListTable, UniqueRule<Row>>> = {
  companies: {
    constraint: 'company_name_key',
    field: 'name',
    find: (tx, r) => companies.findByName(tx, str(r, 'clientId'), str(r, 'name')),
  },
  units: {
    constraint: 'unit_name_key',
    field: 'name',
    find: (tx, r) => units.findByName(tx, str(r, 'companyId'), str(r, 'name')),
  },
  departments: {
    constraint: 'department_name_key',
    field: 'name',
    find: async (tx, r) =>
      (await departments.findAll(tx, { clientId: str(r, 'clientId'), name: str(r, 'name') }))[0] ??
      null,
  },
  locations: {
    constraint: 'location_path_key',
    field: 'location',
    find: (tx, r) =>
      locations.findByPath(tx, {
        countryCode: str(r, 'countryCode'),
        state: strOrNull(r, 'state'),
        city: strOrNull(r, 'city'),
      }),
  },
  people: {
    constraint: 'person_email_key',
    field: 'email',
    find: (tx, r) => people.findByEmail(tx, str(r, 'email')),
  },
  acts: {
    constraint: 'act_name_key',
    field: 'name',
    // act_name_key is per kind, and staff write only STATUTE acts (ISO-9b), so a clash is with one of those.
    find: async (tx, r) =>
      (await acts.findAll(tx, { name: str(r, 'name'), kind: 'STATUTE' }))[0] ?? null,
  },
  categories: {
    constraint: 'category_name_key',
    field: 'name',
    find: async (tx, r) => (await categories.findAll(tx, { name: str(r, 'name') }))[0] ?? null,
  },
  assignments: {
    constraint: 'assignment_unit_obligation_department_key',
    field: 'obligationId',
    find: (tx, r) =>
      assignments.findByKey(tx, {
        unitId: str(r, 'unitId'),
        obligationId: str(r, 'obligationId'),
        departmentId: str(r, 'departmentId'),
      }),
  },
};

function constraintOf(error: DbError): string | undefined {
  const cause = error.cause as { constraint?: string } | undefined;
  return cause?.constraint;
}

/**
 * Runs `fn` in a savepoint. A failed statement aborts the whole Postgres transaction, so a write that may fail runs
 * in a savepoint, leaving the transaction usable to look up the row a duplicate clashes with.
 */
function savepoint<T>(tx: TenantTx, fn: (sp: TenantTx) => Promise<T>): Promise<T> {
  return tx.transaction((sp) => fn(sp as TenantTx));
}

/** DUPLICATE as `DuplicateError`, naming the existing row when the context can see it; other errors unchanged. */
async function duplicateOf(
  tx: TenantTx,
  table: ListTable,
  error: unknown,
  row: Row,
): Promise<unknown> {
  if (!(error instanceof DbError) || error.code !== 'DUPLICATE') return error;
  const rule = UNIQUE[table];
  if (!rule || rule.constraint !== constraintOf(error)) return error;
  const existing = await rule.find(tx, row);
  return new DuplicateError(rule.field, existing?.id ?? null);
}

function repoOf<T extends { id: Id }>(
  tx: TenantTx,
  table: ListTable,
  aggregate: Aggregate<T>,
  create: (tx: TenantTx, values: NewRow<T>) => Promise<T>,
): Repo<T> {
  return {
    get: (id) => aggregate.get(tx, id),
    findAll: (where) => aggregate.findAll(tx, where),
    async list(query: ListQuery<T>): Promise<ListResult<T>> {
      checkListFields(table, query);
      const result = await aggregate.query(tx, {
        ...(query.where ? { where: query.where } : {}),
        ...(query.search
          ? {
              search: {
                text: query.search.text,
                fields: query.search.fields as readonly (keyof T & string)[],
              },
            }
          : {}),
        includeArchived: query.includeArchived === true,
        orderBy: query.orderBy,
        after: query.after ?? null,
        limit: query.limit,
        count: query.count === true,
      });
      return query.count
        ? { items: result.items, total: result.total ?? 0 }
        : { items: result.items };
    },
    async insert(values) {
      try {
        return await savepoint(tx, (sp) => create(sp, values));
      } catch (error) {
        throw await duplicateOf(tx, table, error, values as Row);
      }
    },
    async update(id, version, patch: Patch<T>) {
      const { archivedAt, ...fields } = patch as Patch<T> & { archivedAt?: string | null };
      const changesFields = Object.values(fields).some((v) => v !== undefined);
      if (archivedAt !== undefined && changesFields) {
        throw new Error('Archive or restore a row on its own, without other changes');
      }
      const write =
        archivedAt === undefined
          ? aggregate.update
            ? (sp: TenantTx) => aggregate.update!(sp, id, version, fields as never)
            : null
          : archivedAt === null
            ? aggregate.restore && ((sp: TenantTx) => aggregate.restore!(sp, id, version))
            : aggregate.archive && ((sp: TenantTx) => aggregate.archive!(sp, id, version));
      if (!write) throw new Error(`${table} rows are not changed through this store`);
      try {
        return await savepoint(tx, write);
      } catch (error) {
        if (error instanceof DbError) {
          if (error.code === 'STALE_VERSION') return 'STALE';
          if (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN') return null;
        }
        const current = await aggregate.get(tx, id);
        throw await duplicateOf(tx, table, error, { ...current, ...fields });
      }
    },
  };
}

export class PostgresStore implements Store {
  constructor(private readonly db: Database) {}

  transaction<T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withTenant(tenantFromRequest(ctx), (tx) => fn(this.tx(tx, ctx)));
  }

  private tx(tx: TenantTx, ctx: RequestContext): Tx {
    const repo = <T extends { id: Id }>(table: ListTable, aggregate: Aggregate<T>) =>
      repoOf(tx, table, aggregate, (sp, values) => aggregate.create(sp, values as never));
    return {
      clients: repo('clients', clients),
      companies: repo('companies', companies),
      units: repo('units', units),
      locations: repo('locations', locations),
      departments: repo('departments', departments),
      people: repo<Person>('people', people),
      memberships: repo<Membership>('memberships', memberships),
      acts: repo('acts', acts),
      categories: repo('categories', categories),
      obligations: repo('obligations', obligations),
      assignments: repo('assignments', assignments),
      instances: {
        reassignOpen: (assignmentId, to) => instances.reassignOpen(tx, assignmentId, to),
        replacePerson: (from, to) => instances.replacePerson(tx, from, to),
      },
      clientPersonIds: (clientId) => people.idsInClient(tx, clientId),
      firmStaffIds: () => people.firmStaffIds(tx),
      assignedObligationIds: () => assignments.obligationIds(tx),
      async planAllowance(limit): Promise<PlanAllowance> {
        await account.lockUsage(tx);
        const view = await account.get(tx);
        return { max: view.entitlements.limits[limit], used: view.usage[limit] };
      },
      // M3's security-definer app_person_reach: ids of clients this context may not see, for decisions only.
      personReach: (personId): Promise<PersonReach> => people.reach(tx, personId),
      async createPersonInClient(person, membership) {
        try {
          return await savepoint(tx, (sp) => people.createWithMembership(sp, person, membership));
        } catch (error) {
          throw await duplicateOf(tx, 'people', error, person as Row);
        }
      },
      audit: (event) =>
        auditEvents.append(tx, {
          clientId: event.clientId,
          requestId: ctx.requestId,
          actorId: ctx.personId,
          actorKind: 'PERSON',
          action: event.action,
          entityType: event.entityType,
          entityId: event.entityId,
          before: event.before,
          after: event.after,
          reason: event.reason ?? null,
        }),
      emit: (event) =>
        domainEvents.enqueue(tx, {
          type: event.type,
          clientId: event.clientId,
          actor: { kind: 'PERSON', personId: ctx.personId },
          requestId: ctx.requestId,
          aggregate: event.aggregate,
          aggregateVersion: event.aggregateVersion,
          data: event.data,
        }),
    };
  }
}

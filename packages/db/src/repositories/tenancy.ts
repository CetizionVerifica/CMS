import {
  Client,
  Company,
  Department,
  Firm,
  FirmSettings,
  Location,
  Membership,
  Person,
  Unit,
} from '@canopy/contracts';
import { and, arrayContains, eq, isNull, or, sql } from 'drizzle-orm';
import type { TenantTx } from '../database.js';
import { DbError, rethrow } from '../errors.js';
import * as s from '../schema/index.js';
import { instantsToDates } from './convert.js';
import { entity, type NewEntity, type PageRequest, type ServerFields } from './crud.js';

/** Firm, clients, entities and people (domain-model.md §3). */

// The firm row is its own tenant: the contract's firmId is its id.
const firmEntity = entity<Firm>({
  table: s.firm,
  schema: Firm,
  fromRow: (row) => ({ ...row, firmId: row.id }),
});

export const firms = {
  /** The transaction's own firm. */
  async current(tx: TenantTx): Promise<Firm> {
    const [row] = await tx.select().from(s.firm).catch(rethrow);
    if (!row) throw new DbError('NOT_FOUND', 'No firm in this context');
    return firmEntity.parse(row);
  },
  async update(
    tx: TenantTx,
    version: number,
    patch: { name?: string; settings?: FirmSettings },
  ): Promise<Firm> {
    const current = await firms.current(tx);
    return firmEntity.update(tx, current.id, version, patch);
  },
};

const clientEntity = entity<Client>({ table: s.client, schema: Client });
export const clients = {
  get: clientEntity.get,
  require: clientEntity.require,
  /** The clients this context may see. */
  list: (tx: TenantTx, page?: PageRequest) => clientEntity.list(tx, undefined, page),
  create: clientEntity.create,
  update: clientEntity.update,
  archive: clientEntity.archive,
  restore: clientEntity.restore,
};

const companyEntity = entity<Company>({ table: s.company, schema: Company });
export const companies = {
  get: companyEntity.get,
  require: companyEntity.require,
  list: (tx: TenantTx, clientId: string, page?: PageRequest) =>
    companyEntity.list(tx, eq(s.company.clientId, clientId), page),
  async findByName(tx: TenantTx, clientId: string, name: string): Promise<Company | null> {
    const [row] = await companyEntity.all(
      tx,
      and(eq(s.company.clientId, clientId), eq(s.company.name, name), isNull(s.company.archivedAt)),
    );
    return row ?? null;
  },
  create: companyEntity.create,
  update: companyEntity.update,
  archive: companyEntity.archive,
  restore: companyEntity.restore,
};

/** Locations have no version (contracts `Location` is Base only): create and look up, never edit. */
const locationEntity = entity<Location, Omit<Location, Exclude<ServerFields, 'version'>>>({
  table: s.location,
  schema: Location,
});
export const locations = {
  get: locationEntity.get,
  require: locationEntity.require,
  list: (tx: TenantTx, page?: PageRequest) => locationEntity.list(tx, undefined, page),
  /** By country code, state and city, case-insensitively (the unique path). */
  async findByPath(
    tx: TenantTx,
    path: { countryCode: string; state: string | null; city: string | null },
  ): Promise<Location | null> {
    const [row] = await locationEntity.all(
      tx,
      and(
        eq(s.location.countryCode, path.countryCode),
        sql`coalesce(lower(${s.location.state}), '') = ${(path.state ?? '').toLowerCase()}`,
        sql`coalesce(lower(${s.location.city}), '') = ${(path.city ?? '').toLowerCase()}`,
        isNull(s.location.archivedAt),
      ),
    );
    return row ?? null;
  },
  create: locationEntity.create,
};

const unitEntity = entity<Unit>({ table: s.unit, schema: Unit });
export const units = {
  get: unitEntity.get,
  require: unitEntity.require,
  list: (tx: TenantTx, clientId: string, page?: PageRequest) =>
    unitEntity.list(tx, eq(s.unit.clientId, clientId), page),
  async findByName(tx: TenantTx, companyId: string, name: string): Promise<Unit | null> {
    const [row] = await unitEntity.all(
      tx,
      and(eq(s.unit.companyId, companyId), eq(s.unit.name, name), isNull(s.unit.archivedAt)),
    );
    return row ?? null;
  },
  create: unitEntity.create,
  update: unitEntity.update,
  archive: unitEntity.archive,
  restore: unitEntity.restore,
};

const departmentEntity = entity<Department>({ table: s.department, schema: Department });
export const departments = {
  get: departmentEntity.get,
  require: departmentEntity.require,
  list: (tx: TenantTx, clientId: string, page?: PageRequest) =>
    departmentEntity.list(tx, eq(s.department.clientId, clientId), page),
  /** By exact name or a stored alias (import resolves "HR" to "Human Resources"). */
  async findByNameOrAlias(
    tx: TenantTx,
    clientId: string,
    name: string,
  ): Promise<Department | null> {
    const rows = await departmentEntity.all(
      tx,
      and(
        eq(s.department.clientId, clientId),
        isNull(s.department.archivedAt),
        or(eq(s.department.name, name), arrayContains(s.department.aliases, [name])),
      ),
    );
    return rows.find((d) => d.name === name) ?? rows[0] ?? null;
  },
  create: departmentEntity.create,
  update: departmentEntity.update,
  archive: departmentEntity.archive,
  restore: departmentEntity.restore,
};

const personEntity = entity<Person>({ table: s.person, schema: Person });
export const people = {
  get: personEntity.get,
  require: personEntity.require,
  list: (tx: TenantTx, page?: PageRequest) => personEntity.list(tx, undefined, page),
  /** Every non-archived person with this normalised name (a name is not unique). */
  findByNormalizedName: (tx: TenantTx, nameNormalized: string): Promise<Person[]> =>
    personEntity.all(
      tx,
      and(eq(s.person.nameNormalized, nameNormalized), isNull(s.person.archivedAt)),
    ),
  async findByEmail(tx: TenantTx, email: string): Promise<Person | null> {
    const [row] = await personEntity.all(
      tx,
      and(sql`lower(${s.person.email}) = ${email.toLowerCase()}`, isNull(s.person.archivedAt)),
    );
    return row ?? null;
  },
  /** Creates a person. Firm staff only: a client context cannot see the new row to return it. */
  create: personEntity.create,
  /**
   * Creates a person with their first client membership, in any context that can see that client.
   * A client context sees a person only once a membership exists, so the person goes in without
   * RETURNING and is read back after the membership (ADR 0003 decision 3).
   */
  async createWithMembership(
    tx: TenantTx,
    person: NewEntity<Person>,
    membership: Omit<NewEntity<Membership>, 'personId'>,
  ): Promise<{ person: Person; membership: Membership }> {
    const { rows } = await tx
      .execute<{ id: string }>(sql`SELECT canopy_uuid_v7() AS id`)
      .catch(rethrow);
    const id = rows[0]!.id;
    await tx
      .insert(s.person)
      .values({ ...person, id })
      .catch(rethrow);
    const created = await membershipEntity.create(tx, { ...membership, personId: id });
    return { person: await personEntity.require(tx, id), membership: created };
  },
  update: personEntity.update,
  archive: personEntity.archive,
  restore: personEntity.restore,
};

const membershipEntity = entity<Membership>({
  table: s.membership,
  schema: Membership,
  toRow: instantsToDates('expiresAt'),
});
export const memberships = {
  get: membershipEntity.get,
  require: membershipEntity.require,
  /** A person's non-archived memberships. Visible to the person themself in any context. */
  forPerson: (tx: TenantTx, personId: string): Promise<Membership[]> =>
    membershipEntity.all(
      tx,
      and(eq(s.membership.personId, personId), isNull(s.membership.archivedAt)),
    ),
  list: (tx: TenantTx, clientId: string, page?: PageRequest) =>
    membershipEntity.list(tx, eq(s.membership.clientId, clientId), page),
  /**
   * Adds a membership for a person this context can already see; NOT_FOUND otherwise, so a client
   * context cannot reveal someone by linking them to its client. New people: people.createWithMembership.
   */
  async create(tx: TenantTx, input: NewEntity<Membership>): Promise<Membership> {
    if (!(await personEntity.get(tx, input.personId))) throw new DbError('NOT_FOUND', 'Not found');
    return membershipEntity.create(tx, input);
  },
  async update(
    tx: TenantTx,
    id: string,
    version: number,
    patch: Partial<NewEntity<Membership>>,
  ): Promise<Membership> {
    if (patch.personId && !(await personEntity.get(tx, patch.personId))) {
      throw new DbError('NOT_FOUND', 'Not found');
    }
    return membershipEntity.update(tx, id, version, patch);
  },
  archive: membershipEntity.archive,
  restore: membershipEntity.restore,
};

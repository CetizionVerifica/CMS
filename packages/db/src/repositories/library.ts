import { Act, Category, Obligation } from '@canopy/contracts';
import { and, arrayContains, eq, isNull, or } from 'drizzle-orm';
import type { TenantTx } from '../database.js';
import * as s from '../schema/index.js';
import { entity, type PageRequest } from './crud.js';

/** Library: Acts, categories, obligations, firm-wide (domain-model.md §4). */

const actEntity = entity<Act>({ table: s.act, schema: Act });
export const acts = {
  get: actEntity.get,
  require: actEntity.require,
  query: actEntity.query,
  findAll: actEntity.findAll,
  list: (tx: TenantTx, page?: PageRequest) => actEntity.list(tx, undefined, page),
  /** By exact name or a stored alias. */
  async findByNameOrAlias(tx: TenantTx, name: string): Promise<Act | null> {
    const rows = await actEntity.all(
      tx,
      and(isNull(s.act.archivedAt), or(eq(s.act.name, name), arrayContains(s.act.aliases, [name]))),
    );
    return rows.find((a) => a.name === name) ?? rows[0] ?? null;
  },
  create: actEntity.create,
  update: actEntity.update,
  archive: actEntity.archive,
  restore: actEntity.restore,
};

const categoryEntity = entity<Category>({ table: s.category, schema: Category });
export const categories = {
  get: categoryEntity.get,
  require: categoryEntity.require,
  query: categoryEntity.query,
  findAll: categoryEntity.findAll,
  list: (tx: TenantTx, page?: PageRequest) => categoryEntity.list(tx, undefined, page),
  async findByNameOrAlias(tx: TenantTx, name: string): Promise<Category | null> {
    const rows = await categoryEntity.all(
      tx,
      and(
        isNull(s.category.archivedAt),
        or(eq(s.category.name, name), arrayContains(s.category.aliases, [name])),
      ),
    );
    return rows.find((c) => c.name === name) ?? rows[0] ?? null;
  },
  create: categoryEntity.create,
  update: categoryEntity.update,
  archive: categoryEntity.archive,
  restore: categoryEntity.restore,
};

/**
 * The recurrence rule is checked with the contract `RecurrenceRule` schema on every read and write. `clauseRefs` is
 * stored as the contract's `{ standard, clauseNumber }` objects (contracts 1.8.0) and always read back, `[]` when none.
 */
const obligationEntity = entity<Obligation>({ table: s.obligation, schema: Obligation });
export const obligations = {
  get: obligationEntity.get,
  require: obligationEntity.require,
  query: obligationEntity.query,
  findAll: obligationEntity.findAll,
  list: (tx: TenantTx, page?: PageRequest) => obligationEntity.list(tx, undefined, page),
  /** Non-archived obligations with this source ID (data, not a key: there may be several). */
  findByExternalRef: (tx: TenantTx, externalRef: string): Promise<Obligation[]> =>
    obligationEntity.all(
      tx,
      and(eq(s.obligation.externalRef, externalRef), isNull(s.obligation.archivedAt)),
    ),
  create: obligationEntity.create,
  update: obligationEntity.update,
  archive: obligationEntity.archive,
  restore: obligationEntity.restore,
};

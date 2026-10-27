import { Act, Category, Obligation } from '@canopy/contracts';
import { and, arrayContains, eq, isNull, or } from 'drizzle-orm';
import type { TenantTx } from '../database.js';
import * as s from '../schema/index.js';
import { actIdOfKind, actKindIs, type ActKindFilter } from './act-kind.js';
import { entity, type NewEntity, type PageRequest, type Query } from './crud.js';

/**
 * Library: Acts, categories, obligations, firm-wide (domain-model.md §4). The act and obligation lists take an
 * `actKinds` filter (docs/iso/plan.md §4.6); categories have no kind.
 */

/**
 * Create input for an act. `kind` is required on `Act` (contracts 1.8.8) but may be left out here: the column defaults
 * to STATUTE, and only the ISO catalogue copy creates a STANDARD act.
 */
export type NewAct = Omit<NewEntity<Act>, 'kind'> & Partial<Pick<Act, 'kind'>>;

const actEntity = entity<Act, NewAct>({ table: s.act, schema: Act });
export const acts = {
  get: actEntity.get,
  require: actEntity.require,
  query: (tx: TenantTx, q?: Query<Act>, filter: ActKindFilter = {}) =>
    actEntity.query(tx, q, actKindIs(filter.actKinds)),
  findAll: actEntity.findAll,
  list: (tx: TenantTx, page?: PageRequest, filter: ActKindFilter = {}) =>
    actEntity.list(tx, actKindIs(filter.actKinds), page),
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
 * Create input for an obligation. `clauseRefs` is required on `Obligation` (contracts 1.8.8) but may be left out here:
 * the column defaults to `[]`.
 */
export type NewObligation = Omit<NewEntity<Obligation>, 'clauseRefs'> &
  Partial<Pick<Obligation, 'clauseRefs'>>;

/**
 * The recurrence rule is checked with the contract `RecurrenceRule` schema on every read and write. `clauseRefs` is
 * stored as the contract's `{ standard, clauseNumber }` objects (contracts 1.8.0) and always read back, `[]` when none.
 */
const obligationEntity = entity<Obligation, NewObligation>({
  table: s.obligation,
  schema: Obligation,
});
export const obligations = {
  get: obligationEntity.get,
  require: obligationEntity.require,
  query: (tx: TenantTx, q?: Query<Obligation>, filter: ActKindFilter = {}) =>
    obligationEntity.query(tx, q, actIdOfKind(s.obligation.actId, filter.actKinds)),
  findAll: obligationEntity.findAll,
  list: (tx: TenantTx, page?: PageRequest, filter: ActKindFilter = {}) =>
    obligationEntity.list(tx, actIdOfKind(s.obligation.actId, filter.actKinds), page),
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

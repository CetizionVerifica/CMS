import { Id } from '@canopy/contracts';
import { and, asc, count, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { getTableColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { TenantTx } from '../database.js';
import { rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';
import {
  decodeCursor,
  encodeCursor,
  entity,
  pageLimit,
  type EntityConfig,
  type NewEntity,
  type Page,
} from './crud.js';

/**
 * Helpers shared by the ISO repositories (iso.ts, part 1; iso-records.ts, part 2): the unit scope of
 * docs/iso/plan.md §3.3 in SQL, keyset pages, and the join-table lists of model §1.4.
 */

/**
 * An approver's or owner's unit scope (plan §3.3), passed by M16 for a membership that lists units. A record is in
 * scope when its units overlap these, when it takes its management system's units and those overlap (a system with
 * no units covers every unit of the client), or when it names `personId` in one of its people fields. Leave the scope
 * out for a context that sees the whole client.
 */
export const UnitScope = z.strictObject({
  unitIds: z.array(Id).max(500),
  personId: Id.nullable(),
});
export type UnitScope = z.infer<typeof UnitScope>;

/** A page of ISO records; `total` when the caller asked for a count. */
export interface IsoPage<T> extends Page<T> {
  total?: number;
}

export const pageShape = {
  limit: z.int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(1000).nullable().optional(),
  count: z.boolean().optional(),
};

/** `{a,b}` as a uuid[] parameter; the ids are checked by the filter schemas first. */
export function uuids(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

/** A list filter: undefined means no filter, an empty list matches nothing. */
export function anyOf(column: PgColumn, values: readonly string[] | undefined): SQL | undefined {
  if (values === undefined) return undefined;
  return values.length === 0 ? sql`false` : inArray(column, [...values]);
}

/** The live units of a system, by its id column: in scope when it has none or one of `units`. */
export function systemUnitsMatch(systemId: PgColumn | SQL, units: readonly string[]): SQL {
  return sql`(not exists (select 1 from management_system_unit u where u.management_system_id = ${systemId} and u.archived_at is null)
    or exists (select 1 from management_system_unit u where u.management_system_id = ${systemId} and u.archived_at is null and u.unit_id = any(${uuids(units)})))`;
}

/** A record with an optional unit of its own: that unit, or (none) its system's units. */
export function unitOrSystemMatch(
  unitId: PgColumn,
  systemId: PgColumn,
  units: readonly string[],
): SQL {
  return sql`(${unitId} = any(${uuids(units)}) or (${unitId} is null and ${systemUnitsMatch(systemId, units)}))`;
}

/** The scope test for a record: its own units or its system's, or one of the people it names. */
export function inScope(
  scope: UnitScope | undefined,
  units: SQL,
  people: readonly (PgColumn | ((personId: string) => SQL))[] = [],
): SQL | undefined {
  if (!scope) return undefined;
  const personId = scope.personId;
  const named =
    personId === null
      ? []
      : people.map((p) => (typeof p === 'function' ? p(personId) : eq(p, personId)));
  return or(units, ...named);
}

/**
 * A keyset page in `sort` then id order. The cursor is the last row's id; the next page starts after that row's
 * sort value and id, as the evidence vault does.
 */
export async function keysetPage<T>(
  tx: TenantTx,
  q: {
    table: PgTable;
    id: PgColumn;
    sort: PgColumn;
    where: (SQL | undefined)[];
    page: { limit?: number; cursor?: string | null; count?: boolean };
    parse: (row: Record<string, unknown>) => T;
  },
): Promise<{
  rows: Record<string, unknown>[];
  items: T[];
  nextCursor: string | null;
  total?: number;
}> {
  const limit = pageLimit(q.page.limit);
  const filters = and(...q.where);
  const after = q.page.cursor ? decodeCursor(q.page.cursor) : null;
  const cursor = after
    ? sql`(${q.sort}, ${q.id}) > ((select x.${sql.identifier(q.sort.name)} from ${q.table} x where x.id = ${after}), ${after}::uuid)`
    : undefined;
  const rows = (await tx
    .select()
    .from(q.table)
    .where(and(filters, cursor))
    .orderBy(asc(q.sort), asc(q.id))
    .limit(limit + 1)
    .catch(rethrow)) as Record<string, unknown>[];
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? (page[page.length - 1] as { id: string }) : null;
  const result: {
    rows: Record<string, unknown>[];
    items: T[];
    nextCursor: string | null;
    total?: number;
  } = {
    rows: page,
    items: page.map(q.parse),
    nextCursor: last ? encodeCursor(last.id) : null,
  };
  if (q.page.count) {
    const [row] = await tx.select({ n: count() }).from(q.table).where(filters).catch(rethrow);
    result.total = row?.n ?? 0;
  }
  return result;
}

/** Record patches: what the database sets, the client and the parent never change. */
export type Patch<T, Fixed extends keyof T = never> = Partial<
  Omit<NewEntity<T>, 'clientId' | Fixed>
>;

// ---------- lists (join tables) ----------

/**
 * A list kept in a join table (model §1.4): rows of `table` whose `parent` column is the record's id, holding the
 * listed id in `value`, and with `role` when the table holds several lists. Removing an id archives its row.
 */
export interface Link {
  table: PgTable;
  parent: string;
  value: string;
  role?: string;
  max: number;
}

function linkColumns(link: Link) {
  const c = getTableColumns(link.table) as Record<string, PgColumn>;
  return {
    parent: c[link.parent]!,
    value: c[link.value]!,
    archivedAt: c.archivedAt!,
    role: link.role === undefined ? undefined : eq(c.role!, link.role),
  };
}

/** The live listed ids per parent, sorted. */
export async function linksOf(
  tx: TenantTx,
  link: Link,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const c = linkColumns(link);
  const rows = (await tx
    .select({ parentId: c.parent, value: c.value })
    .from(link.table)
    .where(and(inArray(c.parent, [...ids]), isNull(c.archivedAt), c.role))
    .orderBy(asc(c.value))
    .catch(rethrow)) as { parentId: string; value: string }[];
  for (const r of rows) out.get(r.parentId)?.push(r.value);
  return out;
}

/** Makes a parent's live list exactly `wanted`: rows for removed ids are archived, never deleted. */
export async function setLinks(
  tx: TenantTx,
  link: Link,
  parent: { id: string; clientId: string },
  wanted: readonly string[],
): Promise<void> {
  const ids = validate(z.array(Id).max(link.max), [...new Set(wanted)]);
  const c = linkColumns(link);
  await tx
    .update(link.table)
    .set({ archivedAt: sql`now()` } as never)
    .where(
      and(
        eq(c.parent, parent.id),
        isNull(c.archivedAt),
        c.role,
        ids.length ? sql`${c.value} <> all(${uuids(ids)})` : undefined,
      ),
    )
    .catch(rethrow);
  const live = (await linksOf(tx, link, [parent.id])).get(parent.id) ?? [];
  const added = ids.filter((id) => !live.includes(id));
  if (added.length) {
    await tx
      .insert(link.table)
      .values(
        added.map((id) => ({
          clientId: parent.clientId,
          [link.parent]: parent.id,
          [link.value]: id,
          ...(link.role !== undefined && { role: link.role }),
        })) as never,
      )
      .catch(rethrow);
  }
}

/** Units lists of part 1 (model §1.4). */
export const SYSTEM_UNITS: Link = {
  table: s.managementSystemUnit,
  parent: 'managementSystemId',
  value: 'unitId',
  max: 500,
};
export const CERTIFICATION_UNITS: Link = {
  table: s.certificationUnit,
  parent: 'certificationId',
  value: 'unitId',
  max: 500,
};

// ---------- records with lists ----------

/** A row as read, before its lists are added and the contract checks it. */
type Row = Record<string, unknown> & { id: string; clientId: string };

/**
 * Reads and writes for an ISO record whose contract shape holds lists kept in join tables (`links`, by contract
 * field). The row alone is not a valid contract value (its lists are missing, and refinements may read them), so
 * every result is checked against `schema` only once its lists are in: a write the contract rejects fails as
 * VALIDATION, and the caller's transaction with it. `assemble` places list fields the shape nests (an NC's
 * investigators sit in its incident).
 */
export function linkedRecord<T extends { id: string }, TNew, TPatch>(config: {
  table: PgTable;
  schema: z.ZodType<T>;
  links: Record<string, Link>;
  fromRow?: EntityConfig<Row>['fromRow'];
  toRow?: EntityConfig<Row>['toRow'];
  assemble?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Takes the list values out of an input: by default the `links` fields. */
  lists?: (input: Record<string, unknown>) => {
    fields: Record<string, unknown>;
    lists: Record<string, readonly string[] | undefined>;
  };
}) {
  const rowEntity = entity<Row, Record<string, unknown>, Record<string, unknown>>({
    table: config.table,
    schema: z.looseObject({ id: z.string(), clientId: z.string() }) as unknown as z.ZodType<Row>,
    ...(config.fromRow && { fromRow: config.fromRow }),
    ...(config.toRow && { toRow: config.toRow }),
  });
  const assemble = config.assemble ?? ((row) => row);
  const split =
    config.lists ??
    ((input: Record<string, unknown>) => {
      const fields = { ...input };
      const lists: Record<string, readonly string[] | undefined> = {};
      for (const field of Object.keys(config.links)) {
        lists[field] = fields[field] as readonly string[] | undefined;
        delete fields[field];
      }
      return { fields, lists };
    });

  async function complete(tx: TenantTx, rows: Row[]): Promise<T[]> {
    const lists: [string, Map<string, string[]>][] = [];
    for (const [field, link] of Object.entries(config.links)) {
      lists.push([
        field,
        await linksOf(
          tx,
          link,
          rows.map((r) => r.id),
        ),
      ]);
    }
    return rows.map((row) => {
      const full: Record<string, unknown> = { ...row };
      for (const [field, map] of lists) full[field] = map.get(row.id) ?? [];
      return validate(config.schema, assemble(full));
    });
  }

  async function writeLists(
    tx: TenantTx,
    row: Row,
    lists: Record<string, readonly string[] | undefined>,
  ): Promise<void> {
    for (const [field, ids] of Object.entries(lists)) {
      if (ids !== undefined) await setLinks(tx, config.links[field]!, row, ids);
    }
  }

  const record = {
    /** Rows read by a list query, with their lists. */
    complete,
    parseRow: (row: Record<string, unknown>) => rowEntity.parse(row),
    async get(tx: TenantTx, id: string): Promise<T | null> {
      const row = await rowEntity.get(tx, id);
      return row ? (await complete(tx, [row]))[0]! : null;
    },
    async require(tx: TenantTx, id: string): Promise<T> {
      return (await complete(tx, [await rowEntity.require(tx, id)]))[0]!;
    },
    async all(tx: TenantTx, filter: SQL | undefined): Promise<T[]> {
      const rows = (await rowEntity.all(tx, filter)).sort((a, b) => a.id.localeCompare(b.id));
      return complete(tx, rows);
    },
    async create(tx: TenantTx, input: TNew): Promise<T> {
      const { fields, lists } = split(input as Record<string, unknown>);
      const row = await rowEntity.create(tx, fields);
      await writeLists(tx, row, lists);
      return record.require(tx, row.id);
    },
    /** Optimistic update; a list in the patch replaces the live join rows (and bumps the version too). */
    async update(tx: TenantTx, id: string, version: number, patch: TPatch): Promise<T> {
      const { fields, lists } = split(patch as Record<string, unknown>);
      const row = await rowEntity.update(tx, id, version, fields);
      await writeLists(tx, row, lists);
      return record.require(tx, id);
    },
    async archive(tx: TenantTx, id: string, version: number): Promise<T> {
      return (await complete(tx, [await rowEntity.archive(tx, id, version)]))[0]!;
    },
  };
  return record;
}

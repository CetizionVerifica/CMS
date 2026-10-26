import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { TenantTx } from '../database.js';
import { DbError, rethrow, validate } from '../errors.js';

/**
 * Shared building blocks for the per-aggregate repositories. Every function takes a TenantTx, so it
 * runs inside `withTenant` and under RLS. Rows are returned as M0 contract types, parsed with the
 * contract schemas, so a repository never hands out a shape the contracts reject.
 */

export interface Page<T> {
  items: T[];
  /** Opaque; pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

export interface PageRequest {
  /** Default 50, max 200 (api-conventions.md §3). */
  limit?: number;
  cursor?: string | null;
  /** Include soft-deleted rows. Default false. */
  includeArchived?: boolean;
  /** Id order; ids are UUIDv7, so 'desc' is newest first. Default 'asc'. */
  order?: 'asc' | 'desc';
}

export const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Base and version fields the database sets; never part of create input. */
export type ServerFields = 'id' | 'firmId' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'version';

/** Create input for an entity: its fields minus the ones the database sets. */
export type NewEntity<T> = Omit<T, ServerFields>;

const SERVER_FIELDS: readonly ServerFields[] = [
  'id',
  'firmId',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'version',
];

/** Drops server-owned fields from a patch at runtime too, so a cast patch cannot set them. */
function withoutServerFields(patch: unknown): Record<string, unknown> {
  const values = { ...(patch as Record<string, unknown>) };
  for (const field of SERVER_FIELDS) delete values[field];
  return values;
}

/** Dates become ISO 8601 UTC strings; everything else is passed through. */
export function toWire(
  row: Record<string, unknown>,
  omit: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (omit.includes(key)) continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/** ISO instant strings (contract `Instant`) to Date for timestamptz columns. */
export function toDate(value: string | null | undefined): Date | null | undefined {
  return value === null || value === undefined ? value : new Date(value);
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new DbError('VALIDATION', 'Invalid cursor');
  return id;
}

export function pageLimit(limit: number | undefined): number {
  const n = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new DbError('VALIDATION', `limit must be 1-${MAX_LIMIT}`);
  }
  return n;
}

/** Equality per field, or membership for an array; null matches IS NULL. Every listed field must match. */
export type Where<T> = { [K in keyof T]?: T[K] | readonly T[K][] };

/** A filtered, searched page sorted by one field then id (keyset: `after` is the last row seen). */
export interface Query<T> {
  where?: Where<T>;
  /** Case-insensitive substring match on any of these fields. */
  search?: { text: string; fields: readonly (keyof T & string)[] };
  /** Archived rows are left out unless this is true. */
  includeArchived?: boolean;
  /** Sort field (default id); rows with no value sort first. */
  orderBy?: keyof T & string;
  /** The previous page's last row: its `orderBy` value as a string ('' for none) and id. */
  after?: { key: string; id: string } | null;
  limit?: number;
  /** Also count every row matching where, search and archive filter (ignoring cursor and limit). */
  count?: boolean;
}

export interface QueryResult<T> {
  items: T[];
  total?: number;
}

/** LIKE pattern for a literal substring. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

interface TableShape {
  id: PgColumn;
  archivedAt?: PgColumn;
  version?: PgColumn;
}

/** Repository config: the table, the contract schema rows parse into, and columns the contract leaves out. */
export interface EntityConfig<T> {
  table: PgTable;
  schema: z.ZodType<T>;
  /** Table columns not in the contract shape (e.g. `firmId` on import rows). */
  omit?: readonly string[];
  /** Adjusts a row before parsing, for columns the contract names differently. Default: as is. */
  fromRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Turns contract input into column values (Instant strings to Date and so on). Default: as is. */
  toRow?: (input: Record<string, unknown>) => Record<string, unknown>;
}

function cols(table: PgTable): TableShape {
  return getTableColumns(table) as unknown as TableShape;
}

/** Generic reads and writes for one table. Aggregates expose these under contract-typed names. */
export function entity<T, TNew = NewEntity<T>, TPatch = Partial<TNew>>(config: EntityConfig<T>) {
  const { table, schema, omit = [], toRow = (x) => x, fromRow = (x) => x } = config;
  const c = cols(table);
  const parse = (row: Record<string, unknown>): T => schema.parse(toWire(fromRow(row), omit));
  /** After a write: a row the contract rejects fails the call (and so the transaction) as VALIDATION. */
  const parseWritten = (row: Record<string, unknown>): T => {
    return validate(schema, toWire(fromRow(row), omit));
  };

  const allColumns = getTableColumns(table) as Record<string, PgColumn>;
  /** A contract field's column; VALIDATION for a field the table does not have. */
  function column(field: string): PgColumn {
    const col = Object.hasOwn(allColumns, field) ? allColumns[field] : undefined;
    if (!col || omit.includes(field)) throw new DbError('VALIDATION', `Unknown field: ${field}`);
    return col;
  }

  function whereSql(where: Where<T>): SQL | undefined {
    const parts = Object.entries(where as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => {
        const col = column(field);
        if (value === null) return isNull(col);
        if (Array.isArray(value)) return value.length === 0 ? sql`false` : inArray(col, value);
        return eq(col, value);
      });
    return parts.length ? and(...parts) : undefined;
  }

  async function selectWhere(tx: TenantTx, where: SQL | undefined): Promise<T[]> {
    const rows = await tx.select().from(table).where(where).catch(rethrow);
    return (rows as Record<string, unknown>[]).map(parse);
  }

  return {
    parse,
    parseWritten,

    /** One row by id, or null when it does not exist or is outside the tenant. */
    async get(tx: TenantTx, id: string): Promise<T | null> {
      const [row] = await selectWhere(tx, eq(c.id, id));
      return row ?? null;
    },

    /** One row by id; NOT_FOUND when it does not exist or is outside the tenant. */
    async require(tx: TenantTx, id: string): Promise<T> {
      const [row] = await selectWhere(tx, eq(c.id, id));
      if (!row) throw new DbError('NOT_FOUND', 'Not found');
      return row;
    },

    /** Keyset page in id order (UUIDv7, so roughly creation order). */
    async list(tx: TenantTx, filter: SQL | undefined, page: PageRequest = {}): Promise<Page<T>> {
      const limit = pageLimit(page.limit);
      const conditions = [filter];
      if (!page.includeArchived && c.archivedAt) conditions.push(isNull(c.archivedAt));
      const newestFirst = page.order === 'desc';
      if (page.cursor) {
        conditions.push((newestFirst ? lt : gt)(c.id, decodeCursor(page.cursor)));
      }
      const rows = (await tx
        .select()
        .from(table)
        .where(and(...conditions))
        .orderBy(newestFirst ? desc(c.id) : asc(c.id))
        .limit(limit + 1)
        .catch(rethrow)) as Record<string, unknown>[];
      const items = rows.slice(0, limit).map(parse);
      const last = rows.length > limit ? (rows[limit - 1] as { id: string }) : null;
      return { items, nextCursor: last ? encodeCursor(last.id) : null };
    },

    /** Every row matching `filter`, unpaged. For bounded sets (an instance's comments, a batch's issues). */
    all(tx: TenantTx, filter: SQL | undefined): Promise<T[]> {
      return selectWhere(tx, filter);
    },

    /** Every non-archived row matching `where`, unpaged. For small sets only. */
    findAll(tx: TenantTx, where: Where<T>): Promise<T[]> {
      return selectWhere(tx, and(whereSql(where), c.archivedAt ? isNull(c.archivedAt) : undefined));
    },

    /** A page by `Query`: where, search, archive filter, sort field then id, keyset cursor, total. */
    /** `filter` adds a condition `where` cannot say, such as a join (an obligation's act kind). */
    async query(tx: TenantTx, q: Query<T> = {}, filter?: SQL): Promise<QueryResult<T>> {
      const limit = pageLimit(q.limit);
      const filters: (SQL | undefined)[] = [whereSql(q.where ?? {}), filter];
      if (!q.includeArchived && c.archivedAt) filters.push(isNull(c.archivedAt));
      const text = q.search?.text.trim();
      if (q.search && text) {
        filters.push(
          or(...q.search.fields.map((f) => ilike(sql`${column(f)}::text`, containsPattern(text)))),
        );
      }
      const sortCol = column(q.orderBy ?? 'id');
      const page = [...filters];
      if (q.after) {
        page.push(
          q.after.key === ''
            ? or(isNotNull(sortCol), and(isNull(sortCol), gt(c.id, q.after.id)))
            : or(gt(sortCol, q.after.key), and(eq(sortCol, q.after.key), gt(c.id, q.after.id))),
        );
      }
      const rows = (await tx
        .select()
        .from(table)
        .where(and(...page))
        .orderBy(sql`${sortCol} asc nulls first`, asc(c.id))
        .limit(limit)
        .catch(rethrow)) as Record<string, unknown>[];
      const result: QueryResult<T> = { items: rows.map(parse) };
      if (q.count) {
        const [row] = await tx
          .select({ n: count() })
          .from(table)
          .where(and(...filters))
          .catch(rethrow);
        result.total = row?.n ?? 0;
      }
      return result;
    },

    /** Inserts and returns the row; the contract schema checks it before the transaction commits. */
    async create(tx: TenantTx, input: TNew): Promise<T> {
      const [row] = (await tx
        .insert(table)
        .values(toRow(input as Record<string, unknown>) as never)
        .returning()
        .catch(rethrow)) as Record<string, unknown>[];
      return parseWritten(row!);
    },

    async createMany(tx: TenantTx, inputs: readonly TNew[]): Promise<T[]> {
      if (inputs.length === 0) return [];
      const rows = (await tx
        .insert(table)
        .values(inputs.map((i) => toRow(i as Record<string, unknown>)) as never)
        .returning()
        .catch(rethrow)) as Record<string, unknown>[];
      return rows.map(parseWritten);
    },

    /**
     * Optimistic update: applies `patch` only if the row is still at `version`, then bumps it.
     * STALE_VERSION when someone else wrote first, NOT_FOUND when the row is missing, archived
     * or outside the tenant.
     */
    async update(tx: TenantTx, id: string, version: number, patch: TPatch): Promise<T> {
      return writeVersioned(tx, id, version, toRow(withoutServerFields(patch)), false);
    },

    /** Soft delete (no hard deletes, packages/db/CLAUDE.md rule 6). */
    async archive(tx: TenantTx, id: string, version: number): Promise<T> {
      return writeVersioned(tx, id, version, { archivedAt: sql`now()` }, false);
    },

    async restore(tx: TenantTx, id: string, version: number): Promise<T> {
      return writeVersioned(tx, id, version, { archivedAt: null }, true);
    },

    /** Unversioned update for tables without `version` (evidence scan status, export jobs). */
    async set(tx: TenantTx, id: string, patch: Record<string, unknown>): Promise<T> {
      const [row] = (await tx
        .update(table)
        .set(toRow(patch) as never)
        .where(eq(c.id, id))
        .returning()
        .catch(rethrow)) as Record<string, unknown>[];
      if (!row) throw new DbError('NOT_FOUND', 'Not found');
      return parseWritten(row);
    },
  };

  async function writeVersioned(
    tx: TenantTx,
    id: string,
    version: number,
    values: Record<string, unknown>,
    archived: boolean,
  ): Promise<T> {
    if (!c.version || !c.archivedAt) throw new Error('Table is not versioned');
    const [row] = (await tx
      .update(table)
      .set({ ...values, version: sql`${c.version} + 1` } as never)
      .where(
        and(
          eq(c.id, id),
          eq(c.version, version),
          archived ? sql`${c.archivedAt} is not null` : isNull(c.archivedAt),
        ),
      )
      .returning()
      .catch(rethrow)) as Record<string, unknown>[];
    if (row) return parseWritten(row);
    const [current] = (await tx
      .select({ version: c.version, archivedAt: c.archivedAt })
      .from(table)
      .where(eq(c.id, id))) as { version: number; archivedAt: Date | null }[];
    if (!current || (current.archivedAt !== null) !== archived) {
      throw new DbError('NOT_FOUND', 'Not found');
    }
    if (current.version !== version) {
      throw new DbError('STALE_VERSION', `Expected version ${current.version}`);
    }
    // Visible at this version but the UPDATE matched nothing: an RLS update policy refused it.
    throw new DbError('FORBIDDEN', 'Not allowed to change this row');
  }
}

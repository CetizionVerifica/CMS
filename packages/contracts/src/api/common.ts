import { z } from 'zod';
import { ErrorCode } from '../errors.js';
import { Id, Instant, LocalDate, LongText } from '../primitives.js';

/**
 * Building blocks shared by request and response schemas (docs/contracts/api-conventions.md §2-3).
 * Query schemas take the raw query-string values (strings) and output typed values.
 */

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
/** Most items a bulk endpoint accepts in one call. */
export const MAX_BULK_ITEMS = 200;
/** Largest import workbook accepted (api-conventions.md §5, FILE_TOO_LARGE). */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
/** Presigned upload and download URLs expire after 5 minutes (root CLAUDE.md non-negotiable 6). */
export const SIGNED_URL_TTL_SECONDS = 300;

// ---------- query-string values ----------

/** A comma-separated list in a query string, e.g. `?status=OVERDUE,DUE_SOON`. */
export function csv<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .string()
    .min(1)
    .transform((value) => value.split(','))
    .pipe(z.array(item).min(1));
}

/** `true` or `false` in a query string. */
export const QueryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');

/** A person id, or `me` for the signed-in person (api-conventions.md §3). */
export const PersonRef = z.union([Id, z.literal('me')]);

/** `?limit=` with the default and maximum from api-conventions.md §3. */
export const Limit = z
  .string()
  .regex(/^\d+$/, 'Expected a whole number')
  .transform(Number)
  .pipe(z.int().min(1).max(MAX_PAGE_LIMIT))
  .default(DEFAULT_PAGE_LIMIT);

/** Opaque cursor from the previous page's `nextCursor`. */
export const Cursor = z.string().min(1).max(1000);

/** Free-text search: at least 2 characters, matched case-insensitively. */
export const SearchText = z.string().trim().min(2).max(200);

export interface SortKey<F extends string> {
  field: F;
  direction: 'asc' | 'desc';
}

/** `?sort=dueDate,-criticality`: a comma list of the given fields, `-` for descending. Unknown fields are rejected. */
export function sortParam<const F extends readonly [string, ...string[]]>(fields: F) {
  const known = new Set<string>(fields);
  return z
    .string()
    .min(1)
    .transform((value, ctx): SortKey<F[number]>[] => {
      const keys: SortKey<F[number]>[] = [];
      for (const part of value.split(',')) {
        const descending = part.startsWith('-');
        const field = descending ? part.slice(1) : part;
        if (!known.has(field)) {
          ctx.addIssue({
            code: 'custom',
            message: `Cannot sort by "${field}"; sortable: ${fields.join(', ')}`,
          });
          return z.NEVER;
        }
        keys.push({ field: field as F[number], direction: descending ? 'desc' : 'asc' });
      }
      return keys;
    })
    .meta({ description: `Comma list of ${fields.join(', ')}; prefix "-" for descending.` });
}

/** Cursor pagination params every list endpoint takes. `count=true` adds `total`. */
export const pageQueryShape = {
  limit: Limit,
  cursor: Cursor.optional(),
  count: QueryBoolean.optional(),
};

/** "As at" date for derived status; FIRM_ADMIN, CONSULTANT and VIEWER only (api-conventions.md §1). */
export const asOfQueryShape = { asOf: LocalDate.optional() };

/** `fy` or `dueFrom`/`dueTo`, not both (api-conventions.md §3). */
export function checkPeriod(
  query: { fy?: unknown; from?: unknown; to?: unknown },
  ctx: z.core.$RefinementCtx,
  names: { from: string; to: string },
): void {
  if (query.fy !== undefined && (query.from !== undefined || query.to !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['fy'],
      message: `Use fy or ${names.from}/${names.to}, not both`,
    });
  }
}

// ---------- path params ----------

export const IdParams = z.strictObject({ id: Id });
export const ClientParams = z.strictObject({ clientId: Id });

// ---------- request bodies ----------

/** Optimistic concurrency token sent with every update (api-conventions.md §2). */
export const versionField = { version: z.int().min(1) };

/** Reason text for send back, NA, reopen, archive and due-date changes. */
export const Reason = LongText.max(2000);

export const ArchiveBody = z.strictObject({ ...versionField, reason: Reason });
export type ArchiveBody = z.infer<typeof ArchiveBody>;

export const RestoreBody = z.strictObject({ ...versionField });
export type RestoreBody = z.infer<typeof RestoreBody>;

/** Merge other records into this one, e.g. two spellings of one department. */
export const MergeBody = z.strictObject({
  ...versionField,
  sourceIds: z.array(Id).min(1).max(MAX_BULK_ITEMS),
});
export type MergeBody = z.infer<typeof MergeBody>;

/** An update must change something besides `version`. */
export function checkHasChanges(body: object, ctx: z.core.$RefinementCtx): void {
  if (Object.keys(body).every((key) => key === 'version')) {
    ctx.addIssue({ code: 'custom', message: 'Nothing to update' });
  }
}

// ---------- responses ----------

/** One page of a list: `{ items, nextCursor, total? }` (api-conventions.md §3). */
export function page<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    /** Only when `?count=true`. */
    total: z.int().min(0).optional(),
  });
}

/** A complete, unpaginated list. */
export function list<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item) });
}

/** Per-item results of a bulk call; the call itself returns 200 (api-conventions.md §5). */
export function bulkResults<T extends z.ZodType>(item: T) {
  return z.strictObject({
    results: z.array(
      z.strictObject({
        id: Id,
        ok: z.boolean(),
        error: z.strictObject({ code: ErrorCode, message: z.string().min(1) }).optional(),
        item: item.optional(),
      }),
    ),
  });
}

/** Per-item results of a bulk create, in request order; `item` is set when `ok`. */
export function bulkCreateResults<T extends z.ZodType>(item: T) {
  return z.strictObject({
    results: z.array(
      z.strictObject({
        index: z.int().min(0),
        ok: z.boolean(),
        error: z.strictObject({ code: ErrorCode, message: z.string().min(1) }).optional(),
        item: item.optional(),
      }),
    ),
  });
}

/** A presigned URL. It is never logged or stored and expires in 5 minutes. */
export const SignedUrl = z.strictObject({
  url: z.url(),
  expiresAt: Instant,
});
export type SignedUrl = z.infer<typeof SignedUrl>;

/** A presigned PUT: send the bytes to `url` with exactly these headers. */
export const UploadTicket = z.strictObject({
  uploadId: Id,
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: Instant,
});
export type UploadTicket = z.infer<typeof UploadTicket>;

/** Response body of 202/204 endpoints that return nothing. */
export const NoContent = z.null();

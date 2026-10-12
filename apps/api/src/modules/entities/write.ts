import type { AuditAction, EntityType, Id } from '@canopy/contracts';
import { notFound, stale } from './http/errors.js';
import type { Patch, Repo, Tx } from './store.js';

/**
 * Audited writes shared by the M6 services. Every change to an entity writes an AuditEvent with the changed
 * fields in the same transaction (root CLAUDE.md non-negotiable 2).
 */

/** The row, or 404 when it is missing, archived or outside what the context can see. */
export async function getLive<T extends { id: Id; archivedAt: string | null }>(
  repo: Repo<T>,
  id: Id,
): Promise<T> {
  const row = await repo.get(id);
  if (!row || row.archivedAt !== null) throw notFound();
  return row;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The fields of `patch` that differ from `row`, as `before` and `after` maps. */
export function changes<T extends object>(
  row: T,
  patch: Patch<T> | Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = (row as Record<string, unknown>)[key];
    if (!same(current, value)) {
      before[key] = current;
      after[key] = value;
    }
  }
  return { before, after };
}

type Versioned = { id: Id; version: number };

export interface AuditedUpdate<T extends Versioned> {
  tx: Tx;
  repo: Repo<T>;
  entityType: EntityType;
  row: T;
  version: number;
  patch: Patch<T>;
  clientId: Id | null;
  action?: AuditAction;
  reason?: string | null;
  /** Fields whose values are not written to the audit row (shown as changed only). */
  redact?: readonly string[];
}

/**
 * Updates a row at `version` and audits the changed fields. Stale version → 409 with the current version.
 * A patch that changes nothing still checks the version and returns the row unchanged, with no audit row.
 */
export async function auditedUpdate<T extends Versioned>(u: AuditedUpdate<T>): Promise<T> {
  if (u.row.version !== u.version) throw stale(u.row.version);
  const { before, after } = changes(u.row, u.patch);
  if (Object.keys(after).length === 0) return u.row;
  const updated = await u.repo.update(u.row.id, u.version, u.patch);
  if (updated === null) throw notFound();
  if (updated === 'STALE') {
    const current = await u.repo.get(u.row.id);
    throw stale(current?.version ?? u.row.version);
  }
  for (const key of u.redact ?? []) {
    if (key in after) {
      before[key] = '[redacted]';
      after[key] = '[redacted]';
    }
  }
  await u.tx.audit({
    clientId: u.clientId,
    action: u.action ?? 'UPDATE',
    entityType: u.entityType,
    entityId: u.row.id,
    before,
    after,
    reason: u.reason ?? null,
  });
  return updated;
}

/** Inserts a row and audits it as CREATE with its full contents. */
export async function auditedInsert<T extends { id: Id }>(
  tx: Tx,
  repo: Repo<T>,
  entityType: EntityType,
  values: Parameters<Repo<T>['insert']>[0],
  clientId: (row: T) => Id | null,
): Promise<T> {
  const row = await repo.insert(values);
  await tx.audit({
    clientId: clientId(row),
    action: 'CREATE',
    entityType,
    entityId: row.id,
    before: null,
    after: { ...values },
  });
  return row;
}

/** ISO instant for archive timestamps: UTC, second precision, ending in Z. */
export function instantOf(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

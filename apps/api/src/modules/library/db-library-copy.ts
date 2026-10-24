import type { Id } from '@canopy/contracts';
import {
  accountJobs,
  acts,
  auditEvents,
  categories,
  obligations,
  systemContext,
  type Database,
} from '@canopy/db';
import { checkMasterLibrary, MASTER_LIBRARY, type MasterLibrary } from './master.js';

export interface LibraryCopyReport {
  /** False when the account's library was already copied, or the account is no longer being set up. */
  copied: boolean;
  categories: number;
  acts: number;
  obligations: number;
}

/**
 * Copies the master library into a new account (ADR M15-0001 decision 8, ADR M6-0001), for M9's `account.created`
 * consumer. Runs in the account's own system context, so RLS scopes every row to it.
 *
 * Idempotent: the copy is recorded first, with `app_mark_library_copied()`, which sets the time only once and only
 * while the account is PROVISIONING. Its update locks the account row, so a second delivery running at the same
 * time waits, then finds the time set and copies nothing. A failed copy rolls the record back with it, and the
 * retried event copies again. Each row gets a CREATE audit row with actor SYSTEM.
 */
export async function copyMasterLibrary(
  db: Database,
  accountId: Id,
  requestId: string,
  library: MasterLibrary = MASTER_LIBRARY,
): Promise<LibraryCopyReport> {
  checkMasterLibrary(library);
  return db.withTenant(systemContext(accountId, requestId), async (tx) => {
    if (!(await accountJobs.markLibraryCopied(tx))) {
      return { copied: false, categories: 0, acts: 0, obligations: 0 };
    }
    const reason = `Master library version ${library.version}`;
    const created = (entityType: 'category' | 'act' | 'obligation', entityId: Id, after: object) =>
      auditEvents.append(tx, {
        clientId: null,
        requestId,
        actorId: null,
        actorKind: 'SYSTEM',
        action: 'CREATE',
        entityType,
        entityId,
        before: null,
        after: { ...after },
        reason,
      });

    const categoryIds = new Map<string, Id>();
    for (const { key, ...values } of library.categories) {
      const row = await categories.create(tx, values);
      categoryIds.set(key, row.id);
      await created('category', row.id, values);
    }
    const actIds = new Map<string, Id>();
    for (const { key, ...values } of library.acts) {
      const row = await acts.create(tx, values);
      actIds.set(key, row.id);
      await created('act', row.id, values);
    }
    for (const { act, category, ...rest } of library.obligations) {
      const values = {
        ...rest,
        actId: actIds.get(act)!,
        categoryId: categoryIds.get(category)!,
        libraryVersion: library.version,
      };
      const row = await obligations.create(tx, values);
      await created('obligation', row.id, values);
    }
    return {
      copied: true,
      categories: library.categories.length,
      acts: library.acts.length,
      obligations: library.obligations.length,
    };
  });
}

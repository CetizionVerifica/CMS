import { randomUUID } from 'node:crypto';
import type { Id } from '@canopy/contracts';
import {
  account,
  accountJobs,
  acts,
  auditEvents,
  categories,
  isoCatalogue,
  obligations,
  systemContext,
  type Database,
} from '@canopy/db';
import { checkIsoCatalogue, ISO_CATALOGUE, type IsoCatalogue } from './iso-catalogue.js';

export interface IsoCatalogueCopyReport {
  /** False when the account lacks the ISO add-on, already has the catalogue, or is not TRIAL or ACTIVE. */
  copied: boolean;
  standards: number;
  clauses: number;
  reviewDefs: number;
  /** Acts, categories and activities created; same-name ones already there are reused and not counted. */
  acts: number;
  categories: number;
  obligations: number;
}

const NOTHING: IsoCatalogueCopyReport = {
  copied: false,
  standards: 0,
  clauses: 0,
  reviewDefs: 0,
  acts: 0,
  categories: 0,
  obligations: 0,
};

/**
 * Copies the ISO catalogue into an account the first time its ISO add-on is on (docs/iso/plan.md §4.3, ADR M6-0003),
 * for M9's consumer. Runs in the account's own system context, so RLS scopes every row to it, and the STANDARD acts
 * are the only kind the system job may insert.
 *
 * Idempotent: the copy is recorded first, with `app_mark_iso_catalogue_copied()`, which sets the time only once and only
 * while the account is TRIAL or ACTIVE, locking the account row; a second delivery at the same time waits, then copies
 * nothing. A failed copy rolls the record back with it. A same-name STANDARD act and a same-name category are reused,
 * never a STATUTE act of the same name. Each act, category and activity created gets a CREATE audit row, actor SYSTEM.
 */
export async function copyIsoCatalogue(
  db: Database,
  accountId: Id,
  requestId: string,
  catalogue: IsoCatalogue = ISO_CATALOGUE,
): Promise<IsoCatalogueCopyReport> {
  checkIsoCatalogue(catalogue);
  return db.withTenant(systemContext(accountId, requestId), async (tx) => {
    if (!(await account.features(tx)).includes('isoManagement')) return NOTHING;
    if (!(await accountJobs.markIsoCatalogueCopied(tx))) return NOTHING;
    const report: IsoCatalogueCopyReport = { ...NOTHING, copied: true };
    const reason = `ISO catalogue version ${catalogue.version}`;
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

    const existing = await isoCatalogue.standards(tx);
    for (const { clauses, reviewInputs, reviewOutputs, ...values } of catalogue.standards) {
      if (existing.some((s) => s.code === values.code && s.edition === values.edition)) continue;
      const standard = await isoCatalogue.createStandard(tx, values);
      report.standards += 1;
      // Ids up front, so the whole tree goes in one statement with each parent before its children.
      const ids = new Map(clauses.map((c) => [c.number, randomUUID()]));
      const rows = await isoCatalogue.createClauses(
        tx,
        clauses.map(({ parent, ...c }) => ({
          ...c,
          id: ids.get(c.number)!,
          standardId: standard.id,
          parentId: parent === null ? null : ids.get(parent)!,
        })),
      );
      report.clauses += rows.length;
      const standardId = standard.id;
      const inputs = await isoCatalogue.createReviewInputDefs(
        tx,
        reviewInputs.map((d) => ({ ...d, standardId })),
      );
      const outputs = await isoCatalogue.createReviewOutputDefs(
        tx,
        reviewOutputs.map((d) => ({ ...d, standardId })),
      );
      report.reviewDefs += inputs.length + outputs.length;
    }

    const actIds = new Map<string, Id>();
    for (const { key, ...values } of catalogue.acts) {
      const [same] = await acts.findAll(tx, { name: values.name, kind: 'STANDARD' });
      if (same) {
        actIds.set(key, same.id);
        continue;
      }
      const act = { ...values, kind: 'STANDARD' as const };
      const row = await acts.create(tx, act);
      actIds.set(key, row.id);
      report.acts += 1;
      await created('act', row.id, act);
    }

    let [category] = await categories.findAll(tx, { name: catalogue.category });
    if (!category) {
      const values = { name: catalogue.category, aliases: [] };
      category = await categories.create(tx, values);
      report.categories += 1;
      await created('category', category.id, values);
    }

    for (const { key, act, ...rest } of catalogue.activities) {
      const actId = actIds.get(act)!;
      // An activity already filed under the act (an earlier copy someone restored) is not copied twice.
      if ((await obligations.findAll(tx, { actId, externalRef: `ISO-${key}` })).length > 0)
        continue;
      const values = {
        ...rest,
        actId,
        categoryId: category.id,
        libraryVersion: catalogue.version,
      };
      const row = await obligations.create(tx, values);
      report.obligations += 1;
      await created('obligation', row.id, values);
    }
    return report;
  });
}

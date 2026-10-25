import { FeatureFlag, Id, type AccountStatus, type KnownFeature } from '@canopy/contracts';
import { z } from 'zod';
import type { Consumer } from './consumers.js';
import type { IsoCatalogueCopier, JobDeps, JobReport, OutboxEvent } from './ports.js';

export const ISO_CATALOGUE_SWEEP = 'iso-catalogue-sweep';

const ISO: KnownFeature = 'isoManagement';

/** The marker sets nothing outside these, so the sweep copies only here (docs/iso/plan.md §4.3). */
const COPYABLE: readonly AccountStatus[] = ['TRIAL', 'ACTIVE'];

const FeaturesChangedData = z.object({
  accountId: Id,
  added: z.array(FeatureFlag),
  removed: z.array(FeatureFlag),
});

function copier(deps: JobDeps): IsoCatalogueCopier {
  if (!deps.copyIsoCatalogue) throw new Error('The ISO add-on needs copyIsoCatalogue');
  return deps.copyIsoCatalogue;
}

/**
 * Copies the ISO catalogue on `account.features_changed` when `added` has `isoManagement` (docs/iso/plan.md §4.3,
 * ISO-10a). The event lives in the account's own outbox, so one naming another account is refused. M6's copier
 * records the copy once, so a redelivered event copies nothing; `copied: false` (already copied, or the account not
 * yet in TRIAL or ACTIVE) acknowledges the event, and the sweep copies once the account can take it.
 */
async function copyOnSwitchOn(
  deps: JobDeps,
  event: OutboxEvent,
  requestId: string,
): Promise<JobReport> {
  const { accountId, added } = FeaturesChangedData.parse(event.data);
  if (accountId !== event.firmId) {
    throw new Error(
      'account.features_changed names another account than the one whose outbox it is in',
    );
  }
  if (!added.includes(ISO)) return { copied: 0 };
  const { copied } = await copier(deps)(accountId, requestId);
  return { copied: copied ? 1 : 0 };
}

/**
 * Every 10 minutes: copies the ISO catalogue into each TRIAL or ACTIVE account that has `isoManagement` and no recorded
 * copy, which covers an account created on a plan with the flag, one that moved into TRIAL or ACTIVE after the switch,
 * and a missed delivery (docs/iso/plan.md §4.3). Status and features are read once per account; each copy is its own
 * call, so one failure does not stop the others, and the job fails afterwards so pg-boss retries it.
 */
export async function runIsoCatalogueSweep(deps: JobDeps, requestId: string): Promise<JobReport> {
  const report: JobReport = { firms: 0, copied: 0, notCopied: 0 };
  const failures: unknown[] = [];
  for (const firmId of await deps.store.listFirmIds()) {
    try {
      const due = await deps.store.withFirm(firmId, requestId, async (tx) => {
        if (!COPYABLE.includes(await tx.accountStatus())) return false;
        const { features, isoCatalogueCopiedAt } = await tx.accountFeatures();
        return features.includes(ISO) && isoCatalogueCopiedAt === null;
      });
      if (!due) continue;
      report.firms! += 1;
      const { copied } = await copier(deps)(firmId, requestId);
      report[copied ? 'copied' : 'notCopied']! += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${ISO_CATALOGUE_SWEEP}: ${failures.length} account(s) failed`,
    );
  }
  return report;
}

export const ISO_CATALOGUE_CONSUMERS: readonly Consumer[] = [
  // Always registered: without the copier a switch-on throws and pg-boss retries it, so no event is dropped.
  { type: 'account.features_changed', handle: copyOnSwitchOn },
];

import type { KnownFeature } from '@canopy/contracts';
import type { FirmTx } from './ports.js';

export const ISO_FEATURE: KnownFeature = 'isoManagement';

/**
 * True while the account's ISO records are served: `isoManagement` is on and the ISO catalogue copy is recorded
 * (docs/iso/plan.md §4.3, §4.4). Otherwise the jobs leave STANDARD obligations and their instances alone: no
 * generation, reminders, escalations or workflow emails. Read inside the job's own transaction, so a switch-off made
 * after an event was queued is seen when the event is handled.
 */
export async function isoServed(tx: FirmTx): Promise<boolean> {
  const { features, isoCatalogueCopiedAt } = await tx.accountFeatures();
  return features.includes(ISO_FEATURE) && isoCatalogueCopiedAt !== null;
}

/** The STANDARD instances among `instanceIds` that the jobs must skip: none while the ISO add-on is served. */
export async function offInstanceIds(tx: FirmTx, instanceIds: string[]): Promise<Set<string>> {
  if (instanceIds.length === 0 || (await isoServed(tx))) return new Set();
  return new Set(await tx.standardInstanceIds(instanceIds));
}

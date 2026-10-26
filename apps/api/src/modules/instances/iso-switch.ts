import type { ActKind, ActivitySource, RequestContext } from '@canopy/contracts';
import { actKindOf, type TenantTx } from '@canopy/db';
import { ApiError, hasFeature } from '../../auth/index.js';

/**
 * The ISO add-on's off switch on instances and evidence (docs/iso/plan.md §4.4-4.6, ISO-11a). While it is off, the
 * instance list, `/me/approvals`, `/me/tasks` and the evidence vault leave STANDARD instances out, and every route that
 * names one STANDARD instance (or its evidence) answers 403 `FEATURE_NOT_ENABLED`. Off hides and refuses; it never
 * deletes. The client audit trail is not gated. The feature is read fresh on every request (M5's `hasFeature`).
 */

const isoOn = (ctx: RequestContext) => hasFeature(ctx, 'isoManagement');

const SOURCE_KINDS: Record<ActivitySource, readonly ActKind[]> = {
  LAW: ['STATUTE'],
  ISO: ['STANDARD'],
};

/**
 * The act kinds a list reads (plan §4.6): with the add-on on, `source` picks LAW or ISO and absent reads both; with it
 * off, STATUTE only and `source` is ignored.
 */
export async function listKinds(
  ctx: RequestContext,
  source: ActivitySource | undefined,
): Promise<{ actKinds?: ActKind[] }> {
  if (!(await isoOn(ctx))) return { actKinds: ['STATUTE'] };
  return source === undefined ? {} : { actKinds: [...SOURCE_KINDS[source]] };
}

/** 403 `FEATURE_NOT_ENABLED` for a STANDARD instance while the add-on is off; nothing otherwise. */
export async function refuseIsoInstanceWhenOff(
  tx: TenantTx,
  ctx: RequestContext,
  instanceId: string,
): Promise<void> {
  if (await isoOn(ctx)) return;
  if ((await actKindOf.instance(tx, instanceId)) === 'STANDARD') {
    throw new ApiError('FEATURE_NOT_ENABLED', { feature: 'isoManagement' });
  }
}

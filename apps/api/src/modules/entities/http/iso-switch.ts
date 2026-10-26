import type { ActKind, RequestContext } from '@canopy/contracts';
import { hasFeature } from '../../../auth/index.js';
import { HttpError } from './errors.js';

/**
 * The ISO add-on's off switch in the library and assignments (docs/iso/plan.md §4.4-4.5, ISO-9b): while it is off,
 * lists leave out rows under a STANDARD act and routes that name one answer 403 `FEATURE_NOT_ENABLED`. Off hides and
 * refuses; it never deletes. The feature is read fresh on every request (M5's `hasFeature`).
 */

const isoOn = (ctx: RequestContext) => hasFeature(ctx, 'isoManagement');

/** The `actKinds` a list reads: both kinds (absent) with the add-on on, STATUTE only while it is off. */
export async function readableKinds(
  ctx: RequestContext,
): Promise<{ actKinds?: readonly ActKind[] }> {
  return (await isoOn(ctx)) ? {} : { actKinds: ['STATUTE'] };
}

/** A missing kind is STATUTE, as the contract reads it. */
export const kindOf = (row: { kind?: ActKind | undefined }): ActKind => row.kind ?? 'STATUTE';

/** 403 `FEATURE_NOT_ENABLED` when `kind` is STANDARD and the add-on is off; nothing for a law or an unknown row. */
export async function refuseWhenOff(ctx: RequestContext, kind: ActKind | null): Promise<void> {
  if (kind === 'STANDARD' && !(await isoOn(ctx))) {
    throw new HttpError(
      'FEATURE_NOT_ENABLED',
      'ISO management systems is not turned on for your account.',
      { feature: 'isoManagement' },
    );
  }
}

/** True when every one of `kinds` is STANDARD and the add-on is off: none of those rows can be seen or changed. */
export async function hiddenWhileOff(
  ctx: RequestContext,
  kinds: readonly (ActKind | null)[],
): Promise<boolean> {
  return kinds.length > 0 && kinds.every((k) => k === 'STANDARD') && !(await isoOn(ctx));
}

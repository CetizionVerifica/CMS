import type { ComplianceInstance, RequestContext } from '@canopy/contracts';
import { DbError, instances, type TenantTx } from '@canopy/db';
import { ApiError } from '../../auth/index.js';
import { refuseIsoInstanceWhenOff } from './iso-switch.js';

/** Shared by M7's services: error mapping and loading an instance the actor may see. */

/** Repository errors carry contract codes; their messages name tables, so callers get the default text. */
export function toApiError(error: unknown): never {
  if (error instanceof DbError) throw new ApiError(error.code);
  throw error;
}

/**
 * Loads an instance the actor's tenant can see; NOT_FOUND otherwise (also outside the actor's clients). A STANDARD
 * instance answers 403 `FEATURE_NOT_ENABLED` while the ISO add-on is off (ISO-11a), before any role check.
 */
export async function loadInstance(
  tx: TenantTx,
  ctx: RequestContext,
  id: string,
): Promise<ComplianceInstance> {
  const instance = await instances.get(tx, id);
  if (
    instance === null ||
    instance.archivedAt !== null ||
    !ctx.clientIds.includes(instance.clientId)
  ) {
    throw new ApiError('NOT_FOUND');
  }
  await refuseIsoInstanceWhenOff(tx, ctx, instance.id);
  return instance;
}

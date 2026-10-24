'use server';
// Server Actions behind the entities screen: a client's companies and units. Arguments are checked against the
// contracts' schemas first (root rule 7); the API checks access and writes the audit events.
import {
  ArchiveBody,
  CompanyCreateBody,
  CompanyUpdateBody,
  Id,
  UnitCreateBody,
  UnitUpdateBody,
} from '@canopy/contracts';
import { revalidatePath } from 'next/cache';

import { isApiError } from '../../../../../../lib/api/client';
import { sessionApi } from '../../../../../../lib/api/server';

/** Adding a company or unit past the account's plan; the operator raises the limit. */
const PLAN_LIMIT =
  'Your plan’s company or unit limit is reached, so nothing was added. Your account admin can ask PlanetPulse to raise it.';

export type ActionResult = { ok: true } | { ok: false; message: string };

function failure(error: unknown, duplicate?: string): { ok: false; message: string } {
  if (duplicate && isApiError(error, 'DUPLICATE')) return { ok: false, message: duplicate };
  if (isApiError(error, 'STALE_VERSION')) {
    return {
      ok: false,
      message:
        'Someone else changed this while you were editing. The page now shows their version.',
    };
  }
  if (isApiError(error, 'NOT_FOUND')) {
    return {
      ok: false,
      message: 'This was removed in the meantime. The page now shows what is left.',
    };
  }
  if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
    return { ok: false, message: "You can no longer change this client's setup." };
  }
  if (isApiError(error, 'PLAN_LIMIT_REACHED')) return { ok: false, message: PLAN_LIMIT };
  if (isApiError(error, 'VALIDATION', 'INVALID_TRANSITION')) {
    return {
      ok: false,
      message: 'This change could not be saved. Check the values and try again.',
    };
  }
  throw error;
}

async function run(
  clientId: string,
  change: () => Promise<unknown>,
  /** What a DUPLICATE means here; archiving can't meet one. */
  duplicate?: string,
): Promise<ActionResult> {
  try {
    await change();
    return { ok: true };
  } catch (error) {
    return failure(error, duplicate);
  } finally {
    // Refresh on a refusal too, so a stale form shows the current record.
    revalidatePath(`/c/${clientId}/setup/entities`);
  }
}

const COMPANY_TAKEN = 'This client already has a company with that name.';
const UNIT_TAKEN = 'This company already has a unit with that name.';

export async function createCompanyAction(
  clientId: string,
  input: { name: string },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const body = CompanyCreateBody.parse(input);
  return run(
    id,
    async () => (await sessionApi()).call('createCompany', { params: { clientId: id }, body }),
    COMPANY_TAKEN,
  );
}

export async function renameCompanyAction(
  clientId: string,
  companyId: string,
  input: { version: number; name: string },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const company = Id.parse(companyId);
  const body = CompanyUpdateBody.parse(input);
  return run(
    id,
    async () => (await sessionApi()).call('updateCompany', { params: { id: company }, body }),
    COMPANY_TAKEN,
  );
}

export async function archiveCompanyAction(
  clientId: string,
  companyId: string,
  input: { version: number; reason: string },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const company = Id.parse(companyId);
  const body = ArchiveBody.parse(input);
  return run(id, async () =>
    (await sessionApi()).call('archiveCompany', { params: { id: company }, body }),
  );
}

export async function createUnitAction(
  clientId: string,
  input: { companyId: string; name: string; locationId: string },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const body = UnitCreateBody.parse(input);
  return run(
    id,
    async () => (await sessionApi()).call('createUnit', { params: { clientId: id }, body }),
    UNIT_TAKEN,
  );
}

export async function updateUnitAction(
  clientId: string,
  unitId: string,
  input: { version: number; companyId?: string; name?: string; locationId?: string },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const unit = Id.parse(unitId);
  const body = UnitUpdateBody.parse(input);
  return run(
    id,
    async () => (await sessionApi()).call('updateUnit', { params: { id: unit }, body }),
    UNIT_TAKEN,
  );
}

export async function archiveUnitAction(
  clientId: string,
  unitId: string,
  input: { version: number; reason: string },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const unit = Id.parse(unitId);
  const body = ArchiveBody.parse(input);
  return run(id, async () =>
    (await sessionApi()).call('archiveUnit', { params: { id: unit }, body }),
  );
}

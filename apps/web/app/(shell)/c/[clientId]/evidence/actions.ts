'use server';
// Server Actions behind the evidence vault. Every argument comes from the browser, so each is checked against the
// contracts' schemas first (root rule 7); the API then checks the person's access to the client and its units. Opening
// a file goes through the instance drawer's evidenceDownload, so both places fetch signed URLs the same way.
import { Cursor, EvidenceVaultQuery, Id } from '@canopy/contracts';
import { z } from 'zod';

import { serverApi } from '../../../../../lib/api/server';
import { loadVault, type VaultPage } from './_lib/vault-api';

/** A vault API query string (`vaultQuery`): filters only, no paging. */
const QueryString = z
  .string()
  .max(4000)
  .refine((q) => {
    const params = Object.fromEntries(new URLSearchParams(q));
    return (
      !('limit' in params || 'cursor' in params || 'count' in params) &&
      EvidenceVaultQuery.safeParse(params).success
    );
  }, 'Not a vault query');

export async function loadMoreEvidence(
  clientId: string,
  query: string,
  cursor: string,
): Promise<VaultPage> {
  return loadVault(
    await serverApi(),
    Id.parse(clientId),
    QueryString.parse(query),
    Cursor.parse(cursor),
  );
}

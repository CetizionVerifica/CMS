import type { OperatorTx } from '@canopy/db';

/** The days an account's own data stays after deletion (ADR M15-0002 decision 1); the purge function holds the same. */
export const GRACE_DAYS = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DeletionState {
  status: string;
  /** The 30 days are over by the database's clock, the one that stamped deletion_requested_at. */
  graceOver: boolean;
}

/**
 * Locks the account's row until the transaction ends and says where its deletion stands. The purge job holds this
 * lock while it deletes the account's files and rows, and a cancel takes it first, so a cancel waits for a purge in
 * progress and then finds the account DELETED. Null for an unknown account.
 */
export async function lockDeletion(
  tx: OperatorTx,
  accountId: string,
): Promise<DeletionState | null> {
  // The id goes into the text, as the API package has no query builder; only a uuid gets this far.
  const id = accountId.toLowerCase();
  if (!UUID.test(id)) return null;
  const { rows } = await tx.execute<{ status: string; grace_over: boolean | null }>(
    `SELECT status, deletion_requested_at <= now() - interval '${GRACE_DAYS} days' AS grace_over
       FROM firm WHERE id = '${id}' FOR UPDATE`,
  );
  const row = rows[0];
  return row ? { status: row.status, graceOver: row.grace_over === true } : null;
}

/** The days after its purge an account is swept again, for rows and files written while it was being purged. */
export const RESWEEP_DAYS = 7;

/**
 * Accounts DELETED whose deletion was requested within the last 30 + 7 days, by the database's clock: those purged
 * this past week, at the earliest on day 30. The purge job sweeps them again, files and rows.
 */
export async function recentlyDeleted(tx: OperatorTx): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(
    `SELECT id FROM firm WHERE status = 'DELETED'
       AND deletion_requested_at > now() - interval '${GRACE_DAYS + RESWEEP_DAYS} days'
     ORDER BY deletion_requested_at, id`,
  );
  return rows.map((r) => r.id);
}

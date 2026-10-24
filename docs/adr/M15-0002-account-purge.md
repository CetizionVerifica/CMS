# M15-0002. Purging a deleted account (M15)

- Status: accepted
- Date: 2026-10-24
- Module: M15, with the function in M3 and the job in M9

## Context

`packages/db/CLAUDE.md` rule 6 forbids hard deletes of instances, evidence and audit rows. A customer who leaves, or
whose contract ends, is owed the removal of their data (and evidence is personal data, root `CLAUDE.md` rule 6).
ADR M15-0001 decision 3 sends a deleted account through `PENDING_DELETION` for 30 days. This ADR is the one sanctioned
exception to "no hard deletes" and says how it is kept safe.

## Decisions

1. **Two steps, 30 days apart.** The operator requests deletion with a reason and the typed account name. `firm` records
   `deletion_requested_at` and `status_before_deletion`. During the grace period account admins can sign in to download
   the account export (M10), and the operator can cancel, which restores `status_before_deletion`. Both steps write
   operator audit events and the account's own audit event.
2. **One database function does the purge.** `platform_purge_account(firm_id uuid)` (M3, `SECURITY DEFINER`, owned by the
   migration owner, `EXECUTE` granted to `canopy_operator` only). It refuses (raises) unless the firm is
   `PENDING_DELETION` and `deletion_requested_at` is at least 30 days before `now()`. It deletes every row whose `firm_id`
   is that firm, table by table in foreign-key order, in one transaction, and sets the firm row to `DELETED` with
   `settings` reset to `{}`. It never takes a table name or a filter from its caller.
3. **What is kept.** The `firm` row as a tombstone (id, name, kind, created, deletion dates, status `DELETED`), the
   platform rows (`subscription`, `usage_snapshot`, `account_override`) needed for invoicing history, and every
   `operator_audit_event`. The account's own `audit_event` rows are purged with the rest of its data; the operator trail
   records `ACCOUNT_PURGE` with row counts per table (no row contents).
4. **Evidence files first.** Evidence keys already start with the firm's prefix. The M9 purge job deletes the account's
   storage prefix, then calls the function. Both steps are idempotent, so a crash between them is retried the next night.
   The job never lists or logs file names.
5. **Tests.** An isolation test seeds two firms with rows in every client-data table, purges one, and asserts the other
   firm's row counts and contents are unchanged and the purged firm has zero rows outside the kept list. A test asserts
   the function refuses inside the grace period, for any other status, and for the app role. A schema test fails when a
   new table with `firm_id` is not covered by the function, so a later table cannot be left behind.

## Consequences

- Deletion cannot be undone after the grace period. That is the point, and why it needs two operator actions and 30 days.
- Every new table holding firm data must be added to the purge function in the same migration; the schema test enforces it.

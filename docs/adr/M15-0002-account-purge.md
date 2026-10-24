# M15-0002. Purging a deleted account (M15)

- Status: accepted
- Date: 2026-10-24
- Module: M15, with the function in M3 and the job in M9

## Context

Root `CLAUDE.md` non-negotiable 2 says "Never update or delete audit rows", and `packages/db/CLAUDE.md` rule 6 forbids
hard deletes of instances, evidence and audit rows. The triggers `audit_event_append_only` and `audit_event_no_truncate`
(migration 0002) enforce that for every role, the table owner included. A customer who leaves, or whose contract ends,
is owed the removal of their data (and evidence is personal data, root non-negotiable 6). ADR M15-0001 decision 3 sends
a deleted account through `PENDING_DELETION` for 30 days. This ADR is the one sanctioned exception to **both** rules,
for a whole account at the end of its grace period and nothing else, and says how it is kept safe. Area files and ADRs
cannot relax root rules, so the rule texts are amended first (decision 6).

## Decisions

1. **Two steps, 30 days apart.** The operator requests deletion with a reason and the typed account name. `firm` records
   `deletion_requested_at` and `status_before_deletion`. During the grace period account admins can sign in to download
   the account export (M10), and the operator can cancel, which restores `status_before_deletion`. Both steps write
   operator audit events and the account's own audit event.
2. **One database function does the purge.** `platform_purge_account(firm_id uuid)` (M3, `SECURITY DEFINER`, owned by
   `canopy_purge`: no login, no `BYPASSRLS`; only the migration owner is a member, to hand it the function, as with
   `canopy_lookup`, and `createDatabase` refuses a request login that can become it; `EXECUTE` granted to
   `canopy_operator` only). It
   takes no table name or filter from its caller. In one transaction it: locks the firm row; raises unless the firm is
   `PENDING_DELETION` and `deletion_requested_at` is at least 30 days before `now()`; sets the firm to `DELETED` with
   `settings` reset to `{}`; deletes every row whose `firm_id` is that firm, table by table in foreign-key order, from a
   fixed list in the function body; and returns row counts per table. `canopy_purge` has DELETE (and SELECT on
   `firm_id`) on those tables and a `purge_delete` policy on each, `firm_id = app_firm_id()`, with `app.firm_id` set to
   the firm inside the function.
3. **How it gets past the append-only triggers, and only it.** `canopy_reject_audit_change()` (and the new
   `operator_audit_event` triggers, which have no exception) keeps raising for UPDATE and TRUNCATE always. For DELETE on
   `audit_event` it allows the row only when both hold: `current_user = 'canopy_purge'` (inside the definer function;
   no request login can become that role), and the row's firm is `DELETED` (read from `firm` at that moment).
   There is no settable flag or GUC. The firm can become `DELETED` only through the purge function: a `firm` trigger
   refuses `status = 'DELETED'` unless `current_user = 'canopy_purge'` and the old status is `PENDING_DELETION` past its
   grace period, and `canopy_app` has no UPDATE on `status` at all. Tests: DELETE on `audit_event` still fails for
   `canopy_app`, `canopy_operator` and the owner, for a live firm and for a `DELETED` one; TRUNCATE fails for all; UPDATE
   on a `DELETED` firm's audit rows fails; setting `DELETED` directly fails for the operator and the owner.
4. **What is kept.** The `firm` row as a tombstone (id, name, kind, created, deletion dates, status `DELETED`), the
   platform rows (`subscription`, `usage_snapshot`, `account_override`) needed for invoicing history, and every
   `operator_audit_event`, which is never deleted. The account's own `audit_event` rows are purged with the rest of its
   data; the operator trail records `ACCOUNT_PURGE` with row counts per table (no row contents).
5. **Evidence files first.** Evidence keys already start with the firm's prefix. The M9 purge job deletes the account's
   storage prefix, then calls the function. Both steps are idempotent, so a crash between them is retried the next night.
   The job never lists or logs file names.
6. **Tests.** An isolation test seeds two firms with rows in every client-data table, purges one, and asserts the other
   firm's row counts and contents are unchanged and the purged firm has zero rows outside the kept list. A test asserts
   the function refuses inside the grace period, for any other status, and for the app role. A schema test fails when a
   new table with `firm_id` is not covered by the function, so a later table cannot be left behind. The trigger tests of
   decision 3 run in the same file.
7. **Rules amended before the function merges.** Root `CLAUDE.md` non-negotiable 2 gains: "The one exception is
   `platform_purge_account` (ADR M15-0002), which removes a deleted account's rows, its audit trail included, after the
   30-day grace period." `packages/db/CLAUDE.md` rule 6 gains the same exception and the `canopy_purge` mechanism. The
   root edit is a Tooling PR, the db edit an M3 PR; the purge migration is a later M3 PR that lands after both.

## Consequences

- Deletion cannot be undone after the grace period. That is the point, and why it needs two operator actions and 30 days.
- Every new table holding firm data must be added to the purge function in the same migration; the schema test enforces it.

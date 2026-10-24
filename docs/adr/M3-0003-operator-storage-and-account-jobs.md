# ADR M3-0003: The operator's own storage and the account jobs

## Context
ADR M3-0002 stores customer accounts and builds the wall between the operator console and tenant data. The console
(M15) also needs its own sign-in, plans, overrides, offline subscriptions, usage history and audit trail. The owner's
invite has to be resendable, and M9 has to end trials and take nightly usage snapshots. This ADR records how
`packages/db` serves those needs. Migration 0023 and `src/repositories/platform.ts`.
It also gates the owner's acceptance on the library copy.

## Decisions
1. **Operator storage needs no tenant.** `operators`, `operatorSessions`, `plans`, `accountOverrides`,
   `subscriptions`, `usageSnapshots` and `operatorAudit` take an `OperatorTx`. They touch only the `platform` schema
   and the firm row, so none of them relies on `canopy_app`. Sign-in mirrors M5's customer credentials:
   - failures are counted in one statement, and the fifth in a row locks for the given minutes;
   - each TOTP step is accepted once (`acceptMfaStep`);
   - a session is found only while it is unrevoked, unexpired and its operator is not disabled;
   - disabling an operator ends their sessions.
   The idle limit belongs to the API (`lastSeenAt`).
2. **The override's version is the account's.** `PUT /accounts/{id}/override` checks the firm's `version`. The API
   bumps the firm's version with `platformAccounts.update` in the same transaction. The override row keeps its own
   counter only as a record.
3. **Renewals compare dates.** `subscriptions.renewals(today, withinDays)` takes the operator's date. It returns:
   - each account's latest subscription that ends in the window;
   - each TRIAL whose trial ends in the window.
   DELETED and PENDING_DELETION accounts are left out.
4. **Operator audit takes account fields only.** `operatorAudit.append` refuses `email`, `displayName`, `phone`,
   `ownerEmail` and `ownerName` in `before` or `after`, as `platform_record_account_event` does.
5. **Resending the owner's invite is a platform function.** `platform_resend_owner_invite(firm, expiresAt, operator,
   requestId)` works for a PROVISIONING account only, with an expiry within 30 days. It:
   - revokes the owner's open invites;
   - writes a new FIRM_ADMIN invite for the same person;
   - emits `person.invited`, from which M9 emails the link as for any invite.
6. **The M9 account jobs run in the account's own system context.** M9 runs on the tenant login, which can never
   become `canopy_operator` (ADR M3-0002 decision 6). The two jobs are therefore `app_*` functions owned by
   `canopy_platform`, which act on `app_firm_id()` only and refuse a context that is not firm-wide:
   - `app_end_trial(now, job)` suspends a TRIAL once `now`'s date in the account's time zone (`profile.timeZone`,
     default Asia/Kolkata) is after `trial_ends_on`. It writes the account audit row (actor SYSTEM),
     `account.status_changed` with actor `{ kind: SYSTEM, job }`, and the `ACCOUNT_SUSPEND` operator entry with
     reason "Trial ended".
   - `app_take_usage_snapshot(on)` writes `platform_usage` into `usage_snapshot` and replaces a snapshot already
     taken that day.
   M9 walks the accounts with the existing firm-id lookup and calls each job inside `withTenant(systemContext(id))`.
7. **The owner waits for the library copy** (ADR M15-0001 decision 8). `firm.library_copied_at` is new and nullable.
   Firms that had already left PROVISIONING are backfilled with their creation time. `app_mark_library_copied()` is
   for M6's `account.created` handler, which calls it in the transaction that copies the library. It sets `now()`
   once: only while the account is PROVISIONING, only while the time is unset, and only in a firm-wide context.
   `canopy_activate_account` now refuses (`check_violation`) to open a PROVISIONING account whose library is not
   copied yet, so the accepting transaction rolls back. `account.libraryCopied()` lets M5 refuse the owner's invite
   with the contract error first. The operator reads `AccountRecord.libraryCopiedAt`. The tenant `Firm` leaves it
   out until contracts 1.5.1.
8. **`P0002` is NOT_FOUND.** The platform functions raise `no_data_found` for an unknown account or grant.
   `rethrow` now maps it to `NOT_FOUND` alongside the other SQLSTATEs.

## Consequences
- `schema-rules` lists the four new functions: the `app_*` ones executable by `canopy_app` only,
  `platform_resend_owner_invite` by `canopy_operator` only.
- `platform.db.test.ts` covers each repository and both jobs with explicit dates and time zones.

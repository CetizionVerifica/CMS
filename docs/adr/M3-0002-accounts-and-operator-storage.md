# ADR M3-0002: Storage for customer accounts and the operator console

## Context

ADR M15-0001 makes each firm a customer account that PlanetPulse's operator creates, suspends and closes from a
console outside every tenant. This ADR records how `packages/db` stores that and enforces the wall. It refines the
database side of M15-0001 decision 8, which M3 owns. Migrations 0019 and 0020, and 0021, which carries the regenerated
M15 patch and the #140 audit fixes that missed that PR's merge.

## Decisions

1. **An account is a firm row.** `firm` gains `kind`, `status`, `plan_code` (FK to `platform.plan`), `trial_ends_on`,
   `onboarded_at`, `deletion_requested_at`, `status_before_deletion` and `profile jsonb`. The new NOT NULL columns
   were added nullable, backfilled (existing firms are `CONSULTANCY`, `ACTIVE`, plan `CONSULTANCY`) and then
   constrained. `profile` holds `legalName`, `gstin`, `timeZone` and `fyStartMonth` (contracts `AccountProfile`).
   CHECKs: a TRIAL has a trial end; PENDING_DELETION has the request time and the status it came from.
2. **The app role cannot change its own account.** `canopy_app` keeps UPDATE on `firm` only for `name`, `settings` and
   `version`. It has no USAGE on schema `platform`.
3. **Three roles, no logins, no BYPASSRLS.**
   - `canopy_operator`: the console's role. USAGE on `platform`, SELECT/INSERT/UPDATE on its tables
     (`operator_audit_event`: SELECT and INSERT only). In `public`, SELECT on `firm` and UPDATE on the account
     columns through `operator_read` / `operator_update` policies (never a `DELETED` firm), and SELECT on the
     non-personal columns of `support_grant`. Nothing else: every client table answers `42501`.
   - `canopy_platform`: owns the SECURITY DEFINER functions that cross the wall. It reads and writes tenant rows only
     inside them, after `canopy_platform_enter(firm)` sets that firm's settings; `canopy_platform_leave` restores
     the caller's.
   - `canopy_lookup` (ADR M3-0001) gains column grants for `person.support`, `firm.status` and the
     `support_grant_id` columns.
4. **Functions.** For the operator: `platform_create_account`, `platform_provision_account` (PROVISIONING with no people
   only), `platform_record_account_event` (the actions `CREATE`, `UPDATE` and `TRANSITION` only, and no person field at any depth
   of before/after), `platform_issue_support_token`,
   and `platform_usage`; nothing returns a person's name or email to the operator, who sees that the owner accepted
   when the status leaves `PROVISIONING`. A trigger on `auth_invite` (`canopy_activate_account`, nobody may call it)
   opens the account when a `FIRM_ADMIN` invite is accepted in `PROVISIONING`: `TRIAL` when `trial_ends_on` is set,
   else `ACTIVE`, with the account's audit row (actor: the owner), `account.status_changed` and the system's
   `ACCOUNT_ACTIVATE` operator entry, in the accepting transaction. For the app: `app_account()` (status, plan,
   effective limits and features) and `app_usage()` (whole-firm counts whatever the caller's client scope, for plan
   limits). A pending invite counts as a user. `platform_issue_support_token` takes the account id as well as the grant id: the console reads the grant
   under its own policy first, and a grant of another account, or one whose person is not the support person, is not
   found.
5. **Sign-in lookups carry the account status.** `canopy_login_candidates` and `canopy_find_session` return
   `account_status`, so M5 refuses a paused account without another query (after the password, never before).
   Support people are never candidates and `DELETED` accounts have none. `canopy_find_session` returns nothing for
   a support session whose grant was revoked or ran out, or a session of the support person without a grant.
   `canopy_find_login_token` ignores `SUPPORT` tokens and the support person's tokens; `SUPPORT` tokens are read only
   by `canopy_find_support_token`. Triggers owned by `canopy_lookup` refuse, for every role, a credential, a
   magic-link or invite token, an invite or a non-support session for the support person (audit of #140, Medium 3).
6. **Two logins in production.** The tenant login (`createDatabase`) must not be able to become `canopy_operator`,
   since that role reads every firm row: it is refused alongside superuser, BYPASSRLS, owner, `canopy_lookup` and
   `canopy_platform`. The console uses its own login (`createOperatorDatabase`), a member of `canopy_operator` only:
   it is refused when it can become `canopy_app` too, since a member of the app role could `SET ROLE` to it and set
   any firm's settings (audit of #140, Medium 1). So the console never runs inside a tenant: the M6 master library
   copy runs on the app side, from the `account.created` outbox event, in `systemContext(newAccount)`. This amends
   M15-0001 decision 8, which had one login for both and ran the copy as the app role in the provisioning
   transaction.
7. **The support person is fixed.** A restrictive policy on `person` stops every context updating a row with
   `support = true` (name, email, status, archive) or setting `support` on anyone; only `supportGrants.create` inserts
   it. Its memberships end with the grant (`supportGrants.revoke`, `closeExpired`). A support token may live at most
   90 seconds in the database (`SUPPORT_TOKEN_SECONDS` is 60; the rest is clock skew). Repositories return
   `support: true` on that person only. A grant is revoked, never re-pointed or stretched: `canopy_app` may UPDATE
   only `revoked_at`, `revoked_by_id` and `updated_at`, and a CHECK caps it at 30 days (`SUPPORT_GRANT_MAX_DAYS`).
8. **Operator audit is append-only for everyone.** Triggers reject UPDATE, DELETE and TRUNCATE on
   `platform.operator_audit_event`, the owner included. The account purge (ADR M15-0002) leaves it alone.
9. **The deletion clock is the database's.** A trigger on `firm` sets `deletion_requested_at = now()` when an account
   moves into `PENDING_DELETION` and refuses any other change to it but clearing it on cancel, for every role. So the
   30-day grace of ADR M15-0002 cannot be shortened by backdating (audit of #140, Medium 2).

## Consequences

- Deploy: an administrator creates `canopy_operator` and `canopy_platform` once (as for `canopy_lookup`) and makes the
  migrating owner a member of `canopy_platform` (it hands the functions to it). The console's login is a third
  login: `OPERATOR_DATABASE_URL`, needed only where `PLATFORM_ENABLED=true`.
- The `support_grant` table has an isolation fixture (`populateSupport`); `schema-rules` checks the operator grants,
  policies and function owners; `accounts.db.test.ts` runs every client table as `canopy_operator`.
- AuditActorKind `OPERATOR` and EntityType `account` are stored ahead of contracts 1.5.1, as NotificationKind was.

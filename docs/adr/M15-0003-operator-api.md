# ADR M15-0003: The operator API

## Context

ADR M15-0001 decides what the PlanetPulse operator can do to an account; M0 1.5.0 gives the routes
(`PLATFORM_ENDPOINTS`) and M3 the storage (ADR M3-0002). This ADR records the choices the API makes inside
`apps/api/src/platform/` that neither of those fixes.

## Decisions

1. **One mount, its own session.** Every operator route lives under `/api/platform/v1`, behind the IP allowlist (an
   address outside it answers `404`, so the console is not discoverable) and the `op_sid` cookie (path `/api/platform`,
   `HttpOnly`, `Secure`, `SameSite=Strict`). Sessions end 8 hours after sign-in or after 30 idle minutes; an idle
   session is revoked when it is next used. Unsafe methods need the session's CSRF token in `x-csrf-token`. Customer
   sessions never reach these routes and the operator cookie never reaches customer routes.
2. **Responses are parsed with the contract.** `mountPlatform` parses params, query and body with the endpoint's
   schemas and parses the response before sending it, so a route cannot leak a field the contract does not name (for
   example the account's `statusBeforeDeletion`). `Account.libraryCopiedAt` (contracts 1.5.1) shows when the master
   library was copied, so the console can flag a PROVISIONING account still waiting for it.
3. **Idempotency is kept in the process for 24 hours.** `POST /accounts` and `POST /accounts/{id}/subscriptions` take an
   `Idempotency-Key` (a UUID). A repeat with the same key and body from the same operator returns the first answer; the
   same key with another body is `400 VALIDATION`. One operator and one API process make a table unnecessary for now;
   a restart forgets the keys, and a retried create after a restart can make a second PROVISIONING account, which the
   operator can delete. A durable table follows if the console ever runs on more than one process.
4. **A blank reason is refused at the edge.** The contract's `Reason` is trimmed and needs at least one character, so
   a blank reason on suspend, resume, convert, plan change, override or deletion answers `400 VALIDATION` naming
   `body.reason`, not the `422 REASON_REQUIRED` that ADR M15-0001 decision 12 mentions. The rule (a typed reason) is the
   same; only the code differs, and changing it would mean loosening the contract.
5. **Every change writes both trails in one transaction.** `trail()` appends the operator audit entry (with the
   request id and IP) and, for a change to one account, calls `platform_record_account_event` with the account's audit
   action and its domain event (`account.status_changed`, `account.plan_changed`). Those account entries carry no
   client, so the customer's audit routes, which always read by client, do not list them yet; the account page that
   shows them comes with contracts 1.5.1 (`AuditActorKind` `OPERATOR`, `EntityType` `account`).
6. **Optimistic versions on every account change.** Each change names the account `version` it read; a stale one is
   `409 STALE_VERSION { currentVersion }`. An override change bumps the version too, so two operators cannot overwrite
   each other's limits.
7. **The support session opens in the app, not the console.** `POST /support-grants/{id}/sessions` checks the grant
   is live (`ACCESS_EXPIRED { expiredAt }` otherwise), issues a 60-second one-time token and answers
   `${APP_URL}/support/start#token=…`. The token travels in the fragment, so no proxy or access log records it; the web
   app's `/support/start` page posts it to `POST /auth/support/verify` (ADR M5-0002 decision 4). `APP_URL` is required
   when the platform is enabled.
8. **The trial clock is India's.** `operatorToday` reads the date in Asia/Kolkata, the operator's time zone, for trial
   ends, renewals and the "not in the past" check on a trial extension. A new trial ends 30 days after creation.
9. **Lists are filtered and paged in the API.** Accounts number in the hundreds at most, so `GET /accounts` reads them
   all and filters by status, kind, plan and search text, newest first, with an opaque cursor. A database-side page
   follows when that stops being true.

10. **The allowlist is required in production.** Ten failed sign-ins lock an operator for 15 minutes, so anyone who
    can reach the sign-in route can keep the operator locked out. With `NODE_ENV=production`, `PLATFORM_ENABLED=true`
    without `PLATFORM_IP_ALLOWLIST` fails the boot (the API wiring), so only the operator's own addresses reach it.
11. **Lockouts are not yet in the operator audit.** A lockout shows in the API log only; an `OPERATOR_LOCKED` action
    needs a contracts and database enum change, and follows with the next operator-audit change.

## Consequences

- Contracts 1.5.1 (M0) adds `AuditActorKind` `OPERATOR`, `EntityType` `account` and `Account.libraryCopiedAt`, so a
  reader that lists account entries without a client filter can parse them; this API needs it merged first.
- Each route has a Postgres test in `db-accounts.db.test.ts` and `db-auth.db.test.ts`, run as `canopy_operator`.

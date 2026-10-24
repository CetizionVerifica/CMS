# apps/api/src/platform: the operator API (M15)

`apps/api/CLAUDE.md` and the root `CLAUDE.md` apply. Decisions: `docs/adr/M15-0001-operator-controlled-accounts.md`
(decisions 8, 9, 11, 12), `docs/adr/M15-0003-operator-api.md` (this API's own choices), `docs/adr/M15-0004-customer-account-routes.md` (the
customer's `/account` routes), `docs/adr/M15-0005-operator-digest.md` (the operator's daily renewals email) and
`docs/adr/M3-0003-operator-storage-and-account-jobs.md`.

## Rules here

- Routes are mounted under `/api/platform/v1` by `registerPlatform`, only when the server gets `platform` options
  (`PLATFORM_ENABLED=true`). Mount each one with `mountPlatform` from `PLATFORM_ENDPOINTS`: path, method, status and
  schemas come from the contract, and every response is parsed with its schema before it is sent.
- To M5 every operator route is `public`: the customer `sid` is never read here. The operator session hook checks
  `op_sid` (path `/api/platform`, SameSite Strict), the 30-minute idle limit, the 8-hour expiry and the session's CSRF
  token on every state-changing request.
- Every operator query runs in `OperatorDatabase.withOperator`, as `canopy_operator`. Never open a tenant context in an
  operator route: the operator reaches an account only through M3's `platform*` repositories and the `platform_*`
  functions.
- The customer's own routes (`db-customer.ts`, `/api/v1/account*`) are the exception: they run on the customer
  session, in the request's tenant context, and never touch the operator login. A support session never manages
  support access (ADR M15-0004 decision 2).
- Import from M5 only through `../auth/index.ts`.
- Operators are created only by `pnpm --filter @canopy/api platform:add-operator` (`db-operators.ts`). No route
  creates one.
- Every operator action that changes an account writes the operator audit and the account's own audit trail in the
  same transaction. Operator audit never carries a person's name or email.
- Never log a token, a password, a TOTP secret or the otpauth URI.
- Production needs `PLATFORM_IP_ALLOWLIST`: the sign-in lockout would otherwise let anyone lock the operator out (ADR
  M15-0003 decision 10). Support-session links go to `APP_URL` with the token in the fragment, never the query.
- Files that need the database are `db-*.ts` and are tested in `*.db.test.ts` against Postgres; the rest are pure and
  unit tested.
- The operator's daily renewals email (`db-digest.ts`) is a `JobDefinition` M9's runner runs; it reads on the operator
  login like the routes and sends account names and dates only.
- The nightly account purge (`db-purge.ts`, ADR M15-0002 decision 5) is also a `JobDefinition`, on the operator login:
  only `canopy_operator` may call `platform_purge_account`. It deletes the account's `evidence/`, `imports/` and
  `exports/` prefixes (`purge-objects.ts`) before its rows, and never logs or returns an object key.

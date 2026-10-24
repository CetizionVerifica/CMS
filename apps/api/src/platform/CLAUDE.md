# apps/api/src/platform: the operator API (M15)

`apps/api/CLAUDE.md` and the root `CLAUDE.md` apply. Decisions: `docs/adr/M15-0001-operator-controlled-accounts.md`
(decisions 8, 9, 11, 12) and `docs/adr/M3-0003-operator-storage-and-account-jobs.md`.

## Rules here

- Routes are mounted under `/api/platform/v1` by `registerPlatform`, only when the server gets `platform` options
  (`PLATFORM_ENABLED=true`). Mount each one with `mountPlatform` from `PLATFORM_ENDPOINTS`: path, method, status and
  schemas come from the contract, and every response is parsed with its schema before it is sent.
- To M5 every operator route is `public`: the customer `sid` is never read here. The operator session hook checks
  `op_sid` (path `/api/platform`, SameSite Strict), the 30-minute idle limit, the 8-hour expiry and the session's CSRF
  token on every state-changing request.
- Every query runs in `OperatorDatabase.withOperator`, as `canopy_operator`. Never open a tenant context here: the
  operator reaches an account only through M3's `platform*` repositories and the `platform_*` functions.
- Import from M5 only through `../auth/index.ts`.
- Operators are created only by `pnpm --filter @canopy/api platform:add-operator` (`db-operators.ts`). No route
  creates one.
- Every operator action that changes an account writes the operator audit and the account's own audit trail in the
  same transaction. Operator audit never carries a person's name or email.
- Never log a token, a password, a TOTP secret or the otpauth URI.
- Files that need the database are `db-*.ts` and are tested in `*.db.test.ts` against Postgres; the rest are pure and
  unit tested.

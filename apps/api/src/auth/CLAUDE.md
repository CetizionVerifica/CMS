# apps/api/src/auth: sessions, MFA, permissions (M5)

`apps/api/CLAUDE.md` and the root `CLAUDE.md` apply. Decisions: `docs/adr/0005-m5-policy-and-request-context.md`
(policy, context) and `docs/adr/M5-0001-sign-in-mfa-invites.md` (sign-in, MFA, invites).

## For other modules

- Import only from `./index.ts`.
- Every route declares `config: { auth: 'public' | 'session' | 'session-pre-mfa' }`; registration throws without it.
- On session routes `req.ctx` is the M0 `RequestContext`. Missing session, MFA, expired access, CSRF and a `:clientId`
  outside the actor's clients are answered before your handler.
- Check permissions with `authorize(req, action, resource)` (throws `FORBIDDEN`) or `can()`. Pass `ownerId` and
  `approverId` on instance resources and `unitId` when known; pass `clientId: null` for firm-level resources.
- A client id from a body or a loaded row goes through `requireClient(ctx, clientId)` (404 outside the actor's clients).
- `clientId: null` means a firm-level resource, not "any client": client roles are denied there except on firm-wide
  rows (library, locations). For a list across the actor's clients, authorize per client or filter the query by
  `ctx.clientIds`.
- Accounts (ADR M5-0002): every session route answers `403 ACCOUNT_SUSPENDED` unless the account is TRIAL or ACTIVE.
  While it is PENDING_DELETION, account admins may still reach routes that set `config.whilePendingDeletion: true`,
  which only `/me`, logout and the account export do. `isSupportSession(req)` is true on a PlanetPulse support session.
  Refuse it where support must not act, such as the support-grant routes.
- Add-ons (ADR M16-0001): a route of an add-on declares `config.feature: 'isoManagement'` (or calls
  `await requireFeature(req.ctx, 'isoManagement')` where only part of a route is the add-on's). Unless the account
  has the feature, it answers `403 FEATURE_NOT_ENABLED { feature }`, reads included. Features are read from the store
  on every request, never from the session, so the operator's switch applies at once. `/me` lists them in
  `account.features`.
- `session-pre-mfa` routes exist only to finish MFA: `authorize()` there throws `MFA_REQUIRED` while MFA is owed.
- Stricter per-route rate limits use `config.routeLimit: { max, timeWindow }`. The plugin's `config.rateLimit` is
  refused, because the API-wide limiter would make it a no-op.
- Throw `ApiError(code, details?)` for contract errors.
- M9: when sending a magic-link or invite email, call `AuthService.issueLoginToken` for the raw token; it is never
  stored or put in an event.
- Tests: `createTestAuth()` from `./testing.ts`; `signIn({ memberships })` returns headers for `app.inject`.

## Rules here

- `POLICY` in `policy.ts` is the only permission table. Adding an action means a row there and a row in the matrix
  test (`policy.test.ts`), both following `docs/contracts/endpoints.md`.
- Tokens (sessions, CSRF, magic links, invites) are random 256-bit values; only their SHA-256 is stored. Never log a
  token, a password or an MFA secret.
- Storage goes through `AccountStore` (`accounts.ts`). Each method is one transaction and writes the audit and outbox
  rows its comment names. `InMemoryAuthStore` in `testing.ts` is the reference behaviour; `createDbAccountStore`
  (`db-store.ts`) is the database adapter on M3's repositories, tested end to end in `db-store.db.test.ts`.

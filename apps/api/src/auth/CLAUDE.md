# apps/api/src/auth: sessions, MFA, permissions (M5)

`apps/api/CLAUDE.md` and the root `CLAUDE.md` apply. Decisions: `docs/adr/0005-m5-policy-and-request-context.md`.

## For other modules
- Import only from `./index.ts`.
- Every route declares `config: { auth: 'public' | 'session' | 'session-pre-mfa' }`; registration throws without it.
- On session routes `req.ctx` is the M0 `RequestContext`. Missing session, MFA, expired access, CSRF and a `:clientId`
  outside the actor's clients are answered before your handler.
- Check permissions with `authorize(req, action, resource)` (throws `FORBIDDEN`) or `can()`. Pass `ownerId` and
  `approverId` on instance resources and `unitId` when known; pass `clientId: null` for firm-level resources.
- A client id from a body or a loaded row goes through `requireClient(ctx, clientId)` (404 outside the actor's clients).
- Throw `ApiError(code, details?)` for contract errors.
- Tests: `createTestAuth()` from `./testing.ts`; `signIn({ memberships })` returns headers for `app.inject`.

## Rules here
- `POLICY` in `policy.ts` is the only permission table. Adding an action means a row there and a row in the matrix
  test (`policy.test.ts`), both following `docs/contracts/endpoints.md`.
- Tokens (sessions, CSRF, magic links, invites) are random 256-bit values; only their SHA-256 is stored. Never log a
  token, a password or an MFA secret.

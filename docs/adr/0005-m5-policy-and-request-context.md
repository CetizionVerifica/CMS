# 0005. Permission policy and request context (M5)

- Status: accepted
- Date: 2026-10-12
- Module: M5 (`apps/api/src/auth`)

## Context
Contracts v1 fix the `can()` signature, the `RequestContext` shape (`domain-model.md` §8) and the role matrix
(`endpoints.md`). M6, M7, M8 and M10 call `can()` and read the context, so how routes get the context and how the
matrix's ambiguous cells are read must be settled before they build on it.

## Decisions

### How routes get the context
1. Every route declares `config.auth`: `public`, `session` or `session-pre-mfa`. Registering a route without it throws,
   so no route is reachable without a decision. Session routes get a per-route `onRequest` hook that builds the
   context before validation and the handler; `req.ctx` is the M0 `RequestContext`. Reading `req.ctx` on a public route
   throws.
2. The hook answers, in order: `401 UNAUTHENTICATED` (no, unknown or expired session; person not ACTIVE),
   `403 FORBIDDEN` (no membership) or `403 ACCESS_EXPIRED` (only expired memberships), `401 MFA_REQUIRED`
   (`{ enrolled }`), `403 FORBIDDEN` for a missing or wrong `X-CSRF-Token` on POST/PUT/PATCH/DELETE, and `404 NOT_FOUND`
   when a `:clientId` path parameter is outside `ctx.clientIds` (endpoints.md §1: outside the actor's clients is 404).
3. `asOf` is today in the path client's time zone, else `Asia/Kolkata` (the default client setting).
4. `ctx.memberships` holds only active memberships: not archived, and `expiresAt` (viewers) after now. A firm admin's
   `clientIds` are every client of the firm, archived ones included, so they can restore them.
5. MFA is enforced when the context is built (firm roles, when the firm setting `mfaRequiredForFirmRoles` is on), not
   inside `can()`, so a firm that turns MFA off still works.
6. Every request is rate limited per client IP (default 300 per minute) before the session lookup, so token guessing
   is throttled; over the limit is `429 RATE_LIMITED` with `{ retryAfterSeconds }`. Login, magic link and invite routes
   add stricter limits with `config.routeLimit`, which has its own counters and is checked in a route hook. The
   plugin's `config.rateLimit` is refused, because the API-wide limiter marks the request and would make it a no-op. The limit counts in process memory; with several API instances it needs a shared
   store, and behind a proxy Fastify's `trustProxy` must be set so the client IP is real.
7. `session-pre-mfa` routes only complete MFA: while MFA is owed there, `authorize()` throws `MFA_REQUIRED` instead of
   answering from `can()`.
8. `registerAuth` also installs the error and not-found handlers that render the contract `ErrorEnvelope`. Zod and
   schema errors are `VALIDATION`; unexpected errors are `INTERNAL` with no detail.

### Reading the role matrix
9. One `POLICY` row per action; `import.*` covers every import verb. Unknown actions are denied. The matrix's
   `library.*` cell (categories) is not a row: reading categories is `library.read` and creating, renaming or merging
   them is `library.write`, so the library has exactly `library.read`, `library.write` and `library.push`.
10. `own` cells need `ownerId` (OWNER) or `approverId` (APPROVER) on the resource; a resource without them is denied.
11. APPROVER and OWNER are limited to `unitIds` when the resource names a unit; client-level resources (lists) are
   allowed and filtered by the query.
12. Firm-level resources (`clientId: null`) are reachable by firm staff; client roles reach them only for rows marked
    firm-wide (`library.read`, `location.read`, `location.write`). So `person.read` with `clientId: null` (the firm staff
    list) is FA and CO only, as the matrix says. `clientId: null` never means "any client": client-level actions such as `client.read` and
    `instance.read` deny client roles there, and lists across clients filter by `ctx.clientIds`.
13. `audit.read`: APPROVER and OWNER only on `instance` resources (the drawer history), not the client audit page.
14. `client.settings`: CLIENT_ADMIN is allowed; limiting their PUT to the reminder settings is M6's field check.
15. `location.write`: the CA cell "r/✓" is read as read ✓, write ✓.
16. `evidence.remove` for OWNER and evidence writes "only while OPEN, SENT_BACK or SUBMITTED" are state rules for M7;
    `can()` answers only who.
17. `canGrantRole(ctx, role, clientId)` covers "only FA invites or grants FA/CO; CO and CA grant client roles in their
    clients" for invites and memberships.

## Open
- `POST /library/rules/preview` is `library.read` but its row lists only FA, CO and CA. With one action name `can()`
  cannot tell them apart, so AP, OW and VI may preview a rule (read-only, no data). If that matters, M0 should give the
  preview its own action.

# ADR M15-0004: The customer's account routes and support access

## Context

ADR M15-0001 decisions 5 and 11 give account admins a read-only view of their plan and the power to let PlanetPulse
support in for a fixed time. Contracts 1.5.0 define the routes (`GET /account`, `GET|POST /account/support-grants`,
`POST /account/support-grants/{id}/revoke`) and M3 the storage (`account`, `supportGrants` in `@canopy/db`). This ADR
records what `apps/api/src/platform/db-customer.ts` decides on top.

## Decisions

1. **Customer routes run on the customer session, as canopy_app.** They mount under `/api/v1` beside the other
   modules, with `authorize()` against M5's policy (`account.read`, `supportGrant.read`, `supportGrant.manage`: account
   admins only), inside the request's tenant context. The operator login is never used for them.
2. **A support session never manages support access.** An `ADMIN` grant gives the support person a `FIRM_ADMIN`
   membership, so the policy alone would let PlanetPulse extend or end its own access. Every support-access route
   reads the caller and answers `403 FORBIDDEN` for `person.support = true`, and fails closed when the caller cannot
   be read. It may read `GET /account`, which carries no personal data.
3. **Grants and revokes are audited in the customer's trail, per membership.** A grant is time-boxed memberships, so
   each membership it opens or ends gets a `MEMBERSHIP_CHANGE` entry in the same transaction, with the membership's
   client, actor the admin and reason "Support access granted", "Support access revoked" or "Replaced by a new
   support grant": every client's own audit page shows PlanetPulse coming and going, as the M0 mock does. `after`
   carries the role, the end, the grant id and the level; no person's name. Each also enqueues
   `support_access.granted { grantId, level, endsAt }` or `support_access.revoked { grantId }` (events.md), actor
   `PERSON`, on the account aggregate at the account's version.
4. **The operator trail gets its entry from the database.** canopy_app cannot write `platform.operator_audit_event`,
   so an M3 trigger on `support_grant`, owned by canopy_platform, writes `SUPPORT_ACCESS_START` on insert and
   `SUPPORT_ACCESS_END` when `revoked_at` is set, in the same transaction, with ids, level and times only. Opening a
   support session from the console writes its own `SUPPORT_ACCESS_START` (ADR M15-0003 decision 7), so a grant shows
   as granted, visited and ended.
5. **Creating a grant takes an `Idempotency-Key`,** stored in `idempotency_key` with the grant (as M7 does), so a
   repeat within 24 hours, or a concurrent one that loses the race, gets the first grant. Revoking needs no key: a
   grant that already ended answers `409 INVALID_TRANSITION` (as the mock does), and an unknown grant or one of
   another account `404 NOT_FOUND`.
6. **Days default to 7 and run 1 to 30** (`SUPPORT_GRANT_DEFAULT_DAYS`, `SUPPORT_GRANT_MAX_DAYS`), checked by the
   contract body at the edge.

## Consequences

- `server.ts` mounts `registerCustomerAccountRoutes` when a database is configured (a Tooling patch: the file is
  shared). Until then the Postgres test mounts it the same way.
- The M3 trigger is its own migration patch; the API does not depend on it to work, only the operator trail does.
- M13's support-access screen and M11's banners read these routes.

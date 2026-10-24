# ADR M5-0002: Account status and PlanetPulse support sessions in sign-in

## Context
ADR M15-0001 makes each firm an account that PlanetPulse can suspend, put up for deletion, or let its support staff
into for a time the customer grants. M5 owns sign-in and the request context, so it enforces those rules for every
customer route. Storage is ADR M3-0002.

## Decisions
1. **The account status travels with the session.** `canopy_find_session` and the login candidates carry the account's
   status, so no request pays an extra query. `buildRequestContext` calls `checkAccount`:
   - TRIAL and ACTIVE: everyone, as before.
   - PENDING_DELETION: only people with an active `FIRM_ADMIN` membership, and only on routes that set
     `config.whilePendingDeletion` (`GET /me`, `POST /auth/logout`, and the account export when M15 adds it).
   - Any other status: nobody. The answer is `403 ACCOUNT_SUSPENDED { status }`.
2. **Sign-in says nothing about the account until the password is right.** Password sign-in checks the status after
   the password. Magic links are not requested for people whose account cannot sign in, so while it is
   PENDING_DELETION only its account admins get one. A magic link or invite to a
   suspended account is refused before its token is used up, so it still works if the account resumes within its
   life. An invite cannot be accepted unless the account is TRIAL or ACTIVE, with one exception: in PROVISIONING the
   owner's own FIRM_ADMIN invite (the one provisioning wrote, invited by the owner themselves) is accepted, and the
   database opens the account in the same transaction (ADR M3-0002 decision 4), so the session starts in TRIAL or
   ACTIVE.
3. **Invites hold a seat.** An invite that would take the account's `usage.users` past its plan's `users` limit
   answers `403 PLAN_LIMIT_REACHED { limit: 'users', max, used }` and changes nothing. The store compares the count
   before and after the insert in the invite's own transaction, so anyone not yet counted (new, imported, or holding
   only an expired invite) is checked, and re-inviting someone already counted is not.
4. **The support person has one way in.** M3 keeps it out of the login candidates, so password sign-in and magic links
   cannot reach it. Inviting it is `404`. `POST /auth/support/verify` exchanges the console's one-time token (60
   seconds) for a session with MFA satisfied, ending at the earlier of 2 hours and the grant's end, audited as `LOGIN`
   with method `SUPPORT`. A support session stops working the moment its grant is revoked or runs out, and never works
   while the account is anything but TRIAL or ACTIVE. `isSupportSession(req)` lets other modules refuse it, for example
   on the support-grant routes.
5. **`Me` gains `account` and `session`.** `account` is `{ kind, status, trialEndsOn }`; `session.expiresAt` lets the
   web app show when a support session ends.
6. **Policy rows** `account.read`, `supportGrant.read` and `supportGrant.manage` are account admins only.

## Consequences
- `AccountStore` gains `account(firmId)` and `findSupportToken(tokenHash)`. `Invitee` gains `support`, and
  `LoginCandidate` gains `accountStatus`. `SessionRecord.accountStatus` and `supportGrantId` are optional: a session
  without them reads as an active account and is not a support session.
- Each refused path has a test in `accounts.test.ts` (in memory) and `db-store.db.test.ts` (Postgres).

# M5-0001. Sign-in, MFA and invites (M5)

- Status: accepted
- Date: 2026-10-12
- Module: M5 (`apps/api/src/auth`)

## Context

endpoints.md §2 lists the auth routes, and events.md lists `auth.magic_link_requested { personId }` and
`person.invited { personId, inviteId, role, clientId }` for M9 to send the emails. The contracts leave open the
lifetimes, lockout, how raw tokens reach an email without being stored, and what happens when one email belongs to
people in two firms.

## Decisions

1. Passwords: scrypt (N=2^15, r=8, p=1, 64-byte key, 16-byte salt) from node:crypto, stored with its parameters.
   New passwords (invite accept) follow the contract: 12 to 200 characters. Unknown emails spend the same hashing
   time.
2. Every login failure is `401 UNAUTHENTICATED` with one message: an unknown email, a wrong password, a DISABLED,
   INVITED or password-less person, and a locked account all look the same. Ten failures in a row lock the account
   for 15 minutes. Login allows 10 tries a minute per IP; magic links 5; token and MFA routes 10 to 20.
3. Emails are unique per firm, not globally. When one email and password match people in more than one firm, login
   answers `409 FIRM_CHOICE_REQUIRED` with `details.firms: [{ id, name }]` without a session, and the client posts
   again with `firmId`. Firm names are only shown after the password matched.
4. Sessions last 12 hours. The cookie is `sid`: HttpOnly, SameSite=Lax, Secure outside development and test. Only
   the token's SHA-256 is stored. Login, magic-link verify, MFA verify, invite accept and `GET /me` all answer with
   the contract `Me`, which carries the CSRF token and MFA state; `Me.clients` comes from
   `AccountStore.clientSummaries`, which the database adapter computes with the engine.
5. Raw magic-link and invite tokens are never stored or put in the outbox. The request writes only the event; M9,
   when it sends the email, calls `AuthService.issueLoginToken`, which creates the token, stores its hash and returns
   the raw value for the link. Magic links last 15 minutes; invite links 7 days. Each token works once. A person
   gets at most one magic-link request a minute, whoever asks (counted per API process).
6. MFA is TOTP (RFC 6238, SHA-1, 6 digits, 30 s, one step of drift). The secret is sealed with AES-256-GCM under
   `AUTH_SECRET_KEY` (32 bytes, base64). Enrolment completes on the first good code; a code for a step already used
   is refused. MFA is asked for in every new session of a person holding a firm role. The authenticator shows the
   issuer "PlanetPulse Compliance". Wrong codes count with wrong passwords toward the account lockout, and signing
   in again does not clear them while the session still owes MFA; a correct code does. A session that sends 5 wrong
   codes is revoked (counted per API process); when the lockout is reached, every session of the person ends.
7. Invites claim UNCLAIMED (imported) or INVITED people, or create a person from `displayName`; ACTIVE or DISABLED
   people are `409 DUPLICATE` (grant them a membership instead), as is an email another person in the firm has. A
   new invite revokes the person's earlier pending ones. Accepting sets the password (and the name, when given),
   makes the person ACTIVE, grants the invited membership and signs them in. A pending invite past its link expiry
   reads as EXPIRED; revoking anything but a pending invite is `409 INVALID_TRANSITION`. Claiming an account brings
   every role the person holds, so an existing person can be invited only by someone who could grant each of their
   non-archived memberships and open invites (`canGrantRole`); anyone else gets `404 NOT_FOUND`.
8. Logged request URLs replace invite tokens and `token=` query values with `[redacted]`. `TRUST_PROXY` sets
   Fastify's `trustProxy` so per-IP limits see the client address behind a load balancer. It must list the load
   balancers' addresses or CIDRs no wider than /8 (/104 for IPv4-mapped `::ffff:` ranges); the API refuses to start with `true`, a wider range or anything
   else, because those trust the leftmost `X-Forwarded-For` entry, which the client writes.
9. Per-route limits count per path, so a GET route and the HEAD route Fastify adds for it share one budget.
10. Storage is the `AccountStore` interface (`accounts.ts`). Each method is one transaction and writes its audit and
    outbox rows, as its comment says. `createDbAccountStore` implements it on M3's auth tables (ADR M3-0001): firm-keyed
    calls run in the firm's system context, because they happen before a request context exists or change people a
    client context cannot; `can()` has already decided the actor may. `Me.clients` periods come from the engine's
    `clientPeriods` over the client's generated due dates.

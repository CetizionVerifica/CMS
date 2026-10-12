# 0006. Sign-in, MFA and invites (M5)

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
   Twelve to 256 characters. Unknown emails spend the same hashing time.
2. Every login failure is `401 UNAUTHENTICATED` with one message: an unknown email, a wrong password, a DISABLED,
   INVITED or password-less person, and a locked account all look the same. Ten failures in a row lock the account
   for 15 minutes. Login allows 10 tries a minute per IP; magic links 5; token and MFA routes 10 to 20.
3. Emails are unique per firm, not globally. When one email and password match people in more than one firm, login
   answers `{ status: "CHOOSE_FIRM", firms: [{ firmId, firmName }] }` without a session, and the client posts again
   with `firmId`. Firm names are only shown after the password matched.
4. Sessions last 12 hours. The cookie is `sid`: HttpOnly, SameSite=Lax, Secure outside development and test. Only
   the token's SHA-256 is stored. The CSRF token comes in the login response and from `GET /me`.
5. Raw magic-link and invite tokens are never stored or put in the outbox. The request writes only the event; M9,
   when it sends the email, calls `AuthService.issueLoginToken`, which creates the token, stores its hash and returns
   the raw value for the link. Magic links last 15 minutes; invite links 7 days. Each token works once.
6. MFA is TOTP (RFC 6238, SHA-1, 6 digits, 30 s, one step of drift). The secret is sealed with AES-256-GCM under
   `AUTH_SECRET_KEY` (32 bytes, base64). Enrolment completes on the first good code; a code for a step already used
   is refused. MFA is asked for in every new session of a person holding a firm role. The authenticator shows the
   issuer "PlanetPulse Compliance".
7. Invites claim UNCLAIMED (imported) or INVITED people; ACTIVE or DISABLED people are `409 DUPLICATE` (grant them a
   membership instead). A new invite revokes the person's earlier open ones. Accepting sets the password, makes the
   person ACTIVE, grants the invited membership and signs them in. Revoking an accepted or revoked invite is
   `409 INVALID_TRANSITION`.
8. Logged request URLs replace invite tokens and `token=` query values with `[redacted]`. `TRUST_PROXY` sets
   Fastify's `trustProxy` so per-IP limits see the client address behind a load balancer.
9. Per-route limits count per path, so a GET route and the HEAD route Fastify adds for it share one budget.
10. Storage is the `AccountStore` interface (`accounts.ts`). Each method is one transaction and writes its audit and
    outbox rows, as its comment says. M3 adds the credential, session and token tables with SECURITY DEFINER lookups
    by email and token hash; until then the routes run only with the in-memory store, and `buildServer` serves them
    only when an `accountStore` is passed.

## Open

- The auth request and response bodies are local Zod schemas in `routes.ts` until M0 adds them to the contracts.

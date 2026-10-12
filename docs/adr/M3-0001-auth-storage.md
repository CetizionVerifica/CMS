# ADR M3-0001: Sign-in storage for M5

## Context
M5 signs people in with a password, a magic link or an invite, then optional TOTP MFA. Its storage contract is
`AccountStore` in `apps/api/src/auth/accounts.ts`, and `InMemoryAuthStore` in `testing.ts` is the reference
behaviour. Three reads happen before any tenant is known: login candidates by email, a session by the hash of its
cookie token, and a sign-in link by the hash of its token. Everything else runs inside one firm.

## Decisions
1. **Four tables, each with `firm_id`, forced RLS, no DELETE grant and an isolation test** (migrations 0011, 0012):
   - `auth_credential`: one row per person. It holds the scrypt password hash, the MFA secret sealed by M5's
     SecretBox, `mfa_enrolled_at`, the last accepted TOTP step, failed attempts and `locked_until`.
   - `auth_session`: the SHA-256 of the cookie token (unique), the CSRF token, the MFA flag, how the person
     signed in, `last_seen_at`, `expires_at` and `revoked_at`.
   - `auth_invite`: the invited person and email, and the membership to grant (role, client, consultant
     clients, units, membership expiry), with the same shape checks as `membership`. It ends by `accepted_at`
     or `revoked_at`.
   - `auth_token`: magic-link and invite links, stored as the SHA-256 of the token (unique), with `used_at`.
     An invite's link must name the invited person, enforced by a composite foreign key.
2. **Raw tokens are never stored.** Only lower-case SHA-256 hex digests are stored, and CHECK constraints
   enforce that shape. Email is unique per firm, not globally (`person_email_key`), so one email can have a
   candidate in several firms.
3. **Who reaches the rows (RLS).**
   - A person reaches their own rows.
   - Firm staff contexts reach every row of the firm. These are firm admins, consultants and system jobs.
   - Client contexts also reach the invites of the clients they see, and those invites' links.
   - M5's `can()` decides which client roles may invite. RLS has no notion of roles (ADR 0003, Limits).
4. **Pre-tenant lookups are SECURITY DEFINER functions owned by `canopy_lookup`.** The functions are
   `canopy_login_candidates`, `canopy_find_session` and `canopy_find_login_token`, all with a fixed
   `search_path`. The owner role has no login and no BYPASSRLS. Its access is limited to column grants on
   exactly what the lookups read, plus `lookup_read` policies that name it alone (ADR 0003, Consequences).
   Only `canopy_app` can execute the functions, through `Database.findLoginCandidates`, `findSession` and
   `findLoginToken`. They return ids, states, the password hash and lock (which M5 needs to verify a
   password) and the session's CSRF token (useless without the cookie). The MFA secret is never granted to
   the lookup role.
5. **The repositories match AccountStore, minus audit and outbox.** These are `credentials`, `sessions`,
   `loginTokens` and `invites` in `src/repositories/auth.ts`. As in every repository, the caller writes the
   `AuditEvent` and outbox event in the same `withTenant` transaction. The writes return what those events
   need: the person before and after, the revoked invite ids and the granted membership.
6. **Races are settled in single statements.**
   - `recordFailure` counts in one upsert, so concurrent failures all count.
   - `loginTokens.consume` and `invites.accept` use a token only if it is unused and unexpired.
   - `credentials.acceptMfaStep` stores a TOTP step only if it is later than the last one, which blocks replay.

## Consequences
- M5's adapter usually runs `systemContext(firmId, requestId)` for firm-keyed calls, because it acts before a
  request context exists. `invites.accept` needs a context that can change the person and add the membership.
  A client context cannot change people who hold a firm role (ADR 0003).
- `invites.create` leaves an ACTIVE person unchanged and requires the invite email to be theirs. Any other
  person becomes INVITED with the email.
- Sessions, links and invites accumulate. A clean-up job that archives expired rows can come later (M9). Until
  then, the lookups filter on `revoked_at` and return `expires_at` and `used_at` for the caller to check.

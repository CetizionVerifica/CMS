# ADR M5-0003: Firm roles set up MFA while accepting their invite

## Context
docs/security/review.md F14: a firm user's first MFA enrolment was trust-on-first-use. Accepting an invite set the
password and started a session that still owed MFA, and enrolment happened inside that session (ADR M5-0001
decision 6). Until the person enrolled, anyone who learned their password could sign in, enrol their own
authenticator and keep it. The operator-created first admin of an account goes through the same invite (ADR M15-0001
decision 3), so it had the same gap.

## Decisions
1. **Setup moves before the password.** An invite needs MFA when it grants FIRM_ADMIN or CONSULTANT in a firm whose
   settings require MFA for firm roles. `GET /invites/{token}` says so in `mfaRequired`.
2. **The invite token stands in for the session.** `POST /invites/{token}/mfa/enroll` (public, MFA route limit)
   stores a sealed TOTP secret for the invited person and answers the `MfaEnrollment`. The secret is not enrolled
   yet, so setup can restart until the invite is accepted. Once a secret is enrolled, it answers `DUPLICATE`. An
   invite that needs no MFA answers `NOT_FOUND`.
3. **Accept checks the code first.** `POST /invites/{token}/accept` takes the authenticator's first code in
   `mfaCode`. With no setup or no code it answers `401 MFA_REQUIRED`. A wrong or replayed code answers
   `VALIDATION` on `mfaCode`. Both change nothing: the token stays usable and no password is set. A correct code
   completes enrolment in the same transaction that stores the password, then the session starts MFA-satisfied. If
   that transaction fails, nothing is enrolled and setup can restart. So no session ever exists with a password and
   no MFA. A wrong code does not count towards the session lockout, since there is no
   session yet. The per-IP token limit (20 a minute) caps guessing, and only the invitee holds the token.
4. **Sign-in is unchanged.** Signing in still asks for the code. In-session enrolment (`POST /auth/mfa/enroll`)
   remains for people who accepted before this change and for seeded and demo accounts. Once none are left, it can
   be limited further; that is a separate decision.

## Consequences
- Contracts 1.6.0: `InvitePreview.mfaRequired`, `InviteAcceptBody.mfaCode` and the enrolment endpoint.
- The invite page (M11) shows "Get a setup key" and a code field for these invites.
- Mitigation 3 of F14 (email the person whenever MFA is enrolled or reset): M5 writes `person.mfa_enrolled
  { personId, via }` in the transaction that completes setup, from a session (`SETTINGS`) or while accepting an
  invite (`INVITE`), and M9 emails the person (`MFA_ENROLLED`, contracts 1.6.1). There is no MFA reset yet; when one
  is built, the setup that follows it sends the same notice.

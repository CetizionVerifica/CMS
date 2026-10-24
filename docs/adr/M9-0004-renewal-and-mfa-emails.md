# M9-0004. The renewal email and the MFA set-up notice

Status: accepted (2026-10-24)

## Context
Two emails were still to build. The company-accounts plan has the jobs remind an account's admins before a paid
subscription ends, not only before a trial ends (ADR M15-0001, order of work step 6; ADR M9-0002 "Not yet"). And
docs/security/review.md F14 asks, as mitigation 3, that a person hear whenever MFA is set up on their account, so
someone who sets it up in their place is noticed (ADR M5-0003). Contracts 1.6.1 add the kinds `RENEWAL_DUE` (an
account kind) and `MFA_ENROLLED`, and the event `person.mfa_enrolled { personId, via }`, which M5 writes in the
transaction that completes MFA setup. M3 stores both kinds (migration 0032), tells the account its latest
subscription's last day through `app_subscription_ends_on()` (0033, a date only), and lets a `RENEWAL_DUE` send go
without a client or an event (0034).

## Decisions
1. **Renewal: who and when.** Every account admin of an `ACTIVE` account whose latest paid subscription (the one that
   ends last, as the console's Renewals page reads it) ends in 30 days or 7 days, by the India date. A trial gets the
   trial email instead; a paused, closing or provisioning account and one with no subscription get nothing. Neither
   the plan nor ADR M15-0001 names the days, so 30 and 7 are this ADR's default (`RENEWAL_REMINDER_DAYS`): a month
   leaves time for an offline invoice, and a week is the last call. Changing them is a one-line change.
2. **Renewal: schedule and dedupe.** A job of its own, `renewal-reminders`, daily at 10:00 India time with one
   catch-up, as `trial-reminders` (ADR M9-0003). The send names no client, instance or event and is unique per
   recipient, kind and date, so a second run that day sends nothing; when the operator records a new period, the
   latest end moves and the days that match move with it.
3. **Renewal: content.** The account's name, the last day and to contact PlanetPulse to renew (billing is offline),
   with a link to the account page. It does not say what happens after the last day, because nothing does yet.
4. **MFA notice: trigger and recipient.** The consumer of `person.mfa_enrolled` emails that person, ACTIVE and not
   archived, at the address on file. It is sent however late the event arrives: it is about safety, not a link that
   expires. The send keeps the event id, so a redelivered event sends nothing twice (as `MAGIC_LINK` and `INVITE`).
5. **MFA notice: content.** The day (India time) and how it was set up (from the person's settings, or while their
   invitation was accepted), and to tell their account admin or PlanetPulse at once if it was not them. It carries
   no code, secret or link, so there is nothing for a look-alike email to copy. There is no MFA reset yet; when one
   is built, the setup after it sends the same notice.

## Consequences
- ADR M9-0002's "Not yet" no longer lists the renewal reminder.
- Until M5 writes `person.mfa_enrolled`, the consumer has nothing to send; merging the M9 change first loses no
  notice.

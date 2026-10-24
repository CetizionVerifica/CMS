# M9-0003. The trial-ending email

Status: accepted (2026-10-24)

## Context
The company-accounts plan has the jobs remind an account's owner that the trial is ending (ADR M15-0001 decision 4;
ADR M9-0002 "Not yet"). A trial's last day is `firm.trial_ends_on`; the night after it, `account-daily` suspends the
account (ADR M9-0002 decision 3). Contracts 1.5.3 add the kind `TRIAL_ENDING` and `ACCOUNT_NOTIFICATION_KINDS`, M3
stores the kind (migration 0027) and lets a send about the whole account go without a client (migration 0028).

## Decisions
1. **Who.** Every account admin (`FIRM_ADMIN`) of an account in `TRIAL`: the people who can act on it. Consultants,
   client roles and PlanetPulse support get nothing. An admin who is not ACTIVE, or whose membership has expired or
   is archived, gets a `NOT_ACTIVE` send-log row; one with no address gets `NO_EMAIL`, as for every other kind.
2. **When.** 7 days and 1 day before the last day, by the India date (Asia/Kolkata, the zone `account-daily` and the
   usage snapshot use; an account's own zone is on its profile, which the jobs' port does not read). Nothing on the
   last day itself: the 1-day email already says "tomorrow", and the account still works that day. The plan and
   ADR M15-0001 name no days, so 7 and 1 are this ADR's default (`TRIAL_REMINDER_DAYS`); changing them is a one-line
   change and needs no migration.
3. **Schedule.** A job of its own, `trial-reminders`, daily at 10:00 India time, so the email arrives in office hours
   rather than with the 00:30 account job. It catches up once after downtime the same day. A whole missed day skips
   that reminder rather than sending it a day late with the wrong count.
4. **Dedupe.** The send is about the account, so its send-log row has no client and no instance; it is unique per
   recipient, kind and date (the digest key, events.md section 4 rule 4). A second run that day sends nothing new.
   Changing the trial end changes which days match, so the admins hear about the new date.
5. **Content.** The account's name, the last day, what happens after it (nobody signs in until it moves to a paid
   plan; the data stays) and to contact PlanetPulse, with a link to the account page (`/account`). No usage figures
   and no names besides the recipient's.
6. **One transaction per account** for the reads, then the send log's usual claim, send and record steps. A failure
   in one account does not stop the others; the job fails afterwards so pg-boss retries it.

## Not yet
- The operator's copy (trials ending and renewals due, for PlanetPulse) is M15's: the jobs' database login cannot read
  the platform schema, where renewals and the operators' addresses live.

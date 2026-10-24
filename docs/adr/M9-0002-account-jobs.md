# M9-0002. The jobs and customer accounts

Status: accepted (2026-10-24)

## Context
ADR M15-0001 decision 4 turns the jobs off for an account that is not `TRIAL` or `ACTIVE`, decision 3 ends a trial
whose last day has passed, and the operator console shows nightly usage next to the plan's limits (decision 5). M3
gives the tenant side two functions for this, `app_end_trial` and `app_take_usage_snapshot` (migration 0023, ADR
M3-0003), each run in the account's own system context. M15's operator console reads the snapshots.

## Decisions
1. **Served accounts.** Generation, reminders and the consultant digest serve `TRIAL` and `ACTIVE` accounts only
   (`servedFirmIds`). Each status is read in the firm's own transaction (`FirmTx.accountStatus`), since
   `listFirmIds` stays the one cross-tenant read and returns ids only. The outbox relay and the evidence scan serve
   every account: a `PROVISIONING` account's owner invite is sent from its `person.invited` event, and a paused
   account's events still drain.
2. **`account-daily`, at 00:30 Asia/Kolkata**, half an hour before generation, so an account whose trial it ends gets
   no instances that night. It catches up once after downtime, like generation (`JobDefinition.catchUp`). It sends no
   mail, so it runs without a mailer.
3. **Trial end.** For a `TRIAL` account it calls `app_end_trial(now, 'account-daily')`, which compares the last day
   with the date in the account's own time zone and writes the account's audit row, `account.status_changed` (actor
   SYSTEM) and the operator's `ACCOUNT_SUSPEND` entry in the same transaction. A trial ends the day after its last day.
4. **Usage snapshot** for every account opened and not yet purged (`TRIAL`, `ACTIVE`, `SUSPENDED`,
   `PENDING_DELETION`), dated by the India date of the run. A second run that day replaces the snapshot.
5. **One transaction per account.** A failure in one account does not undo the others; the job fails afterwards so
   pg-boss retries it, and a retry changes nothing already done.
6. **Support sessions that ran out** are closed in every account, whatever its status, by M3's
   `supportGrants.closeExpired`: the support person's membership and sessions end, and `app_record_support_expiry`
   writes `SUPPORT_ACCESS_END` (`source: 'expiry'`) to the operator trail, so a session that simply runs out leaves
   the same end entry as one an admin ends. The report counts them as `supportClosed`.

## Not yet
- Trial-ending emails to the account admins: ADR M9-0003. The operator's copy (trials ending, renewals due) is M15's.
- The renewal reminder to the account admins before a paid subscription ends: ADR M9-0004.
- The purge job (ADR M15-0002 decision 5) waits for M3's `platform_purge_account` and runs on the operator's
  database login, which alone may execute it.

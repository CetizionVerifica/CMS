# ADR M15-0005: The operator's daily renewals email

## Context

The company-accounts plan sends trial-ending and renewal reminders "to the owner and the operator" (ADR M15-0001,
build order step 6). The account admins' emails are M9's: its trial-ending email ships with M9's own job and ADR,
and a renewal reminder before a paid subscription ends is still to build. This ADR covers only the operator's copy,
which needs what only the console's login reads: the platform schema's subscriptions and operators (ADR M3-0002). The
jobs' database login cannot read it, and the console's Renewals page (`GET /renewals`, `subscriptions.renewals`)
already answers "what ends soon".

## Decisions

1. **One daily email per enabled operator**, listing every account whose trial or latest subscription ends in the
   next 14 days, soonest first: the Renewals page's rows (`subscriptions.renewals(today, 14)`). On a day with none,
   nothing is sent. A disabled operator gets nothing.
2. **Account names, kinds, dates and plan codes only.** No customer's people, usage or data, and no link that carries a
   token. The email points to Renewals in the console instead of linking it, since the API has no setting for the
   console's address.
3. **On the console's login.** `runOperatorDigest` reads in `withOperator`, like every operator route; it never opens a
   tenant context. The operator's date is India time (`operatorToday`), as on the Renewals page.
4. **Scheduled by M9's runner**, daily at 09:30 India time, as `operatorDigestJob(db)`: a `JobDefinition` the server's
   wiring adds when the operator API is enabled (an M9 option for extra jobs and a wiring change, in their owners'
   paths). It sends mail, so it runs only with a mailer.
5. **At least once, with no send log.** pg-boss runs each cron slot once across API instances. A transport failure
   fails the run and pg-boss retries it, which may send that day's digest to an operator twice (a failure on one
   operator re-sends to the operators before it). The recipients are PlanetPulse's own operators, so a rare duplicate
   is cheaper than a platform send-log table. Each email carries an idempotency key per operator and day for a
   transport that honours one.

## Consequences

- A new operator gets the digest from the next morning; disabling one stops it.
- This email does not replace the account admins' renewal reminder, which is pending, not dropped. Until it is built,
  the operator contacts the customer about a renewal; billing is offline either way.

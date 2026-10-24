# ADR M6-0001: Copying the master library into a new account

## Context
ADR M15-0001 decision 8 says a new account starts with the master obligation library, copied by M6 code on the app
side when M9 relays `account.created`. The owner cannot accept their invite until the copy is recorded
(`firm.library_copied_at`, ADR M3-0003 decision 7). No master library exists yet: today every account builds its own
library or imports its register.

## Decisions
1. **The master library is a versioned bundle in M6** (`modules/library/master.ts`). Categories, Acts and obligations
   refer to each other by a `key` that exists only in the bundle. Each account gets its own rows with its own ids,
   and each obligation's `libraryVersion` is the bundle's version.
2. **Version 1 is empty.** Its content is the consultancy's to supply and review. A wrong due-date rule sends wrong
   alerts, so no content is invented here. Until it lands, the copy records itself and copies no rows, so new
   accounts open as they would today.
3. **`copyMasterLibrary(db, accountId, requestId)` is idempotent.** It runs in the account's own system context.
   It first calls `accountJobs.markLibraryCopied`, which sets the time once, and only while the account is
   PROVISIONING. That update locks the account row, so of two deliveries running at the same time one copies and
   the other copies nothing. It then inserts the rows in the same transaction. A failed copy rolls the record back,
   and the retried event copies again.
4. **Each copied row is audited.** The audit row is CREATE with actor SYSTEM, no client, the event's request id, and
   the reason "Master library version N".
5. **A broken bundle never half-copies.** `checkMasterLibrary` refuses a repeated key or a missing reference before
   the transaction starts, and the contract schemas check every row on insert.

## Consequences
- M9 calls `copyMasterLibrary` from its `account.created` consumer through a port, as it calls M5's
  `issueLoginToken`. The API wiring passes it in.
- Pushing a new library version to accounts that already exist is a later operator feature, out of scope here.

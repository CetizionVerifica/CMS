# 0004 · M7: instance workflow state machine

Status: accepted (M7 PR 1)

## Context
apps/api/CLAUDE.md fixes the arrows of the instance workflow, and docs/contracts/endpoints.md §4 fixes who may
take them. Some details were left open: what each transition does to the other fields, which check wins when
several fail, and in which states the non-transition actions (reassign, due date, evidence) are offered.

## Decisions
1. **One pure planner.** `apps/api/src/modules/instances/workflow.ts` `planTransition` takes the instance, the
   expected version, the command, `asOf` (today in the client's time zone, from `engine.localDateIn`), `now`
   and the instance's evidence scan statuses. It returns every workflow field after the move, the next version,
   the comment and the audit event, or throws an `ApiError`. The service writes all three in one transaction
   with `WHERE version = expected`, so a race lost after the check is still `STALE_VERSION`.
2. **Check order:** version, then state, then input. A stale client gets `STALE_VERSION` and reloads before it
   is told a move is invalid.
3. **Field effects.**
   - submit: `pendingKind = COMPLETION`, `completedOn` from the body, `submittedAt = now`.
   - request NA: `pendingKind = NA`, `naReason`, `completedOn = null`, `submittedAt = now`.
   - approve (COMPLETION): `APPROVED`, keeps `completedOn`, `approvedAt = now`.
   - approve (NA): `NOT_APPLICABLE`, `completedOn = asOf` (the date NA was signed off, per
     `ComplianceInstance.completedOn`), `approvedAt = now`.
   - send back: `SENT_BACK`, clears `pendingKind`, `completedOn` and `naReason`; keeps `submittedAt` as history.
   - reopen: `OPEN`, clears every workflow field.
4. **Every transition leaves a comment.** Send back, NA and reopen use the reason. Submit and approve use the
   person's comment, or "Submitted for approval." / "Approved." when they gave none.
5. **Audit.** One `TRANSITION` event with only the changed fields in `before`/`after`. Approve or send back by
   anyone other than the instance approver (a client admin acting as delegate) adds `after.delegated = true`.
6. **Evidence rule.** When the obligation requires evidence, submit needs at least one live `CLEAN` file.
   No clean file but one still `PENDING` is `EVIDENCE_NOT_READY` (`details.scanStatus = PENDING`); otherwise
   `EVIDENCE_REQUIRED`. Requesting NA never needs evidence.
7. **Actions outside the arrows.** Reassign, change due date and upload evidence are offered only while the
   instance is `OPEN`, `SENT_BACK` or `SUBMITTED`; a complied or NA instance is reopened first, so its
   on-time result cannot be changed silently. Comments are allowed in every state.
   `allowedActions` = these states ∩ `can()`, in contract order. The due-date action is `instance.dueDate`, as in
   endpoints.md §4 and M5's policy table; the contracts `Action` regex does not yet accept camelCase, which M0 is to align.
8. **Errors.** M7 throws M5's `ApiError` from `auth/index.ts` (it briefly had its own copy until M5 merged).
9. **Submit and approve comments.** Submit needs a non-blank comment (`VALIDATION` on `comment`), as the
   workflow diagram in `apps/api/CLAUDE.md` says. Approve without a comment records "Approved.". A note added
   with `POST /instances/{id}/comments` changes no compliance state (root CLAUDE.md rule 2 lists what does), so
   it writes no AuditEvent; it does write `comment.added`.
10. **Register reads.** The register repository filters in SQL but cannot apply derived status, several
    categories, departments or Acts at once, or several clients. The service reads each category as its own
    source, merges them by `(dueDate, id)`, and filters status, departments and Acts in memory, reading up to 10
    times per page. A sparse filter can therefore return a short page with a `nextCursor`; clients keep
    following it until it is null. Owners and approvers see only their units; `unitId` outside them is dropped.
    Only firm admins, consultants and viewers may choose `asOf`; the `/me` queues always use today.
11. **Outbox events.** Every change writes its events.md §3 events with M3's `domainEvents.enqueue` in the
    same transaction as the change and its AuditEvent: a transition writes its `instance.*` event and
    `comment.added`; PATCH writes `instance.reassigned` and/or `instance.due_date_changed`; bulk approve also
    writes one `instance.bulk_approved` (aggregate: the client) when any item was approved. Comments have no
    version of their own, so `comment.added` uses the instance as its aggregate. `audit-gate.db.test.ts`
    holds one row per non-GET route and checks the exact AuditEvents and events each writes, and that a
    refusal writes none; a route without a row fails it.
12. **Evidence.** The upload id names the object (`evidence/{firm}/{client}/{instance}/{uploadId}`), so a
    confirm needs no pending-upload table: it reads the stored object's type and size from storage (the PUT
    was signed for exactly those) and checks them against the allowed types and 25 MB again. The unique
    `storage_key` makes a second confirm of one upload `DUPLICATE`. Evidence audit events go on the instance
    (`EVIDENCE_ADD`, `EVIDENCE_DOWNLOAD`, `EVIDENCE_REMOVE`, and `UPDATE` by the SYSTEM for a scan result), so
    the instance history shows them; they and the events carry ids, sizes and types, never file names, which
    can name employees. Only CLEAN files download (`EVIDENCE_NOT_READY` with the scan status otherwise).
    Removing archives the row and keeps the file; an OWNER may remove only while the instance is OPEN,
    SENT_BACK or SUBMITTED, managers in any state. `scanned()` is the internal call for M9's scan job and
    keeps the first result if the job retries. Every M7 route, reads included, has a row in
    `audit-gate.db.test.ts`.
13. **Not yet built.** `Idempotency-Key` on transitions: M3 #49 adds the key table; M7 wires it next, never storing a response that carries a signed URL. Only `sort=dueDate` is
    accepted (`VALIDATION` otherwise). Lists return no total count. The evidence vault and both audit-trail
    routes wait for M3's `evidence.vault` and `auditEvents.query` (requested), and bulk approve's summary
    event moves into the items' transaction once M3 adds a savepoint helper (requested). `main.ts` does not yet pass a database to
    `buildServer`, so the instance routes are registered only where one is given (tests, and M1's wiring later).

## Consequences
- The service and the bulk-approve endpoint call the same planner, so per-item results match single approvals.
- Dependencies added for all of M7 in this PR: `@canopy/engine`, `@canopy/db`, and `@aws-sdk/client-s3` with
  `@aws-sdk/s3-request-presigner` for presigned evidence PUT and 5-minute GET URLs against the S3-compatible
  store (SeaweedFS locally, docker/compose.yaml).

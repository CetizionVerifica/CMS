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
8. **Errors.** M7 throws a local `ApiError` (`instances/errors.ts`) until M5's `ApiError` from `auth/index.ts`
   lands; M7 then switches to M5's and deletes its own.

## Consequences
- The service and the bulk-approve endpoint call the same planner, so per-item results match single approvals.
- Dependencies added for all of M7 in this PR: `@canopy/engine`, `@canopy/db`, and `@aws-sdk/client-s3` with
  `@aws-sdk/s3-request-presigner` for presigned evidence PUT and 5-minute GET URLs against the S3-compatible
  store (SeaweedFS locally, docker/compose.yaml).

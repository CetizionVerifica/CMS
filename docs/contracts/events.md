# Domain event catalogue (contracts v1)

Owner: M0. Producers: M5-M8, M10. Consumers: mainly M9 (jobs and notifications) and M10 (cache refresh).

## 1. What an event is (and is not)
- An **event** says "this happened" so other modules can react (send a reminder, regenerate instances, refresh a dashboard cache).
- The **audit trail** (`AuditEvent`) is the legal history. Events are not a substitute: every state change writes both, in the same transaction.
- Transport: transactional outbox. The producer inserts the event in the same DB transaction as the change; a relay publishes it to a pg-boss queue named after `type`. Consumers must be **idempotent on `id`** (at-least-once delivery) and must not assume ordering across aggregates. Within one aggregate, `aggregateVersion` gives the order.
- Payloads carry ids and enums, not personal data. Names, comments, reasons and file names are fetched by the consumer under its own tenant context if needed.

## 2. Envelope
```ts
interface DomainEvent<T extends string, D> {
  id: Id                       // UUIDv7, dedupe key
  type: T                      // e.g. "instance.submitted"
  schemaVersion: 1
  occurredAt: Instant
  firmId: Id
  clientId: Id | null
  actor: { kind: "PERSON"; personId: Id } | { kind: "SYSTEM"; job: string } | { kind: "IMPORT"; batchId: Id }
  requestId: string
  aggregate: { type: string; id: Id }
  aggregateVersion: number     // the entity version after the change
  data: D
}
```

## 3. Catalogue

### Instances (producer M7; M9 generation produces `instance.generated`)
| Type | `data` | Main consumers |
|---|---|---|
| `instance.generated` | `{ assignmentId, instanceIds: Id[], range: {from, to}, engineVersion }` (one per assignment per run) | M10 cache |
| `instance.submitted` | `{ instanceId, kind: SubmissionKind, ownerId, approverId, dueDate, completedOn: LocalDate \| null }` | M9 notify approver |
| `instance.approved` | `{ instanceId, approverId, resultState: "APPROVED" \| "NOT_APPLICABLE", delegated: boolean, completedOn }` | M9 cancel reminders, M10 |
| `instance.sent_back` | `{ instanceId, approverId, ownerId }` | M9 notify owner |
| `instance.reopened` | `{ instanceId, previousState, byRole: Role }` | M9, M10 |
| `instance.reassigned` | `{ instanceId, ownerId: {from, to} \| null, approverId: {from, to} \| null }` | M9 |
| `instance.due_date_changed` | `{ instanceId, from: LocalDate, to: LocalDate }` | M9 replan, M10 |
| `instance.bulk_approved` | `{ requested: number, approved: Id[], failed: Id[] }` (in addition to one `instance.approved` per item) | M10 |

### Evidence and comments (producer M7)
| Type | `data` | Consumers |
|---|---|---|
| `evidence.uploaded` | `{ evidenceId, instanceId, sizeBytes, mimeType }` | scan job |
| `evidence.scanned` | `{ evidenceId, instanceId, scanStatus }` | M9 (notify uploader if INFECTED) |
| `evidence.removed` | `{ evidenceId, instanceId }` | — |
| `evidence.downloaded` | `{ evidenceId, instanceId }` | — (audit is the record; event for access analytics) |
| `comment.added` | `{ commentId, instanceId, kind: CommentKind, authorId }` | M9 (mention notifications, later) |

### Library, entities, assignments (producer M6)
| Type | `data` | Consumers |
|---|---|---|
| `client.created` · `client.updated` | `{ clientId, changed: string[] }` | M9 (settings, time zone) |
| `unit.created` · `unit.updated` · `unit.archived` | `{ unitId, companyId, locationId }` | M10 |
| `obligation.created` · `obligation.updated` | `{ obligationId, libraryVersion, changed: string[] }` | — |
| `obligation.pushed` | `{ obligationId, libraryVersion, clientIds: Id[] }` | M9 regenerate future instances |
| `assignment.created` | `{ assignmentId, obligationId, unitId, departmentId, defaultOwnerId, defaultApproverId, applicability }` | M9 generate instances |
| `assignment.changed` | `{ assignmentId, changed: ("department" \| "defaultOwner" \| "defaultApprover" \| "activeTo")[], appliedToOpen: boolean }` | M9 regenerate/replan |
| `assignment.applicability_changed` | `{ assignmentId, from: Applicability, to: Applicability }` | M9 stop/start generation |
| `assignment.archived` | `{ assignmentId }` | M9 |
| `alias.merged` | `{ entityType: "act" \| "category" \| "department" \| "person", targetId, sourceIds: Id[] }` | M10 cache |

### People and access (producer M5, M6)
| Type | `data` | Consumers |
|---|---|---|
| `person.invited` | `{ personId, inviteId, role, clientId }` | M9 send invite email |
| `person.claimed` | `{ personId }` | — |
| `membership.changed` | `{ membershipId, personId, role, clientId, change: "GRANTED" \| "UPDATED" \| "REVOKED" \| "EXPIRED" }` | M9 (stop reminders to revoked) |
| `auth.magic_link_requested` | `{ personId }` | M9 send email |

### Import and export (producers M8, M10)
| Type | `data` | Consumers |
|---|---|---|
| `import.parsed` | `{ batchId, rows, errors, warnings }` | web polling (via batch status) |
| `import.dry_run_ready` | `{ batchId, report: DryRunReport }` | — |
| `import.committed` | `{ batchId, created: DryRunReport["create"], updated: DryRunReport["update"], assignmentIds: Id[] }` | M9 generate next FY, M10 |
| `import.failed` | `{ batchId, failureCode }` | — |
| `export.ready` | `{ exportId, kind: ExportKind, requestedById }` | M9 email link |
| `export.failed` | `{ exportId, kind }` | M9 |

### Notifications (producer M9)
| Type | `data` | Consumers |
|---|---|---|
| `notification.sent` | `{ kind: NotificationKind, recipientId, instanceId: Id \| null, sendDate: LocalDate }` | — (send log; dedupe key `(instanceId, kind, sendDate, recipientId)`) |

## 4. Rules
1. Add a type only through an M0 change request; never rename one (add `schemaVersion: 2` alongside instead).
2. An event that a consumer needs to act on must be emitted from the same transaction as the change (outbox). No "fire after commit" side calls.
3. Bulk operations emit one event per item plus at most one summary event.
4. Importer commit emits domain events with `actor.kind = "IMPORT"`, but M9 must **not** send reminders for instances created as already APPROVED or NOT_APPLICABLE (engine already returns none for them).

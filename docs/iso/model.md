# ISO add-on: data model, workflows, engine, files, reminders, audit

Part of plan v2 ([plan.md](plan.md), ADR [M16-0002](../adr/M16-0002-iso-plan-v2.md)). M0 (ISO-1) writes the exact
contract shapes from this file. M3 builds the tables, M4 the engine functions and M16 the routes. If a shape here and
the contract differ after ISO-1 merges, the contract wins and the coordinator corrects this file (plan §5.6).

Words: the root vocabulary applies. ISO words used here: **management system** (one client's system, covering one or
more standards), **clause**, **clause assessment** (one checklist row), **controlled document** and **revision**,
**risk item** (risk, opportunity, environmental aspect or OH&S hazard), **objective**, **internal audit**, **external
audit** (a certification body's visit), **finding**, **nonconformity** (NC), **action**, **management review**.

## 1. Table rules

Every ISO table follows `packages/db/CLAUDE.md` and ADR 0003. On top of that:

1. **Client tables** (everything in §3 and the join tables in §1.4) have `firm_id`, `client_id`, `clientPolicy()`,
   forced RLS, an isolation test, a unique `(firm_id, client_id, id)` for composite foreign keys, and an entry in
   `canopy_purge_tables()` in the same migration (the schema test checks it).
2. **Catalogue tables** (§2) are the account's own copy of the catalogue shipped as code (catalogue.md). They are
   firm-wide like `act`: `firm_id`, no `client_id`, forced RLS. Every context of the firm reads them. Only the
   catalogue copy writes them: the insert and update policies are `firm_id = app_firm_id() and app_system_job()`, so
   no staff context writes them and no route changes them. They get an isolation test and a purge-list entry like any
   other table.
3. **No deletes** (ADR 0003 decision 6). Rows that can be removed get `archived_at`. Join rows are never deleted
   either: removing a unit or person from a list sets the join row's `archived_at`, and a partial unique index covers
   live rows only.
4. **References** (ADR 0003 decision 5):
   - A reference to a row inside a client (unit, compliance instance, any ISO record) is a composite foreign key on
     `(firm_id, client_id, <col>)`. So a client-A record can never point at a client-B unit, instance or ISO record.
   - A reference to a firm-level row (person, obligation, catalogue row) is a composite foreign key on `(firm_id, id)`.
   - Lists of units or people are **join tables**, never `uuid[]` columns: `management_system_unit`,
     `certification_unit`, `internal_audit_unit`, `internal_audit_person` (role `AUDITOR | AUDITEE | REPORTED_TO`),
     `management_review_person` (role `ATTENDEE`), `nonconformity_person` (role `INVESTIGATOR`). Lists of ISO records
     are join tables too: `nonconformity_risk_item` (role `RELATED | UPDATED`), `nonconformity_document`,
     `objective_risk_item`. Each carries `firm_id` and `client_id` with foreign keys to both ends.
   - Lists of catalogue rows or obligations (`clauseIds`, `standardIds`, `obligationIds`) may be `uuid[]`. M16 checks
     on every write that each id exists in the account's copy.
   - A row that belongs to exactly one of several parents has one nullable foreign-key column per parent and
     `CHECK (num_nonnulls(...) = 1)`: `audit_finding` (internal or external audit), `iso_action` (§3.12) and `iso_file`
     (§6). No ISO table has a polymorphic `(type, id)` pair.
5. **People.** Every person reference (owner, approver, NA approver, lead auditor, auditor, auditee, reported-to, chair,
   attendee, investigator, reporter, disposition authoriser) must hold a live role in the record's client, and cover the
   record's unit when it has one, as `checkAssignee` does for instances (`apps/api/src/modules/instances/service.ts`).
   M16 checks this on every create and update and answers `400 VALIDATION` otherwise. The person must also be neither
   archived nor DISABLED (ISO-8a's check). A client-role actor cannot read a firm admin's or consultant's membership or
   person row (the `membership` and `person` policies), so from ISO-8b M16 makes the whole check, the person's own state
   included, through M3's role lookup (ISO-2i, ISO-2j; ADR M16-0005 decision 1), which answers yes or no without showing
   rows; before it a client role could name only members of the client (ADR M16-0004 decision 6). Jobs send ISO mail
   only through `recipients(personIds, clientId)`, which drops non-members.
6. **Versions.** Every ISO record that a route updates has `version` and takes optimistic concurrency like instances
   (`409 STALE_VERSION`).
7. **Stored engine results.** `RiskItem.rating`, `residualRating` and `significant` are stored when the item is
   written, from the engine's result, so lists can filter on them. The significance rule is not editable in v1
   (§5.1), so no recompute job exists. The only other stored engine result is a held management review's input
   figures (§3.13): a record, not a cache, stored once when the review is recorded held, never refreshed, and kept
   with the engine version that produced them (`packages/engine/CLAUDE.md` rule 4). Nothing else derived is stored.
8. **Closed records are read-only.** A subject locked in §6 also refuses field edits, list changes (units, people,
   linked records) and new child rows (findings, checklist rows, actions, input notes, output decisions) with `409
   INVALID_TRANSITION`. Only its machine's actions change it. The one exception is in §6: a finding of a REPORTED internal
   audit still takes new actions. The document's own fields (owner, approver,
   `reviewDueOn`) stay editable while it is ACTIVE.
9. **Reasons.** Every field edit audited as `REASSIGN` (a new owner, approver, lead auditor or chair) or
   `DUE_DATE_CHANGE` (a moved planned, due, review or response date) needs a `reason` (`422 REASON_REQUIRED` without
   one), and the event carries it, as `instance.reassign` and `instance.dueDate` do. In contracts 1.8.1 (ISO-1a,
   README decision 51 p) each update body lists those fields: the checklist row's owner; a document's owner, approver
   and review date; a risk item's owner and review date; an objective's owner and due date; an internal audit's dates
   and lead; an external audit's response date; an action's owner and due date; an NC's reassign route (§4.1); a
   review's date and chair (replan, §4.5). Other edits are `UPDATE` with no reason. A date that a step sets needs
   none, and its event names the step or the action: REVIEW's next `reviewDueOn`, PLAN_ACTIONS'
   `effectivenessDueOn`, RECORD_HELD's visit dates, and a risk item's `reviewDueOn` set to today when a treatment
   action puts a control in place (§3.5) (the ISO-1 audit, Low 5).

## 2. Catalogue tables (per-account copy)

```
IsoStandard         code (ISO_9001 | ISO_14001 | ISO_45001), edition ("2015+A1:2024"), title, topic
                    unique (firm, code, edition)
IsoClause           standardId, number (ClauseNumber, "6.1.2"), title, summary (our own words), parentId,
                    hlsKey (the shared structure key, "6.1"), assessable (bool), exclusionAllowed (bool)
                    unique (firm, standardId, number)
IsoReviewInputDef   standardId, key, clauseNumber ("9.3.2"), item ("c1"), title (our words),
                    source (PREVIOUS_ACTIONS | CONTEXT | RISKS | OBJECTIVES | NONCONFORMITIES | INCIDENTS |
                    AUDIT_RESULTS | COMPLIANCE_EVALUATION | MANUAL)
IsoReviewOutputDef  standardId, key, clauseNumber, item, title (our words)
```

The rules for `assessable` and `exclusionAllowed`, and the input and output keys, are in [catalogue.md](catalogue.md).
The STANDARD acts, their category and obligations are copied into the existing `act`, `category` and `obligation`
tables (catalogue.md §2), not into ISO tables.

## 3. Client records

Fields in contract style; `[]` marks a list (a join table or `uuid[]` per §1.4). Every record also has the base
fields (`id`, `firmId`, `clientId`, `createdAt`, `updatedAt`, `version`, `archivedAt` where removable).

### 3.1 ManagementSystem
```
name, standardIds[] (one or more IsoStandard ids; one edition per standard), scopeStatement,
unitIds[] (empty = not chosen yet; unit scope then treats the system as covering every unit of the client, plan §3.3),
status (PLANNING | IMPLEMENTING | CERTIFIED | SUSPENDED | WITHDRAWN), reviewIntervalMonths (default 12),
climateChangeRelevant (bool | null; null = not decided), climateChangeRationale (required when not null),
climateDecidedOn (date | null)
```
One climate decision per system: Amd 1:2024 adds the same wording to clause 4.1 of all three standards, so an
integrated system records it once. Setting or changing it is audited, like an NA decision. Once decided it can change
but not return to null (`400 VALIDATION`). M3 backs this rule and the growing-only `standardIds` below with one
trigger, `management_system_guard` (ISO-2d), which raises `check_violation` (DbError `VALIDATION`); M16 checks both
first and answers `400 VALIDATION`, so a trigger error never reaches a caller.

`standardIds` may only grow. A new system, and a standard added to one, get their checklist rows (§3.3) through M3's
`clauseAssessments.addForStandards` in the same transaction (`managementSystems.create` adds none); dropping one is
`400 VALIDATION`, since
its checklist rows, certificates and reviews would lose their standard (contracts README decision 51 d). A client that
stops working to a standard leaves it in the system; moving to a newer edition is Later (catalogue §6).

### 3.2 ContextItem (4.1, 4.2)
```
managementSystemId, kind (INTERNAL_ISSUE | EXTERNAL_ISSUE | INTERESTED_PARTY), text, needs (interested parties:
their needs and expectations, and which become compliance obligations), climateRelated (bool, default false),
reviewedOn
```

### 3.3 ClauseAssessment (the checklist)
```
managementSystemId, clauseId (assessable clauses only), status (NOT_STARTED | PARTIAL | IMPLEMENTED | NOT_APPLICABLE),
justification, naState (NONE | REQUESTED | APPROVED | REJECTED),
statusBeforeNa (NOT_STARTED | PARTIAL | IMPLEMENTED | null), naRequestedById, naDecidedById, naDecidedAt,
ownerId, notes, lastReviewedOn
unique (managementSystemId, clauseId)
```
- One row per assessable clause of each standard of the system, created when the standard is added to the system.
- `NOT_APPLICABLE` is accepted only on a clause with `exclusionAllowed`, otherwise `400 VALIDATION`, and needs a
  justification: the N/A request body is `{ version, reason }` and the reason is stored as `justification`, so a
  request without one is `422 REASON_REQUIRED` like every other N/A request (contracts README decision 51 c). It
  takes effect only when an approver or client admin other than the requester approves it (PLAN.md §7 default 6, as
  for instance NA). Until then the row counts as NOT_STARTED in readiness. Request, approval, rejection and
  withdrawal each write an `AuditEvent`. REQUEST_NA stores the current status in `statusBeforeNa` and
  sets `status` NOT_APPLICABLE; REJECT_NA restores `statusBeforeNa`. A direct write of `status` is refused (`400
  VALIDATION`) while `naState` is REQUESTED or APPROVED, and a direct write of NOT_APPLICABLE is always refused. When
  the clause later applies (say the client starts design work), WITHDRAW_NA ends an approved N/A (§4.6).
- Clause 4.1 of any standard cannot be set to IMPLEMENTED while the system's `climateChangeRelevant` is null:
  `400 VALIDATION` on `status`, the message naming the climate decision. M16 asks the engine
  (`climateDeterminationGaps`, §5.1).

### 3.4 ControlledDocument and DocumentRevision (5.2, 7.5)
```
ControlledDocument  managementSystemId, code (unique per client), title,
                    type (POLICY | MANUAL | PROCEDURE | WORK_INSTRUCTION | FORM | EXTERNAL), clauseIds[],
                    status (ACTIVE | OBSOLETE), currentRevisionId (latest APPROVED revision; null before the first),
                    ownerId, approverId, reviewDueOn, lastReviewedOn,
                    retention (FORM only, text: how long records made on it are kept, where, how disposed of; 7.5.3.2),
                    issuer, externalRef (EXTERNAL only)
DocumentRevision    documentId, revision (text, "B" or "2.0"), changeNote, state (DRAFT | IN_REVIEW | APPROVED | SUPERSEDED),
                    preparedById, approvedById (null for a recorded edition of an EXTERNAL document: its issuer
                    approved it, not a person in the client), approvedAt (set for every APPROVED revision),
                    sendBackReason
```
A DRAFT or IN_REVIEW revision has no `approvedById`. Among APPROVED and SUPERSEDED revisions, `approvedById` is null
only on one approved by RECORD_EDITION; a revision approved by APPROVE always names its approver. The revision gets no
new field for this: the schema cannot tell the two apart, so M16 enforces it (RECORD_EDITION leaves it null, APPROVE
always sets it) and M3 may check it across the two tables (README decision 51 m; the ISO-1 audit, Low 2). There is no
RECORD type: records are the files on ISO records and on activity instances, and they
are not revised. A revision's file is its `iso_file` (§6); SUBMIT needs exactly one live CLEAN file on the revision.

### 3.5 RiskItem and RiskControl (6.1, 14001 6.1.2, 45001 6.1.2, 8.1.2)
```
RiskItem            managementSystemId, kind (RISK | OPPORTUNITY | ASPECT | HAZARD), unitId (nullable), activity,
                    description (the risk, opportunity, aspect or hazard),
                    impact (ASPECT: the environmental impact; HAZARD: the harm; required for both),
                    lifeCycleStages[] (RAW_MATERIAL | DESIGN | PRODUCTION | TRANSPORT | USE | END_OF_LIFE; ASPECT, at least one),
                    controlType (CONTROL | INFLUENCE; ASPECT, required),
                    routine (bool; HAZARD, required), personsExposed[] (WORKER | CONTRACTOR | VISITOR | PUBLIC; HAZARD, at least one),
                    condition (NORMAL | ABNORMAL | EMERGENCY; ASPECT and HAZARD, required),
                    assessedWith (text: the workers who took part, 45001 5.4 e),
                    likelihood 1-5, severity 1-5 (with the existing controls; for OPPORTUNITY the second axis means benefit),
                    residualLikelihood, residualSeverity (after the planned treatment actions),
                    rating, residualRating, significant (engine, stored per §1.7),
                    significantOverride (bool | null), significanceReason (required when the override is set),
                    obligationIds[] (statutory obligations it relates to), climateRelated (bool, default false),
                    ownerId, reviewDueOn, lastReviewedOn
RiskControl         riskItemId, text, hierarchy (ELIMINATION | SUBSTITUTION | ENGINEERING | ADMINISTRATIVE | PPE;
                    required for HAZARD), sourceActionId (nullable: the treatment action that put it in place)
```
- `RiskControl` rows are the controls in place. Planned controls are **treatment actions** (`IsoAction` on the risk
  item, §3.12) with `controlHierarchy`. Completing such an action adds a `RiskControl` from it in the same
  transaction and sets the item's `reviewDueOn` to today (audited), so the owner re-rates `likelihood` and `severity`
  now that the control exists. If OPEN treatment actions remain, the owner also re-rates the residual values; if none
  remain, `residualLikelihood` and `residualSeverity` are cleared.
- Setting or clearing `significantOverride` is an audited write with its reason.
- REVIEW (the item's owner, or a client admin, consultant or account admin, as `isoRisk.write` in plan §3.2; note)
  sets `lastReviewedOn` and the next `reviewDueOn` without other change. A risk item has no approver.

### 3.6 Objective and ObjectiveReading (6.2)
```
Objective           managementSystemId, standards[] (non-empty subset of the system's standard codes), text, target,
                    unitOfMeasure, baseline, direction (INCREASE | DECREASE | MAINTAIN), readingRule (RecurrenceRule),
                    riskItemIds[] (the risks, opportunities, aspects or hazards it addresses; 14001/45001 6.2.1),
                    ownerId, dueOn, closedOn, outcome (ACHIEVED | NOT_ACHIEVED | null)
ObjectiveReading    objectiveId, periodStart, periodEnd, value (numeric), note, recordedById
```
An objective that lists several standards counts once under each of them in per-standard views and review inputs.
Its plan (6.2.2: what, resources, who, when) is its actions (§3.12); its readings show how results are evaluated.
Monitoring indicators that are not objectives (9.1.1) stay recurring activities (catalogue.md §3).

### 3.7 AuditProgramme, InternalAudit, AuditChecklistItem (9.2)
```
AuditProgramme      managementSystemId, fy ("2026-27", the client's FY), notes        unique (managementSystemId, fy)
InternalAudit       programmeId, title, plannedStart, plannedEnd, clauseIds[], unitIds[], leadAuditorId,
                    auditorIds[], auditeeIds[], reportedToIds[], independenceNote (required when an auditor or the
                    lead is also an auditee), state (PLANNED | IN_PROGRESS | REPORTED | CLOSED | CANCELLED),
                    summary, reportedOn, cancelReason
AuditChecklistItem  internalAuditId, clauseId, unitId (nullable), question, auditorNote,
                    result (CONFORMS | FINDING | NOT_AUDITED | null until answered), findingId (set when FINDING),
                    notAuditedReason (required when NOT_AUDITED)
```
The lead auditor is not also listed in `auditorIds` (`400 VALIDATION`). Independence (9.2.2): when a person is both
auditor (or lead) and auditee of the same audit, the save is refused with `400 VALIDATION` unless `independenceNote`
is given. The note is stored, written into the audit event and printed in the audit report PDF.

### 3.8 ExternalAudit and Certification
```
Certification       managementSystemId, standardId, body, certificateNumber (null until issued), issuedOn (null until
                    issued), expiresOn (null until issued), scopeText (null = the system's scope),
                    unitIds[] (empty = the system's units)
ExternalAudit       managementSystemId, standardIds[] (one integrated visit can cover several),
                    type (STAGE_1 | STAGE_2 | SURVEILLANCE_1 | SURVEILLANCE_2 | RECERTIFICATION | SPECIAL | TRANSITION),
                    body, leadAuditorName (text: the body's auditor, not a Person), startOn, endOn,
                    recommendation (RECOMMENDED | RECOMMENDED_AFTER_CLOSURE | NOT_RECOMMENDED | null),
                    responseDueOn (the body's deadline for the corrective-action response, null if none),
                    state (PLANNED | HELD | RESPONDED | CLOSED | CANCELLED), cancelReason
```
A certificate's `standardId`, and each of an external audit's `standardIds`, is one of its system's `standardIds`
(`400 VALIDATION`). The database checks only that the standard is in the account's catalogue copy, so M16 checks this
on every write, as the mock does.
`certificateNumber`, `issuedOn` and `expiresOn` are set together or not at all (contracts README decision 51 a), so a
certificate being pursued can be recorded before it is issued. Until then its cycle (§5.2) is empty, it sends no
ISO_CERTIFICATE_EXPIRING or ISO_SURVEILLANCE_DUE reminder (§7), and the overview does not count it as expiring.

### 3.9 AuditFinding
```
AuditFinding        internalAuditId or externalAuditId (exactly one, CHECK num_nonnulls = 1),
                    type (MAJOR_NC | MINOR_NC | OBSERVATION | OFI | GOOD_PRACTICE), clauseIds[], unitId (nullable),
                    description, nonconformityId (set for MAJOR_NC and MINOR_NC, null otherwise)
```
- Saving a MAJOR_NC or MINOR_NC finding creates its Nonconformity in the same transaction: source INTERNAL_AUDIT or
  EXTERNAL_AUDIT, severity MAJOR or MINOR from the type, the finding's clauses and unit (or the audit's single unit),
  owner and approver given on the finding form.
- A finding's `type` moves only among OBSERVATION, OFI and GOOD_PRACTICE (to GOOD_PRACTICE only while it has no action
  that is not CANCELLED), or between MAJOR_NC and MINOR_NC, when the NC's severity follows in the same transaction,
  only while that NC is OPEN or ROOT_CAUSE_FOUND (`409 INVALID_TRANSITION` after, the window of §3.10) and never by
  the NC's own owner (`403 FORBIDDEN`). Every other move is `400 VALIDATION`: record a new
  finding instead of turning one into an NC, and cancel the NC instead of turning an NC finding into another type. So
  a finding and its NC never come apart (contracts README decision 51 f). An NC raised from a finding takes its
  severity only from the finding.
- OBSERVATION and OFI findings may have **improvement actions** (§3.12, 10.3). GOOD_PRACTICE findings have none.
  MAJOR_NC and MINOR_NC findings take no actions of their own; their corrective actions go on the NC (`400
  VALIDATION` otherwise), so the NC's PLAN_ACTIONS and SUBMIT guards see every one.
- An NC raised from a finding keeps the link only on the finding (`nonconformityId`); there is no reverse field.

### 3.10 Nonconformity (10.2, 9001 8.7, 45001 incidents)
```
Nonconformity       number (per client, from a sequence), managementSystemId,
                    source (INTERNAL_AUDIT | EXTERNAL_AUDIT | INCIDENT | NEAR_MISS | COMPLAINT | PROCESS | LEGAL | OTHER),
                    sourceInstanceId (nullable: the statutory or ISO activity instance that raised it, for example a
                    missed filing, a failed drill or an out-of-calibration check; composite FK to compliance_instance),
                    raisedFromRiskItemId (nullable), severity (MAJOR | MINOR), standards[], clauseIds[], unitId (nullable),
                    description, reportedById, reportedOn,
                    containment (for equipment found unfit, includes the check on earlier results, 9001 7.1.5.2),
                    correction (the immediate fix),
                    disposition (CORRECTION | SEGREGATION | RETURN_OR_SUSPENSION | CUSTOMER_INFORMED | CONCESSION | null;
                    nonconforming outputs, 9001 8.7), dispositionAuthorisedById,
                    rootCauseMethod (FIVE_WHYS | FISHBONE | OTHER), rootCause,
                    similarOccurrences (whether similar NCs exist or could occur, and where),
                    relatedRiskItemIds[] (risks reviewed), updatedRiskItemIds[] (risks, aspects or hazards updated
                    because of it), riskReview (text, "none needed" allowed),
                    systemChange (text, "none needed" allowed), changedDocumentIds[],
                    noActionReason, ownerId, approverId, dueOn, effectivenessDueOn, effectivenessNote,
                    effective (bool | null), closedOn, cancelReason, state (§4.1),
                    incident (§3.11; required when source is INCIDENT or NEAR_MISS, null otherwise)
```
The owner and the approver of an NC are different people (maker-checker). When `disposition` is set,
`dispositionAuthorisedById` is required (9001 8.7.2), and both are set no later than ADD_ROOT_CAUSE (`400 VALIDATION`
otherwise). `dueOn` is not before `reportedOn`. `rootCauseMethod` is required with `rootCause` from ADD_ROOT_CAUSE on
(the ISO-1 audit, Low 1).

**Severity and the incident outcome** are what SUBMIT_NO_ACTION reads (§4.1), so they change only while the NC is
OPEN or ROOT_CAUSE_FOUND (`409 INVALID_TRANSITION` after). On an NC raised by hand they change only on the reassign
route (§4.1), with a reason; the incident `outcome` likewise (§3.11), with `lostDays` when the outcome moves to or
from LOST_TIME. On an NC raised from a finding, severity follows the finding's type alone (§3.9), in the same window,
and the reassign route refuses it (`400 VALIDATION`). So an NC owner who is not a client admin cannot lower an NC's
severity or outcome to use SUBMIT_NO_ACTION, and nobody can raise them after an NC has skipped corrective action
(the ISO-1 audit, Medium 2). A client admin may, with a reason, like any reassignment.

### 3.11 Incident fields (stored on the nonconformity row)
```
occurredAt (timestamptz), location (text), type (INJURY | ILL_HEALTH | DANGEROUS_OCCURRENCE | ENVIRONMENTAL_RELEASE |
FIRE | PROPERTY_DAMAGE | NEAR_MISS), outcome (NONE | FIRST_AID | MEDICAL_TREATMENT | RESTRICTED_WORK | LOST_TIME |
FATALITY), personCategory (EMPLOYEE | CONTRACT_WORKER | VISITOR | PUBLIC | null), lostDays (int | null),
reportable (bool), statutoryInstanceId (nullable: the register instance for the statutory accident notice),
investigatorIds[], workerParticipation (bool: a non-managerial worker took part in the investigation, 45001 5.4)
```
Rules (45001 10.2):
- An INCIDENT or NEAR_MISS NC always has a `unitId`, so unit scope applies to it. The one exception is the values of a
  management review's figures, which count the whole system's incidents, outcomes and lost days included, with no names
  (§3.13 item 4, plan §3.3). Even there, the INCIDENTS row's figures and notes go only to a reader who may read every
  incident it counts, or who chairs or attends the review (§3.13 item 4).
- `occurredAt` is not after now, and its client-local day is not after the NC's `reportedOn` (`400 VALIDATION` on RAISE
  and on a PATCH that changes `occurredAt`; `reportedOn` is set by RAISE and never edited, so a stored row needs no
  recheck), so an incident is never dated after its NC was raised (§5.4).
- `type` is NEAR_MISS exactly when the NC's `source` is NEAR_MISS, and then `outcome` is NONE and `lostDays` null.
  `lostDays` is required when `outcome` is LOST_TIME and null otherwise (`400 VALIDATION`). `outcome` changes only
  as §3.10 says (the reassign route, while OPEN or ROOT_CAUSE_FOUND); the owner may still update `lostDays` on the
  NC's PATCH while the outcome stays LOST_TIME.
- The investigation reviews the related risk items. A new hazard found is raised as a HAZARD risk item from the NC
  (it is then in `updatedRiskItemIds`).
- When `reportable` is true, the NC page says a statutory accident notice is due, and the user may link an existing
  instance of a STATUTE obligation on the NC's unit in `statutoryInstanceId` (picked like `sourceInstanceId`; M16
  checks the unit and the act kind). The app has no route that creates an EVENT_DRIVEN instance (generate-instances
  skips them and the engine's `eventInstance` has no caller), so creating the notice instance from the incident is
  Later (plan §2). The ISO module never creates statutory instances.
- **Personal data.** No injured person's name, health or medical detail goes in any NC text field, comment, audit
  `before`/`after`, export or email: audit events keep changed fields for ever. That detail goes only in files
  (root non-negotiable 6). Screens say so next to the description fields. Those files are restricted as in §6.
- The API warns, but allows, when `workerParticipation` is false at ADD_ROOT_CAUSE.
- Incident frequency rates (LTIFR) need hours worked and are Later.

### 3.12 IsoAction (one action entity for every subject)
```
IsoAction           exactly one of nonconformityId | riskItemId | objectiveId | auditFindingId | managementReviewId
                    (nullable composite FKs, CHECK num_nonnulls = 1), text, resources (nullable), ownerId, dueOn,
                    doneOn, state (OPEN | DONE | CANCELLED), effectivenessNote (nullable), cancelReason,
                    controlHierarchy (risk items only, same values as RiskControl.hierarchy; required on a HAZARD item),
                    outputKey (management reviews only: the review output it carries out)
```
The contract shows the subject as `subject: { type: NONCONFORMITY | RISK_ITEM | OBJECTIVE | AUDIT_FINDING |
MANAGEMENT_REVIEW, id }`, derived from the column that is set. The UI names the action by its subject: corrective
action (NC), treatment action (risk item: 9001 6.1.2, 14001/45001 6.1.4), objective plan (6.2.2), improvement action
(finding, 10.3), review action (management review). There is no separate action for external audits: their findings
are AuditFindings, and actions hang off the finding or its NC.

Transitions: COMPLETE (owner; `doneOn` not in the future) OPEN → DONE; CANCEL (the subject's approver or a client
admin, reason) OPEN → CANCELLED; REOPEN (client admin, reason) DONE or CANCELLED → OPEN while the subject is open: an
NC not CLOSED or CANCELLED, a finding whose audit is not CLOSED or CANCELLED, a management review not CLOSED or
CANCELLED, an objective with no `closedOn`, a risk item not archived. A
change of owner or `dueOn` is a reassignment or due-date change and is audited.

### 3.13 ManagementReview (9.3)
```
ManagementReview    managementSystemId, standards[] (subset of the system's), plannedOn, heldOn (null until HELD),
                    chairId, attendeeIds[], minutes, state (PLANNED | HELD | CLOSED | CANCELLED), cancelReason
ReviewInput         managementReviewId, inputDefId, notes            (one row per IsoReviewInputDef key of the
                    review's standards; a key shared by several standards appears once),
                    sourceFigures (ReviewInputFigures | null), figuresStoredAt (timestamptz | null),
                    figuresEngineVersion (text | null)                  (stored figures, below)
ReviewOutput        managementReviewId, outputDefId, decision        (one row per IsoReviewOutputDef key, likewise)
```
Inputs with no data in the app (customer satisfaction, external provider performance and the other `MANUAL`
sources) are written by hand. Review decisions that need work become review actions (§3.12) with `outputKey`.

**Rows follow the review's standards.** While the review is PLANNED, a replan (§4.5) brings its rows in line with its
standards, as the M0 mock's `syncRows` does. A key no longer wanted has its row archived, and its notes or decision stay
on it. A kept row points at the key's definition in the first of the review's standards in code order. A new key, or one
that comes back, gets a new row. The unique keys of `review_input` and `review_output` hold among live rows only
(ISO-2g), and only a PLANNED review's rows change this way (ISO-2h's `syncForReview` refuses any other).

**Stored figures.** A held review keeps the figures it considered as its record (9001 9.3.3, 7.5.3):
1. **What.** Each live input row whose definition's source is not `MANUAL` stores `sourceFigures`, which is what
   `reviewInputFigures` (§5.4) returns for that source with the `since` and `asOf` §5.4 sets for RECORD_HELD;
   `figuresStoredAt`, the transaction's time; and `figuresEngineVersion`, `ENGINE_VERSION`. In the database
   (`review_input`, ISO-2g) they are `source_figures jsonb`, `figures_stored_at timestamptz` and `figures_engine_version
   text`, all null or all set, with `source_figures` a JSON object checked against the contract on write. A review whose
   `heldOn` is before its system's `createdOn` stores none: the app held none of its records on that day, so its rows
   keep null (from ISO-1a3; contracts 1.8.2 still counts such a review's own day).
2. **When.** M16 computes and stores them in the RECORD_HELD request's transaction (§4.5), after its guards pass,
   whoever takes the step (the chair, a client admin, or an account admin or consultant as delegate). If computing or
   storing fails, nothing commits and the review stays PLANNED. RECORD_HELD happens once, so the figures are stored
   once.
3. **Never changed.** A row gets its figures at most once: one UPDATE may set the three columns from all null to all
   set, and once `figures_stored_at` is set a trigger refuses any change to them, to `input_def_id`, to
   `management_review_id` and to `archived_at` (ISO-2g). Only `notes` stays editable, until CLOSED, and only the account
   purge removes the row. No route, job or engine version recomputes the figures. A HELD or CLOSED review shows its
   stored figures whatever happens to the records afterwards (an NC closed or cancelled, a re-rating, an archive, a new
   reading, a new engine version, a later review recorded with an earlier `heldOn`).
4. **The whole system.** The figures count the records of the review's system with no unit scope, whoever records or
   reads the review, so the chair, the attendees and every reader see the same values. Those values include other units'
   records: NCs, incidents with their outcomes and lost days, audit results and the statutory score. They are counts and
   sums with no names, and plan §3.3 accepts them as its one exception. On the way out, each figure's ids are cut to the
   records the reader may read (plan §3.3); its value never changes. **Incidents are the limit of that exception.** In a
   system with few units or few incidents, an outcome and its lost days can point to a person at another unit, which
   §3.11 keeps out of every other read. So when cutting the INCIDENTS row's ids for a reader would drop any id (an
   incident that reader may not read, plan §3.3), the reader gets the row with `figuresWithheld: true` and no
   `sourceFigures`, `figuresStoredAt` or `notes`, unless they are the review's chair or one of its attendees (from
   ISO-1a3). The notes go too, since they record what the meeting said about those incidents and any correction of their
   figures (item 6). The test reads the incidents the row counts, not the system's units, which can be narrowed after an
   incident was counted. A row with no figures (CANCELLED, or held before set-up), or whose incidents the reader may all
   read, is never withheld, and a client-wide reader never is. The screen and the pack say the figures and notes are
   withheld. The stored copy is the same for everyone, and guards read the row uncut. The review's minutes go to every
   reader of the review, so the RECORD_HELD form tells the chair to keep incident details in the INCIDENTS row's notes.
5. **By state.** PLANNED: computed on each read, as of today (§5.4), and nothing stored. HELD and CLOSED: the stored
   copy, never computed; a row without one (item 1) returns null, and the screen and the pack say why. CANCELLED (only
   ever from PLANNED): null. A `MANUAL` row: null in every state.
6. **After HELD** no route changes `heldOn`, the standards or which input rows the review has (only their notes, until
   CLOSED), so a stored `asOf` is always the review's `heldOn`. CLOSE stores and changes nothing. A step that retakes
   wrongly stored figures is Later (plan §2). Until it exists, a figure found wrong is corrected in words, never in the
   copy: in the row's notes while the review is HELD, and in the notes of the system's next review once it is CLOSED, so
   the record and its correction are both kept. A correction of INCIDENTS figures goes in an INCIDENTS row's notes,
   which item 4 withholds with them.

## 4. State machines

M4 holds every transition table below (`src/iso-status.ts`) and M16 enforces them; the API answers `409
INVALID_TRANSITION` for an action not allowed from the current state and `400 VALIDATION` naming the missing fields
when a guard fails (`422 REASON_REQUIRED` when the missing field is a reason). "Approver" means the record's approver;
a client admin may act as delegate, audited with `delegated: true`, as for instances. Every arrow writes an
`AuditEvent` in the same transaction.

**Who may act.** Plan §3.2 decides who may call an action (`can()`; ISO-4b writes its rows). The Who column names the
person on the record who normally takes the step; M4's tables hold the states and guards. Where plan §3.2 grants FA,
CO or CA the action, they may also take a step whose Who is the record's owner, row owner, lead auditor, chair or
client admin, audited with `delegated: true`. They never take an approver's step (VERIFY_EFFECTIVE,
VERIFY_NOT_EFFECTIVE, revision APPROVE and SEND_BACK, document REVIEW and MAKE_OBSOLETE, APPROVE_NA, REJECT_NA); only
the record's approver, or a CA as delegate, takes those. Nobody takes a checker step (VERIFY_*, APPROVE, APPROVE_NA)
on a record where they took a maker step (ADD_ROOT_CAUSE, PLAN_ACTIONS, SUBMIT, SUBMIT_NO_ACTION, revision SUBMIT,
REQUEST_NA) since its last RAISE, REOPEN, VERIFY_NOT_EFFECTIVE or DRAFT_REVISION: `403 FORBIDDEN`.

### 4.1 Nonconformity

| From | Action | Who | Guard | To |
|---|---|---|---|---|
| (new) | RAISE | any role but viewer, for a unit they can see; automatic from an NC finding | description, source, severity, owner, approver; sets `reportedById`, `reportedOn`; `dueOn` not before `reportedOn`; `incident` when INCIDENT or NEAR_MISS; by hand, any source but INTERNAL_AUDIT and EXTERNAL_AUDIT, which come only from an NC finding (§3.9; contracts `RaisableNcSource`) | OPEN |
| OPEN | ADD_ROOT_CAUSE | owner | containment, correction, rootCauseMethod, rootCause, similarOccurrences; INCIDENT or NEAR_MISS also needs related risk items or a `riskReview` | ROOT_CAUSE_FOUND |
| ROOT_CAUSE_FOUND | PLAN_ACTIONS | owner | at least one OPEN action on the NC; sets `effectivenessDueOn` (editable later, audited) | ACTIONS_PLANNED |
| ROOT_CAUSE_FOUND | SUBMIT_NO_ACTION | owner | `noActionReason`, `riskReview`, `systemChange`; refused when severity is MAJOR, source is EXTERNAL_AUDIT, the incident outcome is LOST_TIME or FATALITY, or the NC has had a VERIFY_NOT_EFFECTIVE | AWAITING_VERIFICATION |
| ACTIONS_PLANNED | SUBMIT | owner | at least one action on the NC DONE, every action on the NC DONE or CANCELLED; `riskReview` and `systemChange` recorded; after a VERIFY_NOT_EFFECTIVE or REOPEN, at least one action created since then is DONE | AWAITING_VERIFICATION |
| AWAITING_VERIFICATION | VERIFY_EFFECTIVE | approver | `effectivenessNote`; not before `effectivenessDueOn` when set; sets `effective`, `closedOn` | CLOSED |
| AWAITING_VERIFICATION | VERIFY_NOT_EFFECTIVE | approver | reason, `backTo` OPEN (root cause was wrong) or ACTIONS_PLANNED; sets `effective = false`; with `backTo` ACTIONS_PLANNED also a new `effectivenessDueOn` after today; with `backTo` OPEN it clears `effectivenessDueOn` | OPEN or ACTIONS_PLANNED |
| any but CLOSED, CANCELLED | CANCEL | approver, client admin | reason | CANCELLED |
| CLOSED | REOPEN | client admin | reason, `backTo` OPEN or ACTIONS_PLANNED; clears `closedOn`; with `backTo` ACTIONS_PLANNED also a new `effectivenessDueOn` after today | OPEN or ACTIONS_PLANNED |

Changing an NC's owner, approver, severity or incident outcome, or moving its `dueOn` or `effectivenessDueOn`, is not
a step of the machine but its own route, `POST .../nonconformities/{id}/reassign` (ISO-1a), under `isoNc.reassign`
(plan §3.2: account admin, consultant or client admin), with a reason, audited as `REASSIGN`, `DUE_DATE_CHANGE` or,
for severity and outcome, `UPDATE`, each with the reason. Severity and outcome follow §3.10. The NC's PATCH is
`isoNc.work` only: its owner (or a client admin) edits every other field there (description, standards, clauses,
unit, source instance, the incident fields but `outcome`, and the investigation fields). An owner who is not a client
admin cannot reassign their NC, move its dates or change its severity or outcome (contracts README decision 51 h and
o). The owner and approver stay different people.

### 4.2 Document revision and document

| On | From | Action | Who | Guard | To |
|---|---|---|---|---|---|
| revision | (new) | DRAFT_REVISION | document owner | no other revision of the document in DRAFT or IN_REVIEW | DRAFT |
| revision | DRAFT | SUBMIT | document owner | not an EXTERNAL document; change note, one live CLEAN file | IN_REVIEW |
| revision | IN_REVIEW | APPROVE | document approver | approver is not the preparer | APPROVED; the previous APPROVED revision becomes SUPERSEDED and `currentRevisionId` moves, in the same transaction |
| revision | IN_REVIEW | SEND_BACK | document approver | reason | DRAFT |
| revision | DRAFT | RECORD_EDITION | document owner | EXTERNAL documents only: issuer, external reference, one live CLEAN file on the revision; no internal approval; sets `approvedAt`, leaves `approvedById` null | APPROVED; the previous APPROVED revision becomes SUPERSEDED and `currentRevisionId` moves, in the same transaction |
| document | ACTIVE | REVIEW | document approver | `currentRevisionId` set; note; sets `lastReviewedOn` and the next `reviewDueOn`; no new revision | ACTIVE |
| document | ACTIVE | MAKE_OBSOLETE | document approver | reason | OBSOLETE |

For an EXTERNAL document, DRAFT_REVISION opens the row the edition's file is uploaded to, and RECORD_EDITION approves
it once the scan has marked the file CLEAN. SUBMIT, APPROVE and SEND_BACK on a revision of an EXTERNAL document answer
`409 INVALID_TRANSITION`.

The approved revision stays in force while the next one is in DRAFT or IN_REVIEW. Lists and pills show the
document's status and current revision. Superseded revisions and obsolete documents are marked as such, left out of
default lists, and kept in the history every reader of the document sees (7.5.3.2). Every member of the client
reads the current revision of the system's documents whatever their units (5.2.2, 7.5.3.1 a).

### 4.3 Internal audit

| From | Action | Who | Guard | To |
|---|---|---|---|---|
| PLANNED | START | lead auditor | | IN_PROGRESS |
| PLANNED | CANCEL | client admin | reason | CANCELLED |
| IN_PROGRESS | REPORT | lead auditor | summary; at least one `reportedToIds`; a checklist row for every clause in `clauseIds` with a result (NOT_AUDITED needs its reason); sets `reportedOn` | REPORTED |
| REPORTED | CLOSE | lead auditor, client admin | every NC raised by its findings has left OPEN | CLOSED |

Changing `plannedStart` or `plannedEnd` is a due-date change: audited, with a reason.

### 4.4 External audit

| From | Action | Who | Guard | To |
|---|---|---|---|---|
| PLANNED | RECORD_HELD | client admin | dates, report file | HELD |
| PLANNED | CANCEL | client admin | reason | CANCELLED |
| HELD | RECORD_RESPONSE | client admin | every finding with an NC has its NC past OPEN | RESPONDED |
| HELD | CLOSE | client admin | recommendation recorded; no finding of the audit has an NC | CLOSED |
| RESPONDED | CLOSE | client admin | recommendation recorded | CLOSED |

### 4.5 Management review

| From | Action | Who | Guard | To |
|---|---|---|---|---|
| (new) | PLAN | client admin | `plannedOn`, chair | PLANNED |
| PLANNED | CANCEL | client admin | reason | CANCELLED |
| PLANNED | RECORD_HELD | chair, client admin | `heldOn` not after the client-local today, attendees, notes on every input row; stores each input's figures (§3.13) | HELD |
| HELD | CLOSE | chair, client admin | a decision on every output row; every review action DONE or CANCELLED | CLOSED |

A review's standards, `plannedOn` and chair change only while it is PLANNED, through the
`POST .../management-reviews/{id}/replan` route under `isoReview.plan` (ISO-1a); a new `plannedOn` or chair needs a
reason (§1.9). The review's PATCH (attendees, minutes) is `isoReview.write`, which its chair holds.

RECORD_HELD stores figures that count records up to `heldOn` but read their state (cancelled, significance, severity,
incident outcome, finding type, instance workflow) as it is when the review is recorded (§5.4). Recording the review on
the day of the meeting keeps them closest to what the meeting saw. When `heldOn` is before today, the form says that the
stored figures will count up to `heldOn` but read that state as it is today, so they can differ from the live figures on
screen, which run to today. A review recorded with a `heldOn` earlier than another held review of the same standards
takes its `since` only from reviews held on or before its own `heldOn`, and leaves the other review's stored figures as
they are; the form says so when such a review exists.

### 4.6 Clause N/A

| From `naState` | Action | Who | Guard | To |
|---|---|---|---|---|
| NONE or REJECTED | REQUEST_NA | row owner, client admin | clause has `exclusionAllowed`; reason, stored as `justification` | REQUESTED |
| REQUESTED | APPROVE_NA | approver role or client admin, not the requester | | APPROVED (status NOT_APPLICABLE takes effect) |
| REQUESTED | REJECT_NA | the same | reason | REJECTED (`status` = `statusBeforeNa`) |
| APPROVED | WITHDRAW_NA | row owner, client admin | reason | NONE (`status` NOT_STARTED) |

### 4.7 Words for states and codes

The ISO screens (M17) and the audit trail page (M13) show a state, or any other value of a contracts ISO enum, in the
same plain words and never as the code. The words are the code in sentence case with a space for each underscore:
`ROOT_CAUSE_FOUND` reads "Root cause found", `IN_REVIEW` "In review", `STAGE_1` "Stage 1". The exceptions:

| Values | Words |
|---|---|
| `IsoStandardCode` ISO_9001, ISO_14001, ISO_45001 | the standard's `IsoStandard.title`: "ISO 9001", "ISO 14001", "ISO 45001" |
| `ClauseNaState` NONE, REQUESTED, APPROVED, REJECTED | "No request", "Not applicable requested", "Not applicable approved", "Not applicable refused" |
| `FindingType` MAJOR_NC, MINOR_NC, OFI | "Major nonconformity", "Minor nonconformity", "Opportunity for improvement" |
| `ControlHierarchy` PPE | "PPE" |
| `IsoActionSubjectType` NONCONFORMITY, RISK_ITEM, OBJECTIVE, AUDIT_FINDING, MANAGEMENT_REVIEW | the action's name by its subject (§3.12): "Corrective action", "Treatment action", "Objective plan", "Improvement action", "Review action" |
| `ReviewInputKey`, `ReviewOutputKey` | the title of the account's review definition (catalogue §5), not words made from the key |

An exception holds for its own enum only: the same code in another enum (APPROVED in `RevisionState`, NONE in
`IncidentOutcome`) follows the rule, so each map is keyed by enum, not by bare value. Each module keeps its own maps,
since neither imports the other's code, and tests each one against every value of its contracts enum, so a value
added later fails a test until it has words. Two kinds of code are not covered here: step names (`NcAction` and the
other `*Action` enums), verbs that each page words for its buttons and summaries; and entity types (`IsoEntityType`,
`IsoFileSubjectType`), which keep the audit page's record words (§8, ISO-12a).

## 5. Engine (M4, pure, explicit dates)

ISO functions go behind a separate `IsoEngineApi` interface in contracts (ISO-1), so adding them never breaks the
engine's `satisfies EngineApi` build before ISO-3 lands. The engine exports them as one object that `satisfies
IsoEngineApi`. Formulas need an M4 ADR and an `ENGINE_VERSION` bump (`packages/engine/CLAUDE.md` rule 4).

### 5.1 `src/iso-score.ts` (100% coverage: the `*score*` threshold applies)
- `riskRating(likelihood, severity)`: likelihood × severity on the fixed 1-5 scales, 1 to 25.
- `isSignificant(item, rule)`: `rule` is `FirmSettings.isoRisk` (default `{ significantAt: 12,
  legalLinkMakesSignificant: true }`, not editable in v1). Significant when the rating reaches `significantAt`, or,
  if the rule says so, when the item has an `obligationIds` link; a set `significantOverride` wins over both.
  `significant` is `isSignificant` applied to `rating` (the rating with existing controls); lists, the register
  export and the review pack use it. `residualRating` is shown beside it and does not decide significance.
- `clauseReadiness(assessments, clauses)`: assessable clauses only; IMPLEMENTED 1, PARTIAL 0.5; an APPROVED
  NOT_APPLICABLE on an `exclusionAllowed` clause leaves the denominator; any other NOT_APPLICABLE, or an unapproved
  one, scores 0. Per standard and for the whole system, with the clause ids behind each number.
- `certificationReadiness(system, data, asOf)`: per standard, the stage-1 gates as `{ gate, met, missing[] }`:
  INTERNAL_AUDIT (REPORTED or CLOSED audits with `reportedOn` in the 12 months up to `asOf` together cover, as
  defined for `auditProgrammeCoverage` below, every assessable, not-excluded clause and every unit of the system; a
  NOT_AUDITED row covers nothing; `missing` lists the uncovered clause numbers and units), MANAGEMENT_REVIEW (a HELD
  or CLOSED review with `heldOn` in those 12 months covers the standard and has notes on every input; `missing` lists
  inputs without notes or says there is none), SCOPE (scope statement set and at least one unit), POLICY (an ACTIVE
  POLICY document with an APPROVED revision linked to the standard's clause 5.2), OBJECTIVES (at least one objective
  for the standard, and every objective without `closedOn` has at least one action, its 6.2.2 plan; `missing` lists
  those without), RISKS (6.1: for ISO 9001 at least one RISK or OPPORTUNITY item; for ISO 14001 at least one ASPECT;
  for ISO 45001 at least one HAZARD; live items of the system; `missing` names the kind that is absent).
  Clause readiness is the client's self-assessment; these gates come from records; neither replaces the other.
- `objectiveProgress(readings, objective, asOf)`: latest value, progress towards target by direction, on track or
  not, missed readings. The objective's creation day reaches it as `createdOn`, a `LocalDate` (its `createdAt` in the
  client's time zone, passed by the caller through the engine's date helper, as for `managementReviewDue`), never as
  an `Instant`: an objective created at 02:00 IST is still that day's. It also takes `{ fyStartMonth }`, since
  reading periods follow the client's financial year as `generateInstances` does (ISO-1a, README decision 51 r; the
  ISO-1 audit, Medium 3).
- `auditProgrammeCoverage(audits, checklistItems, system, clauses, fy)`: a clause is covered when a checklist row of
  a REPORTED or CLOSED audit in that FY's programme names it with result CONFORMS or FINDING (a NOT_AUDITED row covers
  nothing). A unit is covered when such a row names the unit; a row with no unit covers the units in its audit's
  `unitIds` (none when that list is empty, so an audit must name its units to cover them). It returns the
  assessable, not-excluded clauses and the system's units that are not covered, with planned, reported and cancelled
  counts (the "audit programme progress" KPI).
- `incidentCounts(ncs, period, timeZone)`: by incident type and outcome, by the client-local date of `occurredAt`,
  with the NC ids behind each number.
- `climateDeterminationGaps(system, contextItems, riskItems)`: `UNDECIDED` when `climateChangeRelevant` is null;
  `RELEVANT_NO_RISK` when it is true and no risk item of any kind (RISK, OPPORTUNITY, ASPECT or HAZARD) is
  `climateRelated`; `RELEVANT_NO_ISSUE` when it is true and no context item is `climateRelated`; otherwise none.

### 5.2 `src/iso-status.ts` (100% coverage: the `*status*` threshold applies)
- The transition tables of §4 and one `isoTransition(machine, from, action, facts)` that returns the next state or
  the failed guard.
- `nonconformityStatus(nc, actions, asOf, { dueSoonDays })` and `actionStatus(action, asOf, { dueSoonDays })`: on
  time, due soon, overdue, with overdue days; the NC status also reports an overdue effectiveness check
  (`effectivenessDueOn`). `dueSoonDays` is `FirmSettings.dueSoonDays`, so DUE_SOON means what it means on the
  register; `managementReviewDue` and `reviewDue` take the same option (contracts README decision 51 k).
- `certificationCycle(certification, externalAudits, asOf)`: surveillance 1 and 2 and recertification due dates
  (recertification before `expiresOn`; none while the certificate is not issued, §3.8), each marked met by a HELD,
  RESPONDED or CLOSED external audit of that type that covers the certificate's standard and ended after the
  certificate's `issuedOn` (the current cycle only; for SURVEILLANCE_2, also after the audit that met SURVEILLANCE_1).
  An audit that ended after the due date marks it met late, with the days late. With no such audit, the result gives
  the overdue days up to `asOf`.
- `managementReviewDue(system, reviews, asOf, { dueSoonDays })`: per standard of the system, the next due date is
  the last HELD or CLOSED review covering that standard plus `reviewIntervalMonths`. With no such review, it is
  `system.createdOn` (the system's `createdAt` as a `LocalDate` in the client's time zone, passed by the caller
  through the engine's date helper) plus the interval. Returns due soon and overdue per standard.
- `reviewDue(reviewDueOn, asOf, { dueSoonDays })` for documents and risk items.

### 5.3 `src/iso-notifications.ts`
`planIsoNotifications(items: IsoNotificationInput[], schedule: IsoReminderSchedule, asOf: LocalDate):
PlannedIsoNotification[]` (§7). `planNotifications` stays instance-only and unchanged.

- `IsoNotificationInput` is `{ kind: IsoNotificationKind, isoSubjectType: IsoEntityType, isoSubjectId: Id,
  anchorDate: LocalDate, open: boolean, recipientIds: Id[] }`. M9 builds one per subject, kind and anchor date of the
  §7 table (`dueOn`, `reviewDueOn`, `plannedStart`, `expiresOn`, an unmet `certificationCycle` due date,
  `responseDueOn`, `plannedOn` or a `managementReviewDue` date, `effectivenessDueOn`), with the recipients that table
  names already resolved, and sets `open: false` for a DONE, CANCELLED, CLOSED, OBSOLETE or SUPERSEDED subject or a
  met cycle date.
- `IsoReminderSchedule` is a list of `{ kind, isoSubjectType, offsetDays: int[], repeatEveryDays: int | null }`
  (negative offsets are days before the anchor). The engine uses the entry for the item's kind and subject type, so
  ISO_MANAGEMENT_REVIEW_DUE has one entry for a planned review and one for an overdue system. With
  `repeatEveryDays`, it sends again that many days after the last offset while the item stays open.
- It returns one `PlannedIsoNotification` per recipient with `sendDate` = `asOf` when `asOf` is a send day, as
  `planNotifications` does, so a daily run plans each one once.

The statutory `computeScore` and its breakdowns are unchanged; callers pass STATUTE-act instances only (plan §4.6).

### 5.4 `src/iso-review.ts`
`reviewInputFigures(source, data, since, asOf)` returns one input source's figures between `since` and `asOf`, both days
included, each number with the ids behind it. Contracts 1.8.2 (ISO-1a2) types `data` per source (`ReviewFigureData`,
taken by the generic `TypedReviewInputFigures`) but keeps `IsoEngineApi`'s wide `data` of 1.8.1, so ISO-3's engine,
which declares its own per-source types, still builds; ISO-3b types the engine function with the contract's, and ISO-1c
(contracts 1.8.6) narrows `IsoEngineApi` to it. `data` holds the records of the review's system that the source reads,
as each source below says, archived ones included, with no unit scope (§3.13). Every timestamp arrives as a client-local
day: ISO-2h's `gather` takes the day function from its caller (the engine's `localDateIn` with the client's time zone),
since `packages/db` does not import the engine; INCIDENTS also gets the client's time zone for `occurredAt`, as
`incidentCounts` does. M3 gathers `data` and `since` (ISO-2h's `reviewFigures.gather`), so M16 and M10 pass the same.

The engine reads each record as it is now, except where a date gives its state on `asOf`:
- A record counts from its creation day (`createdOn` on or before `asOf`). A nonconformity counts from the later of
  `createdOn` and `reportedOn`, its counting day: NONCONFORMITIES counts it as raised on that day, and INCIDENTS places
  its incident by it.
- A record archived after `asOf` counts as live. One archived on or before `asOf` counts in no figure but
  `contextItemsRemoved`, and there only when it was archived in the window.
- An NC with `closedOn` after `asOf` counts as open, and so does an objective whose close is placed after `asOf`
  (below). REOPEN clears an NC's `closedOn`, so a reopened NC counts as open and its earlier close is not counted (read
  as it is now).
- A date a user enters, which may be in the past, places its record by the later of that date and the client-local day
  of the latest event that set it, which the caller reads from the audit trail (§8): an internal audit by `reportedOn`
  and its REPORT step, an external audit by `endOn` and its RECORD_HELD step or a later UPDATE that changed `endOn` (it
  may change while the audit is HELD or RESPONDED; moved after a review counted it, the audit and its findings can count
  in two reviews, and the stored ids show it), a DONE action by `doneOn` and its COMPLETE step, and a closed objective
  by `closedOn` and its CLOSE step. A CANCELLED action is placed by its CANCEL step. That day is the action's settled
  day, and the action counts as OPEN on `asOf` until then; a closed objective likewise counts as open until its day.
  When an action was settled more than once (REOPENed and settled again), its latest step counts. So a record entered
  after one review is recorded, but dated before it, counts in the next one. A record whose trail has no event that set
  its entered date or settled it (seeded or loaded data) takes its `createdAt` as that event's time, so it is placed by
  the later of its entered date and its creation day. `createdAt` never changes, so the record is placed once, and a
  record loaded after a review was recorded falls on or after that review's `heldOn`. `updatedAt` is not used: any later
  write (a system PATCH, an audit's CLOSE) moves it. Two kinds of record are placed through another: an incident by its
  NC's counting day (above; its `occurredAt` day is never later, §3.11), and an audit finding by the later of its
  audit's day and its own `createdOn`. ISO-1a3 adds the step days to `data` (findings and incident NCs already carry
  `createdOn` in 1.8.2), and ISO-3b applies these rules; until then the entered date alone places a record (an incident
  by its `occurredAt` day, a finding with its audit), and an action counts as OPEN while its `doneOn` is after `asOf`,
  unless it is CANCELLED.
- The climate decision: each call of the climate route that changes any climate field, the rationale alone included, is
  a decision, placed by the client-local day of its UPDATE event (§8; `climateDecidedOn` is never later).
  `climateDecided` counts from the first decision on or before `asOf`, since a decision never returns to undecided
  (§3.1); `climateDecidedInPeriod` counts when a decision falls in the window; `climateRelevant` is read as it is now. A
  system decided on climate when it was seeded or loaded has that decision too, placed by the later of
  `climateDecidedOn` and its creation day: one with no decision event in its trail, and one whose earliest decision
  event does not move `climateChangeRelevant` from null (its events count as later decisions). ISO-1a3 adds the
  decisions' days; until then `climateDecidedOn` alone places the decision.
- `readingsRecorded` counts the readings created in the window. On-track (`objectiveProgress`) uses only readings
  created on or before `asOf` whose period ends on or before `asOf`.
- Window counts with no date field of their own take the days of the audited events in the window that the caller
  passes: risk-item UPDATE events whose `after` names `likelihood`, `severity`, `residualLikelihood` or
  `residualSeverity` (re-rated; the UPDATE that clears a residual rating when a treatment action completes carries
  `sourceActionId` in `after` and is not a re-rating, §8); context-item UPDATE events (changed); nonconformity
  TRANSITION events whose `after.action` is `VERIFY_NOT_EFFECTIVE`.

Everything else is read as it is now: whether an NC or an audit is cancelled, significance, severity, incident outcome,
finding type and instance workflow. That is why a held review's figures are stored (§3.13), not recomputed.

**The window**, set by the caller:
- `asOf` is the client-local today for a PLANNED review, and the review's `heldOn` when RECORD_HELD stores the figures.
- For each standard of the input, take the later of the system's `createdOn` (its `createdAt` as a client-local day) and
  the `heldOn` of the last other review of the same system that covers that standard, is HELD or CLOSED, and has
  `heldOn` on or before `asOf`. At RECORD_HELD only reviews already held count, so one recorded earlier with the same
  `heldOn` counts as earlier. `since` is the earliest of these days across the input's standards, and never after
  `asOf`. From ISO-1a3, RECORD_HELD stores no figures for a review held before its system's `createdOn` (§3.13 item 1).
- The figures are not split by standard. When the input's standards were last reviewed on different days, a record of
  the standard reviewed more recently can count both in that review and in this one. The stored window says which days
  the figures cover; a window per standard is Later (plan §2).
- Both ends of a window are included, and `since` is the day the earlier review's own window ended. So a record placed
  on that `heldOn` that already existed when the earlier review was recorded counts in both; the stored ids show it.
  Leaving out what the earlier review already counted on that day is Later (plan §2).
- PREVIOUS_ACTIONS reads the review actions of every such earlier review that covers one of the input's standards: those
  OPEN on `asOf` and those of them overdue, whichever review raised them, and those DONE or CANCELLED with their settled
  day in the window. An action settled before `since` was reported to an earlier review and is not counted again
  (ISO-1a3; 1.8.2 counts every DONE and CANCELLED one).

**Records by source:**
- PREVIOUS_ACTIONS: as above.
- CONTEXT: the system's context items, whatever the input's standards: added, changed and removed, and the climate
  decision.
- RISKS: the system's risk items of the kinds the input's key reads (`SIGNIFICANT_ASPECTS`: ASPECT;
  `RISKS_AND_OPPORTUNITIES`: RISK and OPPORTUNITY, and HAZARD when ISO 45001 is among the input's standards;
  `RISK_ACTIONS` (9001 only): RISK and OPPORTUNITY; ISO-1a3) and their treatment actions: items added or re-rated,
  significant items for each kind the key reads (no `significant<Kind>` figure for a kind it does not read), treatment
  actions done and open. So a 14001 review's two RISKS rows never count, or show a zero for, each other's items.
- OBJECTIVES: the system's objectives whose standards overlap the input's, with `objectiveProgress` for each.
- NONCONFORMITIES: the system's NCs whose standards overlap the input's, raised and closed by source and severity,
  VERIFY_NOT_EFFECTIVE counts, and the overdue corrective actions of NCs open on `asOf` (ISO-1a3 in the mock, ISO-3b in
  the engine).
- INCIDENTS: the same NCs, cancelled ones left out, each incident placed by its NC's counting day (above), then grouped
  by type, outcome and lost days as `incidentCounts` groups them (ISO-1a3, ISO-3b; 1.8.2 places an incident by its
  `occurredAt` day). Who sees them: §3.13 item 4.
- AUDIT_RESULTS: internal audits REPORTED or CLOSED, placed by `reportedOn` (above), whose clauses' standards overlap
  the input's (an audit that lists no clauses counts with the system's standards); external audits HELD, RESPONDED or
  CLOSED, placed by `endOn` (above), whose `standardIds` overlap; and the findings of every audit that meets those state
  and standards rules, by type, each placed by the later of its audit's day and its own `createdOn` (above), whether or
  not its audit counts in this window, and each only when its clauses' standards overlap the input's (a finding with no
  clauses follows its audit; ISO-1a3). So a finding entered after a review that counted its audit counts in the next
  review.
- COMPLIANCE_EVALUATION: the latest `COMPLIANCE-EVALUATION` activity instance, and the STATUTE-only `computeScore`
  over the STATUTE instances on the system's units for the window.
- MANUAL: none.

Callers: M16 computes live figures for a PLANNED review and stores them once at RECORD_HELD; M10 computes them for the
pack of a PLANNED review. Both take `since` and `data` from ISO-2h's `reviewFigures.gather`, so the screen and the pack
agree. A HELD or CLOSED review's figures are always the stored copy.

## 6. Files (`iso_file`)

ISO files never go in the `evidence` table. `Evidence`, `EvidenceView`, the evidence table, the vault and M7's
`/evidence/{id}/*` routes do not change.

```
IsoFile             exactly one of clauseAssessmentId | documentRevisionId | riskItemId | objectiveReadingId |
                    internalAuditId | auditFindingId | externalAuditId | certificationId | nonconformityId |
                    isoActionId | managementReviewId (nullable composite FKs (firm_id, client_id, <col>),
                    CHECK num_nonnulls = 1), fileName, mimeType, sizeBytes, sha256, scanStatus, uploadedById,
                    uploadedAt, archivedAt, removeReason, storageKey (never returned)
IsoFileView         the same without storageKey, with `subject: { type, id }`
```
- Same pipeline as evidence: upload ticket (5-minute presigned PUT, the evidence file-type and size rules) →
  confirm (row PENDING) → virus scan (M9) → download only when `CLEAN`, through a 5-minute signed URL, every download
  audited. Never log file contents, names from the file, or signed URLs.
- Keys: `evidence/<firmId>/<clientId>/iso/<subjectType>/<subjectId>/<uploadId>`, inside the account purge prefix
  `evidence/<accountId>/` (`apps/api/src/platform/purge-objects.ts`).
- The code is M7's (ISO-15): `createIsoFiles` lives in `apps/api/src/modules/evidence/db-iso-files.ts` (a `db-*.ts`
  file, so `vitest.db.config.mjs` holds it to the coverage floor) and is re-exported from M7's new public index
  `apps/api/src/modules/evidence/index.ts`. M16 declares an `IsoFiles` port in `apps/api/src/modules/iso/ports.ts`
  and never imports M7 code. `apps/api/src/server.ts` (shared) builds `createIsoFiles({ storage:
  options.evidenceStorage })` and passes it to M16's routes, as it builds `createEvidenceService`, so the ISO file
  routes mount only when evidence storage is configured (ISO-14b). M16 checks the feature, the subject, the unit
  scope, `can()` and the lock rule below, then calls the port inside the request's tenant transaction, so the
  `iso_file` row and its `AuditEvent` (entity = the ISO subject) commit together. Actions: `EVIDENCE_ADD` on
  confirm, `EVIDENCE_DOWNLOAD` on downloadUrl, `EVIDENCE_REMOVE` on remove, with `after` naming the ISO file id
  (never a signed URL or the file name); uploadUrl and list write none.
- The port, as ISO-15 (#301) built it and ISO-8a (#302) declares it in `apps/api/src/modules/iso/ports.ts` (ADR
  M16-0004 decision 2). `tx` is the request's tenant transaction; every call that writes or signs also takes the
  caller, since the transaction carries neither the person nor the request id that the `AuditEvent` and the storage
  key need (the client comes from the subject). `get` lets M16 check a file's subject and lock before a download or
  a removal, and the upload ticket carries the headers the PUT must send:
  ```ts
  type IsoFileCaller = Pick<RequestContext, 'firmId' | 'personId' | 'requestId'>;
  interface IsoFiles {
    uploadUrl(tx, caller: IsoFileCaller, subject: IsoFileSubject,
              file: { fileName; mimeType; sizeBytes }): Promise<UploadTicket>;
    confirm(tx, caller: IsoFileCaller, subject: IsoFileSubject,
            upload: { uploadId; fileName; sha256 }): Promise<IsoFileView>;     // PENDING, audited
    list(tx, subject: IsoFileSubject, options?: { includeRemoved?: boolean }): Promise<IsoFileView[]>;
    get(tx, fileId: Id): Promise<IsoFileView | null>;                         // removed ones included
    downloadUrl(tx, caller: IsoFileCaller, fileId: Id): Promise<SignedUrl>;  // CLEAN only, audited
    remove(tx, caller: IsoFileCaller, fileId: Id, reason: string): Promise<IsoFileView>; // archives, audited
  }
  ```
- Routes (M16, under `/clients/{clientId}/iso/files`): upload URL, confirm, list by subject, download URL, remove
  (reason; archives, never deletes). They answer `403 FEATURE_NOT_ENABLED` when the add-on is off.
- **Locked subjects.** A file can be added or removed only while its subject is open for edits; otherwise `409
  INVALID_TRANSITION`. Locked: the file of an IN_REVIEW, APPROVED or SUPERSEDED revision (in review, the approver
  sends it back to change the file; once approved, a wrong file is fixed by a new revision); a CLOSED NC (REOPEN
  first) or a CANCELLED NC (final), and its actions; a DONE or CANCELLED action, whatever its subject (REOPEN first,
  which needs the subject open); a REPORTED, CLOSED or CANCELLED internal audit, its checklist and its findings, except that a
  finding of a REPORTED audit still takes new improvement actions (§3.9, §3.12) until the audit is CLOSED; a CLOSED or
  CANCELLED external audit and its findings; a CLOSED management review. A locked subject also refuses field edits (§1.8).
  The ADR 0004 rule that managers may remove instance evidence in any state does not carry over.
- Who reads a file: whoever may read its subject (unit scope, plan §3.3). The current revision's file of a
  system document is readable by every member of the client. Files on a nonconformity whose `incident` is set, and
  on its actions, can be downloaded only by the NC's owner, approver and investigators, client admins, consultants
  and account admins. Other readers of the NC see the file list without a download (`403 FORBIDDEN` on the download
  URL), because these files hold the injured person's details (§3.11).
- The M9 scan job scans PENDING `iso_file` rows through M3's `isoFiles.pendingScan`, which does not join instances,
  with the add-on on or off (plan §4.5), and writes the scan's `AuditEvent` on the ISO subject. It writes no
  `evidence.scanned` event (that event names an instance); no consumer needs an ISO scan event in v1.

## 7. Reminders

ISO records are not instances, so they cannot use the instance send key.

- Contracts (ISO-1): `PlannedIsoNotification { kind, recipientId, isoSubjectType, isoSubjectId, sendDate, offsetDays }`
  and `ISO_NOTIFICATION_DEDUPE_KEY = [isoSubjectType, isoSubjectId, kind, sendDate, recipientId]`. `SendKey` in
  `apps/api/src/jobs/ports.ts` gains optional `isoSubjectType` and `isoSubjectId` (M9).
- Send log (ISO-2b): `notification_send` gets nullable `iso_subject_type` (`entity_type`) and `iso_subject_id`, a
  check that `instance_id` and `iso_subject_id` are not both set, a unique index `notification_send_iso_subject_key`
  on `(firm_id, iso_subject_type, iso_subject_id, kind, send_date, recipient_id) where iso_subject_id is not null and
  event_id is null`, and `notification_send_digest_key`'s predicate narrowed with `and iso_subject_id is null`. So two
  ISO records due the same day for the same person are two sends, never merged by the digest key.
- Kinds (staged in the database first, plan §5.1): `ISO_ACTION_DUE`, `ISO_ACTION_OVERDUE`, `ISO_REVIEW_DUE`,
  `ISO_AUDIT_STARTING`, `ISO_CERTIFICATE_EXPIRING`, `ISO_SURVEILLANCE_DUE`, `ISO_EXTERNAL_RESPONSE_DUE`,
  `ISO_MANAGEMENT_REVIEW_DUE`, `ISO_EFFECTIVENESS_DUE`. Each is "Scheduled, keyed on its ISO subject".
- Default schedule (`ISO_REMINDER_SCHEDULE` in contracts `src/defaults.ts`, ISO-1, in the `IsoReminderSchedule`
  shape of §5.3; M9 passes it to the engine; not editable in v1; the M4 ADR records it):

| Kind | Subject | Recipients | When |
|---|---|---|---|
| ISO_ACTION_DUE | IsoAction | owner | 7 days before and on `dueOn` |
| ISO_ACTION_OVERDUE | IsoAction | the subject's approver, else client admins | 7 days overdue |
| ISO_REVIEW_DUE | ControlledDocument, RiskItem | owner; for a ControlledDocument also its approver (only the approver can REVIEW, §4.2) | 14 days before and on `reviewDueOn` |
| ISO_AUDIT_STARTING | InternalAudit | lead, auditors, auditees | 7 days and 1 day before `plannedStart` |
| ISO_CERTIFICATE_EXPIRING | Certification | client admins | 90, 30 and 7 days before `expiresOn` |
| ISO_SURVEILLANCE_DUE | Certification | client admins | 60 and 30 days before a cycle due date, until `certificationCycle` marks it met |
| ISO_EXTERNAL_RESPONSE_DUE | ExternalAudit | client admins, owners of its open NCs | 7 days before and on `responseDueOn` |
| ISO_MANAGEMENT_REVIEW_DUE | ManagementReview / ManagementSystem | chair, client admins (system: client admins) | review: 14 days before and on `plannedOn`; system: on the day a standard of the system becomes overdue per `managementReviewDue`, then every 30 days while it stays overdue |
| ISO_EFFECTIVENESS_DUE | Nonconformity | approver | on `effectivenessDueOn` |

No reminder for a DONE, CANCELLED, CLOSED, OBSOLETE or SUPERSEDED subject. Accounts without the feature, or whose
catalogue copy is not recorded yet, get none.

## 8. Audit trail

Every ISO state change, create, field edit, reassignment, due-date change, file add or remove, NA request and
decision, climate decision, significance override and list change (units, people, linked records) writes an
`AuditEvent` in the same transaction, with the entity types below. Join-table rows (units, people, linked records)
and rows without an entity type of their own (review inputs and outputs, incident fields) are written as an UPDATE on
the record that owns them (for example, an attendee added is an UPDATE on `management_review`); document revisions,
risk controls, objective readings, checklist items, findings and actions are audited under their own entity type.
No personal data from incidents in `before`/`after` (§3.11).

ISO entity types (v2; replaces the list staged in contracts 1.7.0, ISO-1 updates `ISO_ENTITY_TYPES` before anything
stages it):

`management_system`, `certification`, `external_audit`, `context_item`, `clause_assessment`, `controlled_document`,
`document_revision`, `risk_item`, `risk_control`, `objective`, `objective_reading`, `audit_programme`,
`internal_audit`, `audit_checklist_item`, `audit_finding`, `nonconformity`, `iso_action`, `management_review`.

Against 1.7.0: `corrective_action` and `review_action` are gone (one `iso_action`), and `external_audit`,
`risk_control` and `audit_checklist_item` are new. ISO files are audited on their subject, so there is no `iso_file`
type. The catalogue copy writes a CREATE audit row (actor SYSTEM) per STANDARD act, category and obligation, as the
master library copy does (ADR M6-0001 decision 4); catalogue table rows are reference data and are not audited.

The RECORD_HELD TRANSITION event on `management_review` carries two more entries in `after`: `figures`, one entry per
stored input (`{ key, source, since, asOf, values: { <figure key>: <value> } }`), and `engineVersion`. It carries no
ids; those stay on the input row, which never changes. Storing the figures writes no event of its own.

The UPDATE that clears a risk item's residual rating when a treatment action completes (§3.5) is one event on
`risk_item` whose `after` carries the action's `sourceActionId`; the review figures do not count it as a re-rating
(§5.4).

Three more events place records in the figures (§5.4). Closing an objective (`POST .../objectives/{id}/close`) writes
one TRANSITION on `objective` whose `after.action` is `CLOSE`. The climate route alone writes the climate fields (the
system's PATCH takes none of them), as one UPDATE on `management_system` whose `after` names the fields it changed.
Changing an external audit's `endOn` while it is HELD or RESPONDED writes an UPDATE on `external_audit` whose `after`
names `endOn`; a `responseDueOn` moved in the same PATCH is its own DUE_DATE_CHANGE, as the mock's `editAudit` writes
it.

## 9. Exports and the client archive

- New export kinds, staged in the database first: `ISO_NC_LOG_XLSX`, `ISO_RISK_REGISTER_XLSX`,
  `ISO_AUDIT_REPORT_PDF`, `ISO_REVIEW_PACK_PDF`, created through `POST /clients/{clientId}/exports`. `ExportCreateBody`
  checks their filters against the ISO list queries, not `RegisterFilterQuery`.
- The risk register export prints the significance rule (threshold, legal-link rule) as the documented significance
  criteria (14001 6.1.2). The audit report PDF prints the independence note. The review pack prints each input with its
  notes and, where its definition names a source, its figures (§3.13), then each output with its decision, then the
  actions. A HELD or CLOSED review's figures are the stored copy, headed "Figures for <since> to <asOf>, recorded
  <figuresStoredAt in the client's time zone> (engine <figuresEngineVersion>)"; a PLANNED review's are computed when the
  pack is made, headed "Draft: figures for <since> to <today>"; a HELD or CLOSED review without stored figures (§3.13
  item 1) is headed "No figures: held before the system was set up in the app"; a CANCELLED review has none; an
  INCIDENTS row withheld from the requester (§3.13 item 4) is headed "Figures and notes withheld: they count incidents
  you may not open". Values print as stored, and record references print only for ids the requester may read (ISO-2h's
  `isoVisibleIds`, with the requester's unit scope and person when the job runs).
- Exports never print an injured person's details (§3.11). Unit scope applies to every export (plan §3.3), with the
  review figures' exception there.
- The client archive (`CLIENT_ARCHIVE_ZIP`, which is the account export, one client at a time) always includes ISO data,
  with the add-on on or off: an `iso/` folder with the NC log and risk register workbooks and a register of the other
  ISO records (each management review with each input's notes and, when HELD or CLOSED, its stored figures: the window
  (`since`, `asOf`), `figuresStoredAt`, `figuresEngineVersion`, and each figure's key, value and ids, in full, since
  only an account admin makes the archive; the archive computes none), and clean ISO files under
  `iso/<subjectType>/<subjectId>/<file name>`, listed in `index.csv`; withheld (not clean) files are counted in the
  README as for evidence (ADR M10-0002 decisions 5-6).

## 10. Routes (M16 unless noted; ISO-1 writes the exact list in `docs/contracts/endpoints.md`)

All under `/api/v1/clients/{clientId}/iso/...`, paged and filtered per `api-conventions.md`, unit-scoped (plan §3.3):
`systems` (and `/{id}/context`, `/{id}/climate`, `/{id}/checklist`, `/{id}/checklist/{rowId}/na-request|na-approve|
na-reject|na-withdraw`), `catalogue/standards`, `catalogue/clauses`, `catalogue/review-defs` (reads), `documents` (and
`/{id}/revisions`, `/{id}/review`, `/{id}/obsolete`, revision `submit|approve|send-back`), `risks` (and `/{id}/controls`,
`/{id}/review`, `/{id}/significance`), `objectives` (and `/{id}/readings`), `actions` (filter by subject type and id,
owner, state; `complete|cancel|reopen`), `audit-programmes`, `internal-audits` (and `/{id}/checklist`, `/{id}/findings`,
`start|report|close|cancel`), `external-audits` (and findings, `held|response|close|cancel`), `certifications`,
`nonconformities` (and the §4.1 actions and `/{id}/reassign`), `management-reviews` (and `/{id}/replan`, inputs, each
input row returned with its `sourceFigures` (stored for HELD and CLOSED, computed by `reviewInputFigures` (§5.4)
for PLANNED, null for CANCELLED and `MANUAL` rows), `figuresStoredAt` and `figuresWithheld` (§3.13), outputs,
`held|close|cancel`), `files`
(§6), `overview` (the ISO overview KPIs, every number with the ids behind it; its overdue nonconformities are the open
ones whose `nonconformityStatus` (§5.2) is OVERDUE on as-of, the NC list's `overdue` test, contracts 1.8.6; M16's,
ISO-8c). The ISO exports go through M10's `/clients/{clientId}/exports`.

Every route takes exactly one `can()` action (plan §3.2, ISO-1a). The catalogue and overview reads use
`isoSystem.read` (plan §3.2), since neither has a resource of its own. Views of records with a machine (§4, and
`IsoAction` in §3.12) carry `allowedActions`, the steps the caller may take now, as `InstanceDetail` does, so screens
show only those steps and never work them out (contracts README decision 51 i, j). Where this model is silent, the M0
mock's readings are in `docs/contracts/iso-mock.md`; M4, M16 and M17 keep them or record another choice in their ADR
(packages.md, shared rules).

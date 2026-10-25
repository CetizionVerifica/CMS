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
5. **People.** Every person reference (owner, approver, NA approver, lead auditor, auditor, auditee, reported-to,
   chair, attendee, investigator, reporter, disposition authoriser) must hold a live role in the record's client, and
   cover the record's unit when it has one, as `checkAssignee` does for instances
   (`apps/api/src/modules/instances/service.ts`). M16 checks this on every create and update and answers `400
   VALIDATION` otherwise. Jobs send ISO mail only through `recipients(personIds, clientId)`, which drops non-members.
6. **Versions.** Every ISO record that a route updates has `version` and takes optimistic concurrency like instances
   (`409 STALE_VERSION`).
7. **Stored engine results.** `RiskItem.rating`, `residualRating` and `significant` are stored when the item is
   written, from the engine's result, so lists can filter on them. The significance rule is not editable in v1
   (§5.1), so no recompute job exists. Nothing else derived is stored.
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
- An INCIDENT or NEAR_MISS NC always has a `unitId`, so unit scope applies to it.
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
                    review's standards; a key shared by several standards appears once)
ReviewOutput        managementReviewId, outputDefId, decision        (one row per IsoReviewOutputDef key, likewise)
```
Inputs with no data in the app (customer satisfaction, external provider performance and the other `MANUAL`
sources) are written by hand. Review decisions that need work become review actions (§3.12) with `outputKey`.

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
| PLANNED | RECORD_HELD | chair, client admin | `heldOn` not in the future, attendees, notes on every input row | HELD |
| HELD | CLOSE | chair, client admin | a decision on every output row; every review action DONE or CANCELLED | CLOSED |

A review's standards, `plannedOn` and chair change only while it is PLANNED, through the
`POST .../management-reviews/{id}/replan` route under `isoReview.plan` (ISO-1a); a new `plannedOn` or chair needs a
reason (§1.9). The review's PATCH (attendees, minutes) is `isoReview.write`, which its chair holds.

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
`reviewInputFigures(source, data, since, asOf)` returns the figures for one input source, each number with the ids
behind it. `since` is `heldOn` of the last HELD or CLOSED review covering the input's standards, or else `system.createdOn`, the
system's `createdAt` as a `LocalDate` in the client's time zone, which the caller (M16, M9, M10) passes using the
engine's date helper. By source:
- PREVIOUS_ACTIONS: actions of earlier reviews by state, and those overdue.
- CONTEXT: context items added or changed, and the climate decision.
- RISKS: risk items added or re-rated, significant items by kind, treatment actions done and open.
- OBJECTIVES: `objectiveProgress` of each objective.
- NONCONFORMITIES: NCs raised and closed by source and severity, VERIFY_NOT_EFFECTIVE counts, overdue corrective
  actions.
- INCIDENTS: `incidentCounts`.
- AUDIT_RESULTS: internal audits REPORTED and external audits HELD, findings by type.
- COMPLIANCE_EVALUATION: the latest `COMPLIANCE-EVALUATION` activity instance, and the STATUTE-only `computeScore` for
  the period.
- MANUAL: none.

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
- The port, so ISO-15 and ISO-8a can build against it in either order (`IsoSubject` is `{ type, id }` with the
  subject types above; `tx` is the request's tenant transaction):
  ```ts
  interface IsoFiles {
    uploadUrl(tx, subject: IsoSubject, file: { fileName; mimeType; sizeBytes }): Promise<{ uploadId; url; expiresAt }>;
    confirm(tx, subject: IsoSubject, upload: { uploadId; fileName; sha256 }): Promise<IsoFileView>; // PENDING
    list(tx, subject: IsoSubject): Promise<IsoFileView[]>;
    downloadUrl(tx, fileId: Id): Promise<{ url; expiresAt }>; // CLEAN only, audited
    remove(tx, fileId: Id, reason: string): Promise<void>;    // archives, audited
  }
  ```
  ISO-1 may type the arguments more exactly; ISO-8a copies the result into `apps/api/src/modules/iso/ports.ts`.
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

## 9. Exports and the client archive

- New export kinds, staged in the database first: `ISO_NC_LOG_XLSX`, `ISO_RISK_REGISTER_XLSX`,
  `ISO_AUDIT_REPORT_PDF`, `ISO_REVIEW_PACK_PDF`, created through `POST /clients/{clientId}/exports`. `ExportCreateBody`
  checks their filters against the ISO list queries, not `RegisterFilterQuery`.
- The risk register export prints the significance rule (threshold, legal-link rule) as the documented significance
  criteria (14001 6.1.2). The audit report PDF prints the independence note. The review pack prints each input with
  its notes and, where its definition names a source, that source's figures from `reviewInputFigures` (§5.4), then
  each output with its decision, then the actions.
- Exports never print an injured person's details (§3.11). Unit scope applies to every export (plan §3.3).
- The client archive (`CLIENT_ARCHIVE_ZIP`, which is the account export, one client at a time) always includes ISO
  data, with the add-on on or off: an `iso/` folder with the NC log and risk register workbooks and a register of
  the other ISO records, and clean ISO files under `iso/<subjectType>/<subjectId>/<file name>`, listed in
  `index.csv`; withheld (not clean) files are counted in the README as for evidence (ADR M10-0002 decisions 5-6).

## 10. Routes (M16 unless noted; ISO-1 writes the exact list in `docs/contracts/endpoints.md`)

All under `/api/v1/clients/{clientId}/iso/...`, paged and filtered per `api-conventions.md`, unit-scoped (plan §3.3):
`systems` (and `/{id}/context`, `/{id}/climate`, `/{id}/checklist`, `/{id}/checklist/{rowId}/na-request|na-approve|
na-reject|na-withdraw`), `catalogue/standards`, `catalogue/clauses`, `catalogue/review-defs` (reads), `documents` (and
`/{id}/revisions`, `/{id}/review`, `/{id}/obsolete`, revision `submit|approve|send-back`), `risks` (and `/{id}/controls`,
`/{id}/review`, `/{id}/significance`), `objectives` (and `/{id}/readings`), `actions` (filter by subject type and id,
owner, state; `complete|cancel|reopen`), `audit-programmes`, `internal-audits` (and `/{id}/checklist`, `/{id}/findings`,
`start|report|close|cancel`), `external-audits` (and findings, `held|response|close|cancel`), `certifications`,
`nonconformities` (and the §4.1 actions and `/{id}/reassign`), `management-reviews` (and `/{id}/replan`, inputs, each
input row returned with its `sourceFigures` from `reviewInputFigures` (§5.4), outputs, `held|close|cancel`), `files`
(§6), `overview` (the ISO overview KPIs, every number with the ids behind it; M16's, ISO-8c). The ISO exports go
through M10's `/clients/{clientId}/exports`.

Every route takes exactly one `can()` action (plan §3.2, ISO-1a). The catalogue and overview reads use
`isoSystem.read` (plan §3.2), since neither has a resource of its own. Views of records with a machine (§4, and
`IsoAction` in §3.12) carry `allowedActions`, the steps the caller may take now, as `InstanceDetail` does, so screens
show only those steps and never work them out (contracts README decision 51 i, j). Where this model is silent, the M0
mock's readings are in `docs/contracts/iso-mock.md`; M4, M16 and M17 keep them or record another choice in their ADR
(packages.md, shared rules).

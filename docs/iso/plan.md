# ISO management systems add-on: plan

Status: planned 2026-10-25, decisions in [ADR M16-0001](../adr/M16-0001-iso-management-systems.md). Module briefs: `MODULES.md`
"ISO add-on". This file is the brief every ISO thread reads after the root `CLAUDE.md`.

## 1. What it is

An optional add-on for companies that run, or are working towards, certified management systems:

| Standard | Edition in v1 | Topic |
|---|---|---|
| ISO 9001 | 2015 + Amd 1:2024 | Quality |
| ISO 14001 | 2015 + Amd 1:2024 | Environment |
| ISO 45001 | 2018 + Amd 1:2024 | Occupational health and safety |

All three follow the same high-level structure (clauses 4 to 10), so one client can run them as one **integrated
management system** (IMS): one internal audit, one management review and one nonconformity log cover every standard
the client has chosen. Editions are data. A newer edition (revisions of 9001 and 14001 are expected around 2026; check
before seeding) is added as a new catalogue edition, and a system moves to it with a gap check, without a code change.

The add-on is off by default. The platform operator turns it on or off per account in the operator console
(§6). Statutory compliance does not change for accounts without it.

## 2. What the app already covers, and what this adds

Already covered by v1 (no change): the legal register, which is 14001 §6.1.3 and 45001 §6.1.3 (compliance obligations),
and the evaluation of compliance in 14001 §9.1.2 and 45001 §9.1.2 (the statutory compliance score and evidence).

| Clause area | Feature | v1 of the add-on |
|---|---|---|
| 4.1-4.4 Context, interested parties, scope | **Management system** record: standards, scope statement, units covered, issues and interested parties lists, certification details | yes |
| All clauses | **Clause checklist** (gap analysis): one row per clause per standard, status, owner, evidence, notes; readiness score | yes |
| 5.2 Policy, 7.5 Documented information | **Document control**: register of controlled documents with code, version, approval, review date, file, revision history | yes |
| 6.1 Risks and opportunities, 14001 6.1.2 aspects, 45001 6.1.2 hazards | **Risk registers**: one register with four kinds (risk, opportunity, environmental aspect, OH&S hazard), likelihood × severity, controls, residual rating, review date, link to legal obligations | yes |
| 6.2 Objectives | **Objectives** with target, KPI, measurement frequency, readings and progress | yes |
| 7.1.5, 7.2, 8.2, 9.1, 45001 5.4 and others | **Recurring ISO activities** (calibration, competence review, emergency drill, worker consultation, monitoring, evaluation of compliance) run through the existing obligation, instance, reminder and evidence workflow | yes |
| 9.2 Internal audit | **Audit programme** per year, **internal audits** with plan, auditors, clauses and units, checklist, **findings** | yes |
| 9.3 Management review | **Management review** meetings with the required inputs per standard, attendees, minutes, decisions, actions | yes |
| 10.2 Nonconformity and corrective action, 45001 incidents | **Nonconformity log** with **corrective actions** (CAPA): source, containment, root cause, actions, effectiveness check, closure; incidents and near misses are a nonconformity source | yes |
| External certification audits | Certification body, certificate number, cycle dates (stage 1/2, surveillance 1 and 2, recertification), external findings feed the nonconformity log | yes |
| Dashboards and reports | ISO overview per client, IMS readiness, NC ageing, CAPA overdue, audit programme progress, certificate expiry; NC log and risk register Excel, audit report and management review pack PDF | yes |
| Later | Excel import of existing NC logs, HIRA and aspect registers; supplier evaluation (9001 8.4); customer complaints portal; ISO 27001, 50001 and other standards; training records | no |

## 3. Domain model (M0 writes the exact shapes)

Every table below holds client data: it has `firm_id`, `client_id`, RLS, an isolation test, and it is purged with the
account (`platform_purge_account` must list it). Names follow the root vocabulary; the ISO-specific words are new.

```
IsoStandard         code (ISO_9001 | ISO_14001 | ISO_45001), edition, title           -- catalogue, platform data, read-only
IsoClause           standard, edition, number ("6.1.2"), title, summary (our words), parent, annexSlKey   -- catalogue
ManagementSystem    clientId, name, standards[] (code + edition), scopeStatement, unitIds[], status (PLANNING | IMPLEMENTING | CERTIFIED | SUSPENDED | WITHDRAWN)
Certification       managementSystemId, standard, body, certificateNumber, issuedOn, expiresOn, cycle dates
ContextItem         managementSystemId, kind (INTERNAL_ISSUE | EXTERNAL_ISSUE | INTERESTED_PARTY), text, needs, reviewedOn
ClauseAssessment    managementSystemId, clauseId, status (NOT_STARTED | PARTIAL | IMPLEMENTED | NOT_APPLICABLE), justification, ownerId, notes, lastReviewedOn
ControlledDocument  managementSystemId, code, title, type (POLICY | MANUAL | PROCEDURE | WORK_INSTRUCTION | FORM | RECORD | EXTERNAL),
                    clauseIds[], currentRevision, state (DRAFT | IN_REVIEW | APPROVED | OBSOLETE), ownerId, approverId, reviewDueOn
DocumentRevision    documentId, revision, changeNote, fileId, approvedById, approvedAt
RiskItem            managementSystemId, kind (RISK | OPPORTUNITY | ASPECT | HAZARD), unitId, activity, description,
                    condition (NORMAL | ABNORMAL | EMERGENCY, aspects and hazards), likelihood 1-5, severity 1-5, controls,
                    residual likelihood and severity, rating (engine), significant (engine), obligationIds[], ownerId, reviewDueOn
Objective           managementSystemId, standard, text, target, unit of measure, baseline, direction, recurrenceRule, ownerId, dueOn
ObjectiveReading    objectiveId, periodStart, periodEnd, value, note
AuditProgramme      managementSystemId, year (FY), notes
InternalAudit       programmeId, title, plannedStart, plannedEnd, clauseIds[], unitIds[], leadAuditorId, auditorIds[], auditeeIds[],
                    state (PLANNED | IN_PROGRESS | REPORTED | CLOSED), summary
AuditFinding        auditId (internal) or certificationId (external), type (MAJOR_NC | MINOR_NC | OBSERVATION | OFI | GOOD_PRACTICE),
                    clauseIds[], description, nonconformityId (set when it raises one)
Nonconformity       managementSystemId, number (per client), source (INTERNAL_AUDIT | EXTERNAL_AUDIT | INCIDENT | NEAR_MISS |
                    COMPLAINT | PROCESS | LEGAL | OTHER), severity (MAJOR | MINOR), standards[], clauseIds[], unitId, description,
                    containment, rootCauseMethod (FIVE_WHYS | FISHBONE | OTHER), rootCause, state, ownerId, approverId,
                    dueOn, closedOn, effective (bool | null)
CorrectiveAction    nonconformityId, text, ownerId, dueOn, doneOn, state (OPEN | DONE | CANCELLED)
ManagementReview    managementSystemId, heldOn, chairId, attendeeIds[], inputs (one row per required input, with notes), minutes,
                    state (PLANNED | HELD | CLOSED)
ReviewAction        reviewId, text, ownerId, dueOn, doneOn, state
```

Nonconformity states (maker-checker like instances; M4 owns the transition table, M16 enforces it):

| From | Action | Who | To |
|---|---|---|---|
| OPEN | ADD_ROOT_CAUSE (needs containment + root cause) | owner | ROOT_CAUSE_FOUND |
| ROOT_CAUSE_FOUND | PLAN_ACTIONS (at least one action) | owner | ACTIONS_PLANNED |
| ACTIONS_PLANNED | SUBMIT (every action DONE or CANCELLED) | owner | AWAITING_VERIFICATION |
| AWAITING_VERIFICATION | VERIFY_EFFECTIVE | approver | CLOSED |
| AWAITING_VERIFICATION | VERIFY_NOT_EFFECTIVE (reason) | approver | ACTIONS_PLANNED |
| any but CLOSED | CANCEL (reason) | approver, client admin | CANCELLED |
| CLOSED | REOPEN (reason) | client admin | ACTIONS_PLANNED |

Controlled documents: DRAFT → IN_REVIEW (owner submits a revision with a file) → APPROVED (approver) or back to DRAFT
(approver sends back, reason); APPROVED → DRAFT starts the next revision, and the approved one stays current until the
new one is approved; any → OBSOLETE (approver, reason). Internal audits: PLANNED → IN_PROGRESS → REPORTED (summary and
findings) → CLOSED (every NC it raised has left OPEN).

**Recurring ISO activities reuse the statutory workflow.** `Act` gets `kind: STATUTE | STANDARD`. The ISO catalogue ships
three STANDARD acts (one per standard) whose obligations are the recurring activities, each with a recurrence rule and
the clause numbers it serves. They are assigned to units, generate instances, remind, take evidence and go through
maker-checker exactly like laws. They carry the existing `Obligation` shape plus `clauseRefs`.

**Files.** ISO files (document revisions, NC evidence, audit reports, review minutes) use the existing evidence store:
the same presigned upload, virus scan, `CLEAN`-only download, 5-minute signed URLs and personal-data rules. `evidence`
gets a nullable ISO subject (`isoSubjectType`, `isoSubjectId`) beside `instanceId`, with a check that exactly one is set
(an M3 migration on an existing table, in its own PR).

**Audit trail.** Every ISO state change, reassignment, due-date change, file add or remove, and NA decision on a clause
writes an `AuditEvent` in the same transaction; M0 adds the ISO entity types to `AuditEvent.entityType`.

**Engine (M4).** Pure functions with explicit-date tests: `riskRating(likelihood, severity, matrix)` and `isSignificant`
(firm setting: default 5×5 matrix, significant at 12 or more), `clauseReadiness(assessments)` (IMPLEMENTED 1, PARTIAL 0.5,
NOT_APPLICABLE excluded; per standard and for the IMS), `nonconformityStatus(nc, asOf)` and `actionStatus` (on time, due
soon, overdue, with overdue days), `objectiveProgress(readings, target, direction)`, `certificationCycle(issuedOn)`
(surveillance 1 and 2 due dates, recertification due before expiry), the NC and document transition tables, and ISO
reminders in `planNotifications`. The statutory compliance score never counts STANDARD acts; ISO has its own scores.

## 4. Roles (no new roles)

| Role | In the add-on |
|---|---|
| Account admin, consultant | Everything for the clients they can see, including setting up management systems |
| Client admin | Management representative: sets up the system, plans audits and reviews, cancels or reopens NCs |
| Approver | Approves documents, verifies NC effectiveness, approves activity instances |
| Owner | Does what is assigned: checklist rows, actions, documents as author, risk items, objectives readings |
| Viewer | Reads everything in the add-on (external auditors, time-boxed as today) |

Internal auditors are people named on an audit (owner role or above). The API warns, but allows, when an auditor is
also an auditee of the same audit (independence, 9.2.2). M5 adds `iso.*` actions to `can()`.

## 5. API, web, jobs, reports

- **API (M16)**, under `/clients/{clientId}/iso/...`: management systems, catalogue reads, checklist, context, documents
  and revisions, risk items, objectives and readings, audit programmes, audits and findings, nonconformities and actions,
  management reviews and actions, certifications. Every write is audited, every route checks the feature (§6), every
  list paginates and filters as `api-conventions.md` says.
- **Web (M17)**, under `/c/[clientId]/iso`: overview, checklist, documents, risks (tabs per kind), objectives, audits,
  nonconformities, management reviews, certification. Built against the M0 mock first, like M12 and M13. Same Canopy
  components; status pills use the status language; light mode at 1280 and 375, keyboard-only, axe-clean.
- **Shell (M11)**: an "ISO" sidebar group shown only when the account has the feature; a direct URL with the feature off
  shows "ISO management systems is not turned on for your account" with no data.
- **Jobs (M9)**: reminders and escalations for corrective actions, review actions, documents due for review, risk items
  due for review, audits starting, certificates expiring (90, 30, 7 days) and surveillance audits due; ISO activity
  instances generate like any assignment. Accounts without the feature get none of these.
- **Reports (M10)**: ISO overview KPIs (every number links to its filtered list), NC log and risk register Excel export,
  internal audit report PDF, management review pack PDF; the statutory dashboards exclude STANDARD acts.
- **Register (M7, M10)**: register, calendar and approvals show ISO activity instances with a Source filter (Law, ISO) when
  the feature is on, and hide them when it is off.
- **Library (M6)**: the ISO catalogue (standards, clauses with our own summaries, the three STANDARD acts and their
  activities) ships as code, like the master library, and is copied into an account when the feature is first turned on.

## 6. Turning the add-on on and off

- Feature flag `isoManagement`, an entry in a new `KNOWN_FEATURES` list in contracts (code, label, description), so the
  console shows add-ons by name instead of free text.
- **Operator console (M15)**: the account page gets an **Add-ons** card with one switch per known feature. A switch
  writes the account override (`PUT /accounts/{id}/override`) with a required reason, and the change is an
  `OVERRIDE_CHANGE` operator audit event mirrored into the account's audit trail. `AccountOverride` gains
  `removedFeatures` so a switch can turn a feature off for one account even when its plan includes it:
  entitlements = (plan features ∪ override features) − removed features.
- **Customer side**: `Me.account.features` lists the account's features; the Account page (M13) shows the add-on as On
  or Off; nobody in the account can change it.
- **When it is on**: the ISO catalogue is copied into the account the first time (idempotent), the sidebar group
  appears, the API and jobs serve it.
- **When it is off**: every `/iso` route answers `403 FEATURE_NOT_ENABLED` (reads too); ISO screens and the sidebar group
  are hidden; ISO jobs skip the account; ISO activity instances are not generated and are hidden from the register,
  calendar, approvals and dashboards. **Nothing is deleted**: turning it back on brings everything back as it was. The
  account export (M13 "Download your data", M10 client archive) always includes ISO data, so a customer never loses it.
- Plans: no plan includes `isoManagement` by default; the operator can add it to a plan later (plan features are data).

## 7. Work packages and waves

New modules: **M16 ISO API** (`apps/api/src/modules/iso/`, `docs/iso/`) and **M17 ISO web**
(`apps/web/app/(shell)/c/[clientId]/iso/`, `e2e/tests/iso/`). Work in other modules' paths is done by a thread briefed
as that module, titled `M<n>: ISO ...`, so the path guard and audit apply as usual.

| Wave | Package | Module | Delivers | Needs |
|---|---|---|---|---|
| I0 | ISO-0 | M0 | Feature contracts: `KNOWN_FEATURES`, `removedFeatures`, `Me.account.features`, `FEATURE_NOT_ENABLED`, `Act.kind`, `Obligation.clauseRefs`, ISO audit entity types | this plan merged |
| I0 | ISO-1 | M0 | ISO contracts: §3 schemas, endpoints with role permissions, events, fixtures (fictional Kestrel data), mock handlers | ISO-0 |
| I1 | ISO-2 | M3 | Migrations: `removedFeatures`, `act.kind`, ISO tables with RLS and isolation tests, evidence ISO subject (own PR), purge list, repositories | ISO-1 |
| I1 | ISO-3 | M4 | Engine functions and transition tables in §3, unit tests with explicit dates, 100% on score and status files | ISO-1 |
| I1 | ISO-4 | M5 | `requireFeature()` in the request context, `iso.*` actions in `can()`, `Me.account.features` | ISO-0 |
| I1 | ISO-5 | M15 | Add-ons card with switches, `removedFeatures` in the console and the override API | ISO-0, ISO-2 (`removedFeatures` column) |
| I1 | ISO-6 | M17 | ISO screens against the mock, e2e against the mock | ISO-1 |
| I1 | ISO-7 | M11 | Sidebar group and "not turned on" page from `Me.account.features` | ISO-0 |
| I2 | ISO-8 | M16 | ISO API (§5), feature guard on every route, audit per write, role tests | ISO-2, ISO-3, ISO-4 |
| I2 | ISO-9 | M6 | ISO catalogue as code, copy on first turn-on, STANDARD acts | ISO-2 |
| I2 | ISO-10 | M9 | ISO reminders, skip accounts without the feature, catalogue copy job | ISO-2, ISO-3 |
| I2 | ISO-11 | M7 + M10 | Source filter and hiding when off; statutory score excludes STANDARD; ISO overview, exports, PDFs | ISO-2, ISO-3 |
| I2 | ISO-12 | M13 | Account page shows add-ons | ISO-0 |
| I3 | ISO-13 | M14 | Integrated journey: operator turns the add-on on, client runs an audit, raises an NC, closes it; turns it off and checks every route and screen | all above |
| I3 | ISO-14 | wiring | `server.ts` route registration, job registration, web API client switch from mock to real | ISO-8, ISO-10 |

Up to five threads at once, as for the main build. ISO packages for M5, M9 and M10 start only after the launch-hardening
thread's own PR for that module has merged, so the two never edit the same module at once.

## 8. Acceptance (the auditor checks these per package)

1. Tenant isolation test for every new table; purge removes every ISO row of a deleted account.
2. Every ISO state change writes an `AuditEvent` in the same transaction (the M7 route test covers ISO routes).
3. With the feature off, every ISO route answers 403 `FEATURE_NOT_ENABLED`, no ISO job runs for the account, ISO
   instances are hidden; with it back on, all data is unchanged.
4. Engine coverage 95%, 100% on ISO score and status files; risk rating and readiness tests with explicit values.
5. No ISO standard text in the repo: clause numbers and titles, with summaries in our own words.
6. Fictional names only in fixtures, tests and demos.
7. New screens checked in light mode at 1280 and 375, keyboard-only, axe-clean.
8. Statutory scores and golden counts unchanged for an account without the add-on.

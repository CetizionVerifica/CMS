# Domain model: types and enums (contracts v1)

Owner: M0. Consumers: every module. Shapes are written in TypeScript notation here; the Zod schemas in
`packages/contracts/src` implement them and are the source of truth (`import { ComplianceInstance } from '@canopy/contracts'`).
Field names here are the API (camelCase) names; `packages/db` uses the snake_case equivalents.

## 1. Primitives

```ts
type Id = string            // UUIDv7, lower-case, generated server-side. Fixtures use fixed UUIDs (see fixtures.md).
type LocalDate = string     // "YYYY-MM-DD", calendar date, no time zone. Due dates, completion dates, periods.
type Instant = string       // ISO 8601 UTC with "Z", e.g. "2026-10-11T09:17:43Z". Event and audit times.
type MonthDay = { month: 1-12; day: 1-31 }
type FyLabel = string       // "2022-23": FY starting in 2022 per the client's fyStartMonth.
type Money = never          // not in v1

interface Base {            // every persisted entity
  id: Id
  firmId: Id                // tenant; never accepted from request bodies
  createdAt: Instant
  updatedAt: Instant
  archivedAt: Instant | null  // soft delete; no hard deletes
}
interface Versioned { version: number }  // optimistic concurrency, starts at 1, +1 per write
```

Rules: no `any`; unknown keys rejected at the edge; strings trimmed; empty string is not a valid value (use `null`).

## 2. Enums

| Enum | Values | Notes |
|---|---|---|
| `Role` | `FIRM_ADMIN`, `CONSULTANT`, `CLIENT_ADMIN`, `APPROVER`, `OWNER`, `VIEWER` | Firm roles: first two. Client roles: the rest. |
| `PersonStatus` | `UNCLAIMED`, `INVITED`, `ACTIVE`, `DISABLED` | People created by import are `UNCLAIMED` (no email). A person with an email on file but not yet signed in is `INVITED`; adding an email to an UNCLAIMED person makes them INVITED, and removing it makes them UNCLAIMED again. |
| `Criticality` | `SUPER_CRITICAL`, `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` | Default weights 5/4/3/2/1 (firm setting). |
| `TimelineType` | `TIME_BASED`, `ONGOING` | Excel "Time Based" / "On Going". |
| `ObligationDomain` | `HRS`, `EHS`, `TAX`, `IT`, `INT`, `ENG`, `ENV`, `OTHER` | Parsed from `externalRef` prefix; `OTHER` when unknown. |
| `Jurisdiction` | `CENTRAL`, `STATE` | `STATE` requires `stateCode`. Excel `CL` → CENTRAL, `WB` → STATE/WB. |
| `ActKind` | `STATUTE`, `STANDARD` | On Act (§4). `STANDARD`: an ISO management-system standard (ADR M16-0001); statutory scores never count it. |
| `ActivitySource` | `LAW`, `ISO` | Which acts a register, queue, vault or calendar shows: `LAW` = STATUTE acts, `ISO` = STANDARD acts; absent = both (`docs/iso/plan.md` §4.6). |
| `IsoStandardCode` | `ISO_9001`, `ISO_14001`, `ISO_45001` | The standards the ISO add-on covers (§10). Editions are data (`IsoStandard.edition`). |
| `Applicability` | `APPLICABLE`, `NOT_APPLICABLE`, `TO_ASSESS` | On Assignment. `NOT_APPLICABLE` requires `naReason`. |
| `WorkflowState` | `OPEN`, `SUBMITTED`, `SENT_BACK`, `APPROVED`, `NOT_APPLICABLE` | Stored on the instance. |
| `SubmissionKind` | `COMPLETION`, `NA` | What a `SUBMITTED` instance is waiting to be approved as. |
| `DerivedStatus` | `UPCOMING`, `DUE_SOON`, `OVERDUE`, `SUBMITTED`, `COMPLIED`, `COMPLIED_LATE`, `NOT_APPLICABLE` | Computed by `engine.deriveStatus`, never stored as truth. |
| `RuleStatus` | `CONFIRMED`, `TO_REVIEW` | Recurrence rule confidence (import infers, consultant confirms). |
| `ScanStatus` | `PENDING`, `CLEAN`, `INFECTED`, `FAILED` | Evidence is downloadable only when `CLEAN`. |
| `CommentKind` | `NOTE`, `SUBMIT`, `NA_REQUEST`, `APPROVE`, `SEND_BACK`, `REOPEN`, `IMPORT` | Transitions write a comment of their kind. |
| `AuditAction` | `CREATE`, `UPDATE`, `ARCHIVE`, `RESTORE`, `TRANSITION`, `REASSIGN`, `DUE_DATE_CHANGE`, `APPLICABILITY_CHANGE`, `EVIDENCE_ADD`, `EVIDENCE_REMOVE`, `EVIDENCE_DOWNLOAD`, `IMPORT`, `MERGE_ALIAS`, `MEMBERSHIP_CHANGE`, `LOGIN`, `EXPORT` | Append-only. |
| `HolidayPolicy` | `NONE`, `NEXT_WORKING_DAY`, `PREVIOUS_WORKING_DAY` | Default `NONE`. |
| `ImportBatchStatus` | `UPLOADED`, `MAPPED`, `PARSED`, `REVIEWED`, `DRY_RUN_READY`, `COMMITTING`, `COMMITTED`, `FAILED`, `CANCELLED` | Linear; see §6. |
| `ImportRowOutcome` | `PENDING`, `CREATE`, `UPDATE`, `UNCHANGED`, `SKIPPED`, `ERROR` | Set by dry run, confirmed by commit. |
| `ImportIssueType` | see §6 | |
| `IssueSeverity` | `INFO`, `WARNING`, `ERROR` | `ERROR` blocks the row; `WARNING` needs a decision; `INFO` is shown only. |
| `NotificationKind` | `OWNER_REMINDER`, `APPROVER_ESCALATION`, `CONSULTANT_DIGEST`, `INVITE`, `MAGIC_LINK`, `EXPORT_READY`, `APPROVAL_REQUESTED`, `SENT_BACK`, `TRIAL_ENDING`, `RENEWAL_DUE`, `MFA_ENROLLED` | `TRIAL_ENDING` goes to a TRIAL account's admins 7 days and 1 day before the trial ends; `RENEWAL_DUE` to an ACTIVE account's admins 30 and 7 days before its latest subscription ends; `MFA_ENROLLED` to a person when MFA is set up on their account. ISO reminder kinds are staged apart (`ISO_NOTIFICATION_KINDS`, §10). |
| `ExportKind` | `REGISTER_XLSX`, `CERTIFICATE_PDF`, `ACT_REPORT_XLSX`, `DEPARTMENT_REPORT_XLSX`, `OVERDUE_REPORT_XLSX`, `CLIENT_ARCHIVE_ZIP` | `CLIENT_ARCHIVE_ZIP`: account admins only; the client's register and evidence. ISO export kinds are staged apart (`ISO_EXPORT_KINDS`, §10). |
| `JobStatus` | `QUEUED`, `RUNNING`, `DONE`, `FAILED` | Exports and imports. |
| `AccountKind` | `ENTERPRISE`, `CONSULTANCY` | §9. An enterprise account has one client. |
| `AccountStatus` | `PROVISIONING`, `TRIAL`, `ACTIVE`, `SUSPENDED`, `PENDING_DELETION`, `DELETED` | §9; moves in `ACCOUNT_TRANSITIONS`. |
| `PlanLimitKey` | `companies`, `units`, `users`, `storageBytes` | `PLAN_LIMIT_REACHED.details.limit`. |
| `SupportAccessLevel` | `READ_ONLY`, `ADMIN` | §9. |
| `SupportGrantStatus` | `ACTIVE`, `EXPIRED`, `REVOKED` | §9. |
| `OperatorAuditAction` | `OPERATOR_LOGIN`, `ACCOUNT_CREATE`, `OWNER_INVITE_SEND`, `ACCOUNT_ACTIVATE`, `ACCOUNT_SUSPEND`, `ACCOUNT_RESUME`, `TRIAL_CONVERT`, `TRIAL_EXTEND`, `ACCOUNT_UPDATE`, `PLAN_CHANGE`, `OVERRIDE_CHANGE`, `SUBSCRIPTION_RECORD`, `ACCOUNT_DELETE_REQUEST`, `ACCOUNT_DELETE_CANCEL`, `ACCOUNT_PURGE`, `SUPPORT_ACCESS_START`, `SUPPORT_ACCESS_END` | §9. Append-only. |

The ISO add-on's own enums (record kinds, machine states and actions) are in §10.

Excel to enum mapping (import, case-insensitive after trimming): Criticality "Super Critical" → `SUPER_CRITICAL`, "HIGH"/"High" → `HIGH`, etc.;
Status "Complied" → `APPROVED`, "Pending" → `OPEN`, "Not Applicable" → `NOT_APPLICABLE`.

## 3. Tenancy, entities and people

```ts
interface Firm extends Base, Versioned {           // the tenant; customers call it their "Account" (§9)
  name: string; settings: FirmSettings
  kind: AccountKind                                 // default CONSULTANCY
  status: AccountStatus                             // default ACTIVE
  planCode: string                                  // default "CONSULTANCY"
  trialEndsOn: LocalDate | null                     // default null
}
interface FirmSettings {
  criticalityWeights: Record<Criticality, number>   // default {SUPER_CRITICAL:5, CRITICAL:4, HIGH:3, MEDIUM:2, LOW:1}
  dueSoonDays: number                               // default 7
  mfaRequiredForFirmRoles: true                     // fixed true in v1
  isoRisk: IsoRiskRule                              // default {significantAt: 12, legalLinkMakesSignificant: true}; not editable in v1
}
interface IsoRiskRule {                             // when an ISO risk item is significant (§10, M4 isSignificant)
  significantAt: number                             // 1-25: a rating at or above it is significant
  legalLinkMakesSignificant: boolean                // a linked statutory obligation makes it significant
}

interface Client extends Base, Versioned {          // org group, e.g. "Kestrel Metals Group"
  name: string
  settings: ClientSettings
}
interface ClientSettings {
  fyStartMonth: number                              // 1-12, default 4 (April)
  timeZone: string                                  // IANA, default "Asia/Kolkata"
  holidayPolicy: HolidayPolicy                      // default NONE
  reminders: ReminderSettings
}
interface ReminderSettings {
  ownerDaysBefore: number[]                         // default [7, 3, 0]
  approverDaysAfter: number[]                       // default [1, 7]
  sendAtLocalTime: string                           // "07:00"
  consultantDigestWeekday: 1-7                      // default 1 (Monday)
}

interface Company extends Base, Versioned { clientId: Id; name: string }          // "Kestrel Aluminium"
interface Location extends Base { country: string; countryCode: string; state: string | null; stateCode: string | null; city: string | null }
interface Unit extends Base, Versioned {           // plant / site / office, e.g. "Plant"
  clientId: Id; companyId: Id; name: string; locationId: Id
}
interface Department extends Base, Versioned { clientId: Id; name: string; aliases: string[] }

interface Person extends Base, Versioned {
  displayName: string                               // title case for imported names
  nameNormalized: string                            // lower-case, whitespace collapsed; dedupe key per firm
  email: string | null                              // null while UNCLAIMED
  status: PersonStatus
  support?: boolean                                 // the account's PlanetPulse support person (§9); absent = false
}
interface Membership extends Base, Versioned {
  personId: Id
  role: Role
  clientId: Id | null                               // null for FIRM_ADMIN; required for client roles
  consultantClientIds: Id[] | null                  // CONSULTANT only: clients they may see
  unitIds: Id[] | null                              // OWNER/APPROVER scope; null = all units of the client
  expiresAt: Instant | null                         // required for VIEWER
}
```

`FirmSettings.isoRisk` (1.8.0) defaults on the field, so a firm stored without it still parses; a reader that does not
parse treats a missing value as `DEFAULT_ISO_RISK_RULE`, the same value as `DEFAULT_FIRM_SETTINGS.isoRisk`. The risk
register export prints it as the documented significance criteria.

Hierarchy paths in Excel ("Kestrel Metals Group/ Kestrel Aluminium/ Plant", "India/ West Bengal/ Kestrelganj") map to Client / Company / Unit and Country / State / City.

## 4. Library

```ts
interface Act extends Base, Versioned {
  name: string; shortName: string | null
  jurisdiction: Jurisdiction; stateCode: string | null
  aliases: string[]                                 // other spellings that resolve to this Act on import
  kind?: ActKind                                    // STATUTE | STANDARD (ADR M16-0001); missing = STATUTE until M3 stores it; STANDARD is CENTRAL
}
interface Category extends Base, Versioned { name: string; aliases: string[] }

interface Obligation extends Base, Versioned {
  externalRef: string | null                        // raw source ID, e.g. "TAX-CL-033-6067-60218"; data, not a key
  domain: ObligationDomain
  jurisdiction: Jurisdiction; stateCode: string | null
  actId: Id; categoryId: Id
  title: string                                     // not unique
  description: string                               // plain text with line breaks preserved
  applicabilityText: string | null
  criticality: Criticality
  timelineType: TimelineType
  recurrenceRule: RecurrenceRule
  ruleStatus: RuleStatus
  evidenceRequired: boolean                         // default false; true blocks submit without CLEAN evidence
  forms: TemplateRef[]
  logSheets: TemplateRef[]
  libraryVersion: number                            // bumped on every published change
  clauseRefs?: ClauseRef[]                          // the clauses a STANDARD act's activity serves; max 20; unique per standard and number; missing = []
}
interface ClauseRef { standard: IsoStandardCode; clauseNumber: ClauseNumber }   // { standard: "ISO_9001", clauseNumber: "7.1.5" }
interface TemplateRef { label: string; fileName: string | null; templateFileId: Id | null } // fileName set + templateFileId null = "file not attached"
```

`externalRef` parsing: `DOMAIN-JUR-...` when it has 5 dash-separated parts; otherwise (e.g. `ENV-117-0031`, `INT-FA-1-1`) domain from the
first part and jurisdiction from the Act, with an `UNPARSED_EXTERNAL_REF` INFO issue.

Recurring ISO activities (calibration, emergency drills, management review inputs) are obligations under a `STANDARD`
Act, one per standard, so instances, reminders, evidence and maker-checker work as for laws (ADR M16-0001 decision 4,
`docs/iso/plan.md` §3). `clauseRefs` names a standard and a clause number (`ClauseNumber`: one to four dot-separated
numbers), never a bare number, because 9001 8.2 and 14001 8.2 are different clauses; the standard's own text is never
stored. Contracts 1.7.0 typed it as bare numbers; 1.8.0 reshapes it (README decision 43). M3 already stores the
object form and, until ISO-2c, leaves the column out of reads and refuses a non-empty value on writes, so nothing
stored changes. `kind` and `clauseRefs` stay optional: a missing `kind` reads as STATUTE, a missing `clauseRefs` as
empty (plan §5.1).

### RecurrenceRule (owned by M4 semantics, shape fixed here)

```ts
type RecurrenceRule =
  | { kind: "ONE_TIME"; dueDate: LocalDate }
  | { kind: "MONTHLY"; day: number | "LAST"; offsetMonths: 0 | 1 }          // TDS: day 7, offsetMonths 1
  | { kind: "QUARTERLY"; anchor: "PERIOD_END" | "AFTER_PERIOD_END"; days: number }
  | { kind: "HALF_YEARLY"; anchor: "PERIOD_END" | "AFTER_PERIOD_END"; days: number }
  | { kind: "ANNUAL"; month: number; day: number }
  | { kind: "FIXED_DATES"; dates: MonthDay[] }                               // 30 Apr, 30 Jul, 30 Oct, 30 Jan
  | { kind: "ONGOING_REVIEW"; every: "MONTH" | "QUARTER" | "HALF_YEAR" | "YEAR" }
  | { kind: "EVENT_DRIVEN"; trigger: string; withinDays: number }

interface GeneratedPeriod { periodStart: LocalDate; periodEnd: LocalDate; dueDate: LocalDate }
interface InferredRule { rule: RecurrenceRule; confidence: number /* 0..1 */; mismatches: { expected: LocalDate; generated: LocalDate | null }[] }
```

Engine function signatures other modules call (M4 implements):

```ts
generateInstances(rule: RecurrenceRule, range: { from: LocalDate; to: LocalDate }, cal: { fyStartMonth: number; holidayPolicy: HolidayPolicy }): GeneratedPeriod[]
inferRule(dueDates: LocalDate[], timelineType: TimelineType, cal): InferredRule
deriveStatus(i: InstanceStatusInput, asOf: LocalDate, s: { dueSoonDays: number }): { status: DerivedStatus; overdueDays: number | null; submittedOverdue: boolean }
computeScore(items: ScoreInput[], asOf: LocalDate, s: FirmSettings): ScoreResult
planNotifications(i: InstanceStatusInput & { id: Id; ownerId: Id; approverId: Id }, s: ReminderSettings, asOf: LocalDate): PlannedNotification[]
ENGINE_VERSION: string
```

## 5. Work: assignments, instances, evidence, comments, audit

```ts
interface Assignment extends Base, Versioned {
  clientId: Id; unitId: Id; obligationId: Id; departmentId: Id
  defaultOwnerId: Id; defaultApproverId: Id
  applicability: Applicability; naReason: string | null
  activeFrom: LocalDate; activeTo: LocalDate | null
}
// unique (unitId, obligationId, departmentId) among non-archived rows

interface ComplianceInstance extends Base, Versioned {
  clientId: Id; unitId: Id; assignmentId: Id       // clientId/unitId denormalised for filtering and RLS
  periodStart: LocalDate; periodEnd: LocalDate; dueDate: LocalDate
  workflowState: WorkflowState
  pendingKind: SubmissionKind | null                // set while SUBMITTED
  completedOn: LocalDate | null                     // required for APPROVED; for NOT_APPLICABLE = date NA was recorded
  naReason: string | null                           // required when NOT_APPLICABLE or pendingKind = NA
  ownerId: Id; approverId: Id                       // copied from assignment, may be reassigned per instance
  submittedAt: Instant | null; approvedAt: Instant | null
  dueDateOverridden: boolean                        // true if a person moved the due date (audited)
}
// unique (assignmentId, periodStart)

interface InstanceStatusInput { workflowState: WorkflowState; pendingKind: SubmissionKind | null; dueDate: LocalDate; completedOn: LocalDate | null }

// Register row: what list endpoints return (flattened for the grid and export)
interface InstanceRow {
  id: Id; version: number
  obligationId: Id; externalRef: string | null; title: string; timelineType: TimelineType
  categoryName: string; actId: Id; actName: string; criticality: Criticality
  clientId: Id; companyName: string; unitId: Id; unitName: string; locationLabel: string   // "India / West Bengal / Kestrelganj"
  departmentId: Id; departmentName: string
  ownerId: Id; ownerName: string; approverId: Id; approverName: string
  periodStart: LocalDate; periodEnd: LocalDate; dueDate: LocalDate; completedOn: LocalDate | null
  workflowState: WorkflowState; pendingKind: SubmissionKind | null
  status: DerivedStatus; overdueDays: number | null      // from engine, asOf = today in client time zone
  evidenceCount: number; commentCount: number; lastComment: string | null
  formLabels: string[]; logSheetLabels: string[]
}
interface InstanceDetail extends InstanceRow {
  description: string; applicabilityText: string | null; naReason: string | null
  forms: TemplateRef[]; logSheets: TemplateRef[]; evidenceRequired: boolean
  allowedActions: InstanceAction[]                 // computed by the API from can() + state machine; UI shows only these
}
type InstanceAction = "SUBMIT" | "REQUEST_NA" | "APPROVE" | "SEND_BACK" | "REOPEN" | "REASSIGN" | "CHANGE_DUE_DATE" | "COMMENT" | "UPLOAD_EVIDENCE"

interface Evidence extends Base {
  instanceId: Id; clientId: Id
  fileName: string; mimeType: string; sizeBytes: number; sha256: string
  storageKey: string                               // never returned to clients
  scanStatus: ScanStatus; uploadedById: Id
}
// API returns EvidenceView = Evidence minus storageKey

interface Comment extends Base { instanceId: Id; clientId: Id; authorId: Id | null /* null = import/system */; kind: CommentKind; body: string }

interface AuditEvent {                              // append-only; no updatedAt/archivedAt/version
  id: Id; firmId: Id; clientId: Id | null
  at: Instant; requestId: string
  actorId: Id | null; actorKind: "PERSON" | "SYSTEM" | "IMPORT" | "OPERATOR"
  action: AuditAction
  entityType: "client" | "company" | "unit" | "location" | "department" | "person" | "membership" | "act" | "category" | "obligation" | "assignment" | "instance" | "evidence" | "import_batch" | "export" | "account"
  entityId: Id
  before: Record<string, unknown> | null; after: Record<string, unknown> | null   // changed fields only; never file contents or signed URLs
  reason: string | null
}
```

The ISO add-on's entity types (`ISO_ENTITY_TYPES`, v2 from 1.8.0: `management_system`, `certification`,
`external_audit`, `context_item`, `clause_assessment`, `controlled_document`, `document_revision`, `risk_item`,
`risk_control`, `objective`, `objective_reading`, `audit_programme`, `internal_audit`, `audit_checklist_item`,
`audit_finding`, `nonconformity`, `iso_action`, `management_review`) are staged: they join `entityType` in ISO-1b,
once M3 stores them in the `entity_type` Postgres enum and the audit trail page has words for them, as `account` did
(README decisions 39 and 42). Against 1.7.0, `corrective_action` and `review_action` are gone (one `iso_action`), and
`external_audit`, `risk_control` and `audit_checklist_item` are new. There is no `iso_file` type: an ISO file is
audited on its subject. Review inputs, outputs, incident fields and list changes are UPDATEs on the record they
belong to (`docs/iso/model.md` §8).

### Instance state machine (M7 implements; shape here so M12 can mirror it)

| From | Action | Who | Required input | To |
|---|---|---|---|---|
| OPEN, SENT_BACK | SUBMIT | instance owner | `completedOn` (≤ today), `comment`, evidence if `evidenceRequired` | SUBMITTED (pendingKind COMPLETION) |
| OPEN, SENT_BACK | REQUEST_NA | instance owner | `reason` | SUBMITTED (pendingKind NA) |
| SUBMITTED | APPROVE | instance approver | optional `comment` | APPROVED, or NOT_APPLICABLE when pendingKind NA |
| SUBMITTED | SEND_BACK | instance approver | `reason` | SENT_BACK |
| APPROVED, NOT_APPLICABLE | REOPEN | CLIENT_ADMIN, CONSULTANT, FIRM_ADMIN | `reason` | OPEN |
| OPEN, SENT_BACK, SUBMITTED | REASSIGN, CHANGE_DUE_DATE | FIRM_ADMIN, CONSULTANT, CLIENT_ADMIN | `reason` | same state |
| OPEN, SENT_BACK, SUBMITTED | UPLOAD_EVIDENCE | as `evidence.write` in endpoints.md §4 | the file | same state |
| any | COMMENT | anyone who can read the instance | `body` | same state |

Every transition (SUBMIT to REOPEN) and every REASSIGN or CHANGE_DUE_DATE carries the instance `version`; stale →
`409 STALE_VERSION`. COMMENT and UPLOAD_EVIDENCE do not change the instance and carry no version. Any other pair →
`409 INVALID_TRANSITION`.
Reassign, due-date change and evidence upload are limited to `INSTANCE_EDIT_STATES` (ADR 0004 §7): an APPROVED or
NOT_APPLICABLE instance is reopened first. `allowedActions` is these rules intersected with `can()`.

## 6. Import

```ts
interface ImportBatch extends Base, Versioned {
  clientId: Id; createdById: Id
  status: ImportBatchStatus
  fileName: string; fileSha256: string; sheetName: string | null
  mapping: ColumnMapping | null; mappingTemplateId: Id | null
  counts: { rows: number; errors: number; warnings: number; infos: number } | null
  dryRun: DryRunReport | null
  committedAt: Instant | null; failureCode: string | null
}
type CanopyField = "externalRef" | "title" | "timelineType" | "description" | "category" | "applicabilityText" | "act"
  | "completedOn" | "status" | "dueDate" | "forms" | "logSheets" | "organizationPath" | "locationPath"
  | "owner" | "ownerComment" | "approver" | "department" | "criticality"
type ColumnMapping = { sourceHeader: string; field: CanopyField | null /* ignored */ }[]
interface MappingTemplate extends Base, Versioned { clientId: Id | null /* null = firm-wide */; name: string; mapping: ColumnMapping }

interface ImportRow {                               // one per source row; contains personal data, never logged
  id: Id; batchId: Id; rowNumber: number            // 1-based, header = row 1
  raw: Record<string, string | number | null>
  mapped: Partial<Record<CanopyField, string | null>> | null
  issueIds: Id[]
  outcome: ImportRowOutcome
  targetInstanceId: Id | null
}
interface ImportIssue {
  id: Id; batchId: Id; groupKey: string             // issues with the same type + proposal share a group, decided once
  type: ImportIssueType; severity: IssueSeverity
  rowNumbers: number[]; field: CanopyField | null
  rawValues: string[]; proposal: string | null      // e.g. raw ["HR","Human Resources"], proposal "Human Resources"
  decision: "PENDING" | "ACCEPTED" | "REJECTED" | "EDITED"; editedValue: string | null
}
interface DryRunReport {
  create: Record<"acts" | "categories" | "departments" | "people" | "obligations" | "assignments" | "instances" | "companies" | "units" | "locations", number>
  update: Record<"obligations" | "assignments" | "instances", number>
  unchanged: { instances: number }
  skippedRows: number; blockingErrors: number
}
```

`ImportIssueType` values and default proposal:

| Type | Severity | Default proposal |
|---|---|---|
| `PERSON_CASE_MERGE` | INFO | merge spellings that differ only by case/whitespace, title-case display |
| `PERSON_NEAR_MATCH` | WARNING | none; user decides (edit distance ≤ 2) |
| `ENUM_NORMALISED` | INFO | e.g. "HIGH" → HIGH |
| `UNKNOWN_ENUM` | ERROR | none; row kept as TO_REVIEW |
| `ALIAS_DEPARTMENT` / `ALIAS_CATEGORY` / `ALIAS_ACT` | WARNING | merge into the most frequent spelling; store the other as alias |
| `NULL_PLACEHOLDER` | INFO | "NA", "N/A", "-" → null in Form/Log Sheet |
| `COMPLIED_WITHOUT_DATE` | WARNING | `completedOn = dueDate`, comment "completion date assumed on import" |
| `DUPLICATE_PERIOD` | WARNING | keep first row by row number; the other row's date and comment become an IMPORT comment on it |
| `CONFLICTING_OBLIGATION_VALUE` | INFO | first value on obligation/assignment, per-row values kept on instances |
| `RULE_LOW_CONFIDENCE` | WARNING | import instances as given, `ruleStatus = TO_REVIEW` |
| `FILE_NOT_ATTACHED` | INFO | TemplateRef with fileName and no file |
| `UNPARSED_EXTERNAL_REF` | INFO | domain from prefix, jurisdiction from Act |
| `INVALID_DATE` | ERROR | none |
| `MISSING_REQUIRED` | ERROR | none |

## 7. Dashboards and scores

```ts
interface ScoreInput { instanceId: Id; criticality: Criticality; dueDate: LocalDate; workflowState: WorkflowState; pendingKind: SubmissionKind | null; completedOn: LocalDate | null }
interface ScoreResult {
  engineVersion: string; asOf: LocalDate
  score: number | null                              // % one decimal; null = "No items due"
  onTimeRate: number | null
  counts: Record<DerivedStatus, number>
  instanceIds: Record<DerivedStatus, Id[]>          // so every number links to exactly those rows
}
interface Breakdown { by: "department" | "act" | "criticality" | "unit" | "owner"; rows: { key: string; label: string; result: ScoreResult }[] }
interface PortfolioRow { clientId: Id; clientName: string; result: ScoreResult; dueThisWeek: number; dueThisWeekFilter?: DueThisWeekFilter; lastActivityAt: Instant | null }
interface DueThisWeekFilter { dueFrom: LocalDate; dueTo: LocalDate; workflowState: WorkflowState[]; source?: ActivitySource } // source: LAW while the account has the ISO add-on
interface PlannedNotification { kind: NotificationKind; recipientId: Id; instanceId: Id; sendDate: LocalDate; offsetDays: number }
interface ExportJob extends Base { clientId: Id; kind: ExportKind; params: Record<string, unknown>; status: JobStatus; fileName: string | null; requestedById: Id }
```

Scores, KPIs, breakdowns, the act-wise, department-wise and overdue reports, the certificate PDF and the consultant
digest count STATUTE-act instances only, with the ISO add-on on or off (`docs/iso/plan.md` §4.6). While it is on,
`dueThisWeekFilter.source` is `LAW`, so the register link lists exactly the items the count is made of. ISO has its
own figures (§10).

## 8. Request context and policy (M5 implements; stub shape here)

```ts
interface RequestContext {
  requestId: string; firmId: Id; personId: Id
  memberships: Membership[]                          // active, non-expired
  clientIds: Id[]                                    // every client this person may see
  mfaSatisfied: boolean
  asOf: LocalDate                                    // today in the client time zone of the request
}
type Action = string                                 // "<resource>.<verb>", listed in endpoints.md
type Resource = { type: AuditEvent["entityType"]; clientId: Id | null; unitId?: Id; unitIds?: Id[]; ownerId?: Id; approverId?: Id }
can(ctx: RequestContext, action: Action, resource: Resource): boolean
```

The M0 stub `can()` (`can` in `@canopy/contracts`, from contracts 1.3.0) allows according to the role matrix in `ENDPOINTS` (endpoints.md), within each membership's client and unit scope, `own` for OWNER and APPROVER, and only after MFA for firm roles. M6, M7, M8 and M10 use it until M5 merges.

`Resource.unitIds` (1.8.0) is for a record that spans several units: an ISO management system, internal audit or
certificate, or a record that takes its management system's units (`docs/iso/plan.md` §3.3). It is optional, and
non-empty and distinct when present. A unit-scoped membership then needs at least one of those units; the stub's
`inScope` checks it, and M5 does the same in ISO-4b. The ISO API passes it only when the list is known and not empty,
and checks the named-person exception itself (endpoints.md §10). Before ISO-1b no `can()` resource names an ISO entity
type.

## 9. Accounts and the platform operator (ADR M15-0001)

An **Account** is a firm: the same tenant, the same RLS. The platform operator (PlanetPulse staff) sits outside every
tenant and creates every account; there is no sign-up. Schemas: `packages/contracts/src/schemas/accounts.ts`.

```ts
interface PlanLimits { companies: number | null; units: number | null; users: number | null; storageBytes: number | null } // null = unlimited
interface Plan { code: string; name: string; limits: PlanLimits; features: string[]; retiredAt: Instant | null }
interface AccountOverride { limits: Partial<PlanLimits>; features: string[]; removedFeatures?: string[]; note: string | null } // a flag is added or removed, not both
interface Entitlements { planCode: string; limits: PlanLimits; features: string[] }       // plan overlaid with the override: effectiveFeatures()
interface Usage { companies: number; units: number; users: number; storageBytes: number } // users: ACTIVE or INVITED, live membership, no support people
interface AccountSummary { kind: AccountKind; status: AccountStatus; trialEndsOn: LocalDate | null; features?: string[] } // Me.account; missing features = []
interface Subscription { id; accountId; planCode; startsOn: LocalDate; endsOn: LocalDate; amountPaise: number; invoiceNumber: string | null; paidOn: LocalDate | null; recordedAt: Instant; recordedById: Id }
interface UsageSnapshot { accountId; takenOn: LocalDate; usage: Usage; activeUsers30d: number; instances: number }
interface PlatformOperator { id; email; displayName; createdAt; disabledAt: Instant | null }
interface OperatorAuditEvent { id; at; operatorId: Id | null; action: OperatorAuditAction; accountId: Id | null; before; after; reason: string | null; requestId; ip: string | null }
interface SupportGrant { id; accountId; level: SupportAccessLevel; status: SupportGrantStatus; startsAt; endsAt; grantedById; revokedAt; revokedById; supportPersonId }
interface OperatorSupportGrant { id; accountId; level; status; startsAt; endsAt; revokedAt } // the operator's view: no person ids (ADR M15-0001 decision 8)
interface Account {                                 // the operator's view: never client data, only the firm row and counts
  id; name; kind; status; planCode; trialEndsOn; libraryCopiedAt; onboardedAt; deletionRequestedAt; purgeAfter
  isoCatalogueCopiedAt?: Instant | null              // when the ISO catalogue copy was recorded (§10); missing = null
  profile: { legalName; gstin: string | null; timeZone; fyStartMonth }
  entitlements: Entitlements; usage: Usage
  createdAt; version
}
```

`Account` carries no owner name or email: they live in `person` and `invite`, which the operator may not read (ADR
M15-0001 decision 8). The owner has accepted once the status has left PROVISIONING.

Status moves (`ACCOUNT_TRANSITIONS`, `canMoveAccount`, ADR M15-0001 decision 3): PROVISIONING → TRIAL | ACTIVE (owner
accepts); TRIAL → ACTIVE (convert), SUSPENDED (trial ends); ACTIVE ⇄ SUSPENDED; ACTIVE | SUSPENDED → PENDING_DELETION;
PENDING_DELETION → the status it left (cancel, so ACTIVE or SUSPENDED) or DELETED (purge after 30 days, ADR M15-0002).
A trial extension moves `trialEndsOn` on a TRIAL account and is not a status move. `WORKING_ACCOUNT_STATUSES` (TRIAL, ACTIVE)
can do everything and run jobs. SUSPENDED signs nobody in. In `EXPORT_ACCOUNT_STATUSES` (PENDING_DELETION) only account
admins sign in, to read `/me` and download the account export. Everything else answers `403 ACCOUNT_SUSPENDED`.

Features and add-ons (ADR M16-0001): an account's features are `effectiveFeatures(plan.features, override)`, that is
(plan features ∪ override `features`) − override `removedFeatures`, sorted. `KNOWN_FEATURES` lists the add-ons the
console shows by name, each with a label and description; v1 has one, `isoManagement` ("ISO management systems"),
which no plan includes by default. The console's switch writes the override with a reason (`OVERRIDE_CHANGE`); a
switch turned off adds the flag to `removedFeatures`, so it beats a plan that includes it. `Me.account.features` tells
the app which add-ons to show. A route that belongs to an add-on the account lacks answers `403 FEATURE_NOT_ENABLED`
`{ feature }`, reads included; turning a feature off hides and blocks, never deletes. An ISO route of an account that
has the feature but whose ISO catalogue copy is not recorded yet (`isoCatalogueCopiedAt` null) answers `409
FEATURE_NOT_READY` `{ feature }` (§10). M15 writes `account.features_changed` whenever an account's effective
features change (events.md "Accounts").

Support access: an account admin grants `READ_ONLY` (a VIEWER membership per client) or `ADMIN` (one FIRM_ADMIN
membership) for 1-30 days to the account's support person, "PlanetPulse support" (`Person.support = true`), whose
memberships expire with the grant. The support person has no password: it cannot sign in, get a magic link or be
invited, and is not counted in usage. Its only session comes from `POST /auth/support/verify` with a one-time token
valid `SUPPORT_TOKEN_SECONDS` (60), and lasts until the earlier of `SUPPORT_SESSION_HOURS` and the grant end. Defaults: `DEFAULT_TRIAL_DAYS` 30, `OWNER_INVITE_HOURS` 72, `ACCOUNT_DELETION_GRACE_DAYS` 30,
`SUPPORT_GRANT_DEFAULT_DAYS` 7, `SUPPORT_GRANT_MAX_DAYS` 30, `SUPPORT_SESSION_HOURS` 2, `SUPPORT_TOKEN_SECONDS` 60.

## 10. ISO add-on (M16, ADR M16-0001 and M16-0002)

The `isoManagement` add-on runs ISO 9001, 14001 and 45001 management systems for a client. `docs/iso/model.md` is the
full model, with the guards and transition tables; this section lists the contract shapes. Schemas:
`src/schemas/iso.ts` (records and enums), `src/schemas/iso-results.ts` (engine results), `src/api/iso.ts` (bodies,
queries, views), `src/engine-api.ts` (`IsoEngineApi`) and `src/defaults.ts` (reminders). Nothing stores a standard's
text: clause numbers, titles and summaries in our own words only. Routes: endpoints.md §10.

Recurring ISO activities (calibration, drills, inspections) are not ISO records: they are obligations under a
STANDARD act (§4), with assignments, instances, evidence and maker-checker as for laws.

### Catalogue (the account's copy, firm-wide)

```ts
interface IsoStandard extends Base { code: IsoStandardCode; edition: string /* "2015+A1:2024" */; title: string /* "ISO 14001" */; topic: string /* ours */ }
interface IsoClause extends Base {
  standardId: Id; number: ClauseNumber; title: string; summary: string     // summary in our words
  parentId: Id | null
  hlsKey: ClauseNumber | null                       // the shared-structure clause (4 to 10) the standards have in common
  assessable: boolean                               // gets a checklist row and counts in readiness
  exclusionAllowed: boolean                         // only on an assessable clause: may be approved as not applicable
}
interface IsoReviewInputDef extends Base { standardId: Id; key: ReviewInputKey; clauseNumber: ClauseNumber; item: string | null /* "c1" */; title: string; source: ReviewInputSource }
interface IsoReviewOutputDef extends Base { standardId: Id; key: ReviewOutputKey; clauseNumber: ClauseNumber; item: string | null; title: string }
```

Catalogue rows are firm-wide reference data with no `clientId` and no `version`, written only by the catalogue copy
(`docs/iso/plan.md` §4.3, `docs/iso/catalogue.md`). The copy writes them, four STANDARD acts (ISO 9001, ISO 14001,
ISO 45001 and the integrated "ISO IMS"), one category and one obligation per recurring activity, then records
`Account.isoCatalogueCopiedAt` once. It writes a SYSTEM `CREATE` audit event per act, category and obligation, as the
master library copy does; catalogue rows themselves are not audited. Until the copy is recorded, every ISO route
answers `409 FEATURE_NOT_READY`. Turning the add-on off and on again copies nothing more.

### Client records

Every record below has `Base`, `Versioned` and `clientId` (RLS, an isolation test). Those marked "system" also have
`managementSystemId`. "Exactly when" means the field is set in that case and null in every other.

```ts
interface ManagementSystem {                        // 4.1-4.4
  name: string; standardIds: Id[]                   // 1-3, one edition each; may only grow
  scopeStatement: string | null
  unitIds: Id[]                                     // empty = not chosen yet; unit scope then covers every unit of the client
  status: ManagementSystemStatus
  reviewIntervalMonths: number                      // 1-36
  climateChangeRelevant: boolean | null             // the 2024 amendment's climate decision; null = not decided
  climateChangeRationale: string | null; climateDecidedOn: LocalDate | null   // exactly when decided
}
interface ContextItem /* system */ { kind: ContextItemKind; text: string; needs: string | null /* INTERESTED_PARTY only */; climateRelated: boolean; reviewedOn: LocalDate | null }
interface ClauseAssessment /* system */ {            // one checklist row per assessable clause of the system's standards
  clauseId: Id; status: ClauseStatus
  justification: string | null                      // required while N/A is REQUESTED or APPROVED
  naState: ClauseNaState                            // status is NOT_APPLICABLE exactly while REQUESTED or APPROVED
  statusBeforeNa: ClauseWorkStatus | null           // what REJECT_NA restores; WITHDRAW_NA returns the row to NOT_STARTED
  naRequestedById: Id | null; naDecidedById: Id | null; naDecidedAt: Instant | null   // the decider is never the requester
  ownerId: Id | null; notes: string | null; lastReviewedOn: LocalDate | null
}
interface ControlledDocument /* system */ {          // 5.2, 7.5
  code: string                                      // unique per client, e.g. "QP-07"
  title: string; type: DocumentType; clauseIds: Id[]; status: DocumentStatus
  currentRevisionId: Id | null                      // the latest APPROVED revision
  ownerId: Id; approverId: Id; reviewDueOn: LocalDate | null; lastReviewedOn: LocalDate | null
  retention: string | null                          // FORM only
  issuer: string | null; externalRef: string | null // EXTERNAL only
}
interface DocumentRevision {
  documentId: Id; revision: string /* "B" */; changeNote: string | null; state: RevisionState
  preparedById: Id
  approvedById: Id | null                           // never the preparer; null for a recorded EXTERNAL edition
  approvedAt: Instant | null                        // exactly when APPROVED or SUPERSEDED
  sendBackReason: string | null
}
interface RiskItem /* system */ {                    // 6.1 risks and opportunities, aspects, hazards: one register
  kind: RiskKind; unitId: Id | null; activity: string; description: string
  impact: string | null                             // required on ASPECT and HAZARD
  lifeCycleStages: LifeCycleStage[]                 // ASPECT: at least one; others none
  controlType: AspectControlType | null             // exactly for ASPECT
  routine: boolean | null                           // exactly for HAZARD
  personsExposed: PersonsExposed[]                  // HAZARD: at least one; others none
  condition: OperatingCondition | null              // exactly for ASPECT and HAZARD
  assessedWith: string | null
  likelihood: number; severity: number              // 1-5
  residualLikelihood: number | null; residualSeverity: number | null   // set together
  rating: number; residualRating: number | null     // engine results, stored on write: 1-25
  significant: boolean                              // engine result (isSignificant with FirmSettings.isoRisk)
  significantOverride: boolean | null; significanceReason: string | null   // exactly with an override
  obligationIds: Id[]; climateRelated: boolean
  ownerId: Id; reviewDueOn: LocalDate | null; lastReviewedOn: LocalDate | null
}
interface RiskControl { riskItemId: Id; text: string; hierarchy: ControlHierarchy | null /* required on a HAZARD item */; sourceActionId: Id | null }
interface Objective /* system */ {                   // 6.2; its plan is its actions
  standards: IsoStandardCode[]; text: string; target: number; unitOfMeasure: string; baseline: number | null
  direction: ObjectiveDirection; readingRule: RecurrenceRule; riskItemIds: Id[]
  ownerId: Id; dueOn: LocalDate; closedOn: LocalDate | null
  outcome: ObjectiveOutcome | null                  // exactly when closedOn
}
interface ObjectiveReading { objectiveId: Id; periodStart: LocalDate; periodEnd: LocalDate; value: number; note: string | null; recordedById: Id }
interface AuditProgramme /* system */ { fy: FyLabel /* one per system and FY */; notes: string | null }
interface InternalAudit {                           // 9.2
  programmeId: Id; title: string; plannedStart: LocalDate; plannedEnd: LocalDate
  clauseIds: Id[]; unitIds: Id[]                    // empty unitIds = the system's units (scope), but only named units count as covered
  leadAuditorId: Id; auditorIds: Id[]; auditeeIds: Id[]; reportedToIds: Id[]   // reportedToIds: at least one once REPORTED
  independenceNote: string | null                   // required when selfAuditors(audit) is not empty
  state: InternalAuditState; summary: string | null
  reportedOn: LocalDate | null                      // exactly once REPORTED or CLOSED
  cancelReason: string | null                       // exactly when CANCELLED
}
interface AuditChecklistItem {
  internalAuditId: Id; clauseId: Id; unitId: Id | null; question: string; auditorNote: string | null
  result: ChecklistResult | null                    // null until answered
  findingId: Id | null                              // exactly for FINDING
  notAuditedReason: string | null                   // exactly for NOT_AUDITED
}
interface Certification /* system */ {               // one standard, one certification body
  standardId: Id; body: string
  certificateNumber: string | null; issuedOn: LocalDate | null; expiresOn: LocalDate | null   // all three set together, once issued
  scopeText: string | null; unitIds: Id[]           // null scopeText = the system's scope; empty unitIds = the system's units
}
interface ExternalAudit /* system */ {               // a certification body's visit, one or more standards
  standardIds: Id[]; type: ExternalAuditType; body: string; leadAuditorName: string | null   // the body's auditor, as text
  startOn: LocalDate; endOn: LocalDate
  recommendation: AuditRecommendation | null        // required when CLOSED
  responseDueOn: LocalDate | null; state: ExternalAuditState; cancelReason: string | null
}
interface AuditFinding {
  internalAuditId: Id | null; externalAuditId: Id | null   // exactly one
  type: FindingType; clauseIds: Id[]; unitId: Id | null; description: string
  nonconformityId: Id | null                        // exactly for MAJOR_NC and MINOR_NC, raised in the same transaction
}
interface Nonconformity /* system */ {               // 10.2, maker-checker like an instance
  number: number                                    // per client, from 1
  source: NcSource; sourceInstanceId: Id | null; raisedFromRiskItemId: Id | null
  severity: NcSeverity; standards: IsoStandardCode[]; clauseIds: Id[]; unitId: Id | null   // unitId required for INCIDENT and NEAR_MISS
  description: string; reportedById: Id; reportedOn: LocalDate
  containment, correction: string | null
  disposition: NcDisposition | null; dispositionAuthorisedById: Id | null   // set together
  rootCauseMethod: RootCauseMethod | null; rootCause, similarOccurrences: string | null   // required from ROOT_CAUSE_FOUND
  relatedRiskItemIds, updatedRiskItemIds: Id[]
  riskReview, systemChange: string | null           // required from AWAITING_VERIFICATION
  changedDocumentIds: Id[]; noActionReason: string | null
  ownerId: Id; approverId: Id                       // never the same person
  dueOn: LocalDate; effectivenessDueOn: LocalDate | null; effectivenessNote: string | null
  effective: boolean | null                         // true once verified effective; false after VERIFY_NOT_EFFECTIVE
  closedOn: LocalDate | null                        // exactly when CLOSED (then effective is true, with a note)
  cancelReason: string | null; state: NcState
  incident: Incident | null                         // exactly for INCIDENT and NEAR_MISS sources
}
interface Incident {                                // no injured person's name, health or medical detail: files only
  occurredAt: Instant; location: string; type: IncidentType /* NEAR_MISS exactly for a NEAR_MISS source */
  outcome: IncidentOutcome                          // NONE for a near miss
  personCategory: IncidentPersonCategory | null
  lostDays: number | null                           // exactly for LOST_TIME
  reportable: boolean; statutoryInstanceId: Id | null; investigatorIds: Id[]; workerParticipation: boolean
}
interface IsoAction {                               // one action entity for every subject
  subject: { type: IsoActionSubjectType; id: Id }
  text: string; resources: string | null; ownerId: Id; dueOn: LocalDate
  doneOn: LocalDate | null                          // exactly when DONE
  state: IsoActionState; effectivenessNote: string | null
  cancelReason: string | null                       // exactly when CANCELLED
  controlHierarchy: ControlHierarchy | null         // RISK_ITEM subjects only; required on a HAZARD item
  outputKey: ReviewOutputKey | null                 // MANAGEMENT_REVIEW subjects only
}
interface ManagementReview /* system */ {            // 9.3
  standards: IsoStandardCode[]; plannedOn: LocalDate
  heldOn: LocalDate | null                          // exactly once HELD or CLOSED
  chairId: Id; attendeeIds: Id[]; minutes: string | null; state: ManagementReviewState; cancelReason: string | null
}
interface ReviewInput {                             // one live row per input key of its standards
  managementReviewId: Id; inputDefId: Id; notes: string | null
  sourceFigures: ReviewInputFigures | null          // stored once at RECORD_HELD, a record (model §1.7, §3.13)
  figuresStoredAt: Instant | null                   // set with sourceFigures
  figuresEngineVersion: string | null               // set with sourceFigures; not in the view
}
interface ReviewOutput { managementReviewId: Id; outputDefId: Id; decision: string | null }  // one per output key of its standards
```

Every person named on a record holds a live role in the record's client covering its unit (model §1.5). Moving a
planned or due date needs a reason (`DUE_DATE_CHANGE`). A locked record (model §1.8, §6) refuses field edits and file
changes with `409 INVALID_TRANSITION` and `action: 'UPDATE'`.

### Enums (`src/schemas/iso.ts`)

| Enum | Values |
|---|---|
| `ManagementSystemStatus` | `PLANNING`, `IMPLEMENTING`, `CERTIFIED`, `SUSPENDED`, `WITHDRAWN` |
| `ContextItemKind` | `INTERNAL_ISSUE`, `EXTERNAL_ISSUE`, `INTERESTED_PARTY` |
| `ClauseStatus` / `ClauseWorkStatus` | `NOT_STARTED`, `PARTIAL`, `IMPLEMENTED`, and `NOT_APPLICABLE` (`ClauseStatus` only) |
| `ClauseNaState` / `ClauseNaAction` | `NONE`, `REQUESTED`, `APPROVED`, `REJECTED` / `REQUEST_NA`, `APPROVE_NA`, `REJECT_NA`, `WITHDRAW_NA` |
| `DocumentType` | `POLICY`, `MANUAL`, `PROCEDURE`, `WORK_INSTRUCTION`, `FORM`, `EXTERNAL` (no RECORD type: records are files) |
| `DocumentStatus` / `DocumentAction` | `ACTIVE`, `OBSOLETE` / `REVIEW`, `MAKE_OBSOLETE` |
| `RevisionState` / `RevisionAction` | `DRAFT`, `IN_REVIEW`, `APPROVED`, `SUPERSEDED` / `DRAFT_REVISION`, `SUBMIT`, `APPROVE`, `SEND_BACK`, `RECORD_EDITION` |
| `RiskKind` | `RISK`, `OPPORTUNITY`, `ASPECT`, `HAZARD` |
| `LifeCycleStage` | `RAW_MATERIAL`, `DESIGN`, `PRODUCTION`, `TRANSPORT`, `USE`, `END_OF_LIFE` |
| `AspectControlType`, `PersonsExposed`, `OperatingCondition` | `CONTROL`, `INFLUENCE`; `WORKER`, `CONTRACTOR`, `VISITOR`, `PUBLIC`; `NORMAL`, `ABNORMAL`, `EMERGENCY` |
| `ControlHierarchy` | `ELIMINATION`, `SUBSTITUTION`, `ENGINEERING`, `ADMINISTRATIVE`, `PPE` (most effective first) |
| `ObjectiveDirection` / `ObjectiveOutcome` | `INCREASE`, `DECREASE`, `MAINTAIN` / `ACHIEVED`, `NOT_ACHIEVED` |
| `InternalAuditState` / `InternalAuditAction` | `PLANNED`, `IN_PROGRESS`, `REPORTED`, `CLOSED`, `CANCELLED` / `START`, `CANCEL`, `REPORT`, `CLOSE` |
| `ChecklistResult` | `CONFORMS`, `FINDING`, `NOT_AUDITED` |
| `ExternalAuditType` | `STAGE_1`, `STAGE_2`, `SURVEILLANCE_1`, `SURVEILLANCE_2`, `RECERTIFICATION`, `SPECIAL`, `TRANSITION` |
| `AuditRecommendation` | `RECOMMENDED`, `RECOMMENDED_AFTER_CLOSURE`, `NOT_RECOMMENDED` |
| `ExternalAuditState` / `ExternalAuditAction` | `PLANNED`, `HELD`, `RESPONDED`, `CLOSED`, `CANCELLED` / `RECORD_HELD`, `CANCEL`, `RECORD_RESPONSE`, `CLOSE` |
| `FindingType` | `MAJOR_NC`, `MINOR_NC` (`NC_FINDING_TYPES`: these raise an NC), `OBSERVATION`, `OFI`, `GOOD_PRACTICE` |
| `NcSource` | `INTERNAL_AUDIT`, `EXTERNAL_AUDIT`, `INCIDENT`, `NEAR_MISS` (`INCIDENT_SOURCES`), `COMPLAINT`, `PROCESS`, `LEGAL`, `OTHER`; `RaisableNcSource` leaves out the two audit sources |
| `NcSeverity`, `RootCauseMethod` | `MAJOR`, `MINOR`; `FIVE_WHYS`, `FISHBONE`, `OTHER` |
| `NcDisposition` | `CORRECTION`, `SEGREGATION`, `RETURN_OR_SUSPENSION`, `CUSTOMER_INFORMED`, `CONCESSION` |
| `NcState` | `OPEN`, `ROOT_CAUSE_FOUND`, `ACTIONS_PLANNED`, `AWAITING_VERIFICATION`, `CLOSED`, `CANCELLED` |
| `NcAction` / `NcBackTo` | `RAISE`, `ADD_ROOT_CAUSE`, `PLAN_ACTIONS`, `SUBMIT_NO_ACTION`, `SUBMIT`, `VERIFY_EFFECTIVE`, `VERIFY_NOT_EFFECTIVE`, `CANCEL`, `REOPEN` / `OPEN`, `ACTIONS_PLANNED` |
| `IncidentType` | `INJURY`, `ILL_HEALTH`, `DANGEROUS_OCCURRENCE`, `ENVIRONMENTAL_RELEASE`, `FIRE`, `PROPERTY_DAMAGE`, `NEAR_MISS` |
| `IncidentOutcome` | `NONE`, `FIRST_AID`, `MEDICAL_TREATMENT`, `RESTRICTED_WORK`, `LOST_TIME`, `FATALITY` |
| `IncidentPersonCategory` | `EMPLOYEE`, `CONTRACT_WORKER`, `VISITOR`, `PUBLIC` |
| `IsoActionSubjectType` | `NONCONFORMITY`, `RISK_ITEM`, `OBJECTIVE`, `AUDIT_FINDING`, `MANAGEMENT_REVIEW` |
| `IsoActionState` / `IsoActionAction` | `OPEN`, `DONE`, `CANCELLED` / `COMPLETE`, `CANCEL`, `REOPEN` |
| `ManagementReviewState` / `ManagementReviewAction` | `PLANNED`, `HELD`, `CLOSED`, `CANCELLED` / `PLAN`, `CANCEL`, `RECORD_HELD`, `CLOSE` |
| `ReviewInputKey` | 19 keys of our own, one per review input across the standards, e.g. `PREVIOUS_ACTIONS`, `CONTEXT_CHANGES`, `NONCONFORMITIES`, `AUDIT_RESULTS` |
| `ReviewOutputKey` | `SUITABILITY`, `IMPROVEMENT`, `SYSTEM_CHANGES`, `RESOURCE_NEEDS`, `OBJECTIVES_NOT_MET`, `INTEGRATION`, `STRATEGIC_DIRECTION`, `WORKER_COMMUNICATION` |
| `ReviewInputSource` | `PREVIOUS_ACTIONS`, `CONTEXT`, `RISKS`, `OBJECTIVES`, `NONCONFORMITIES`, `INCIDENTS`, `AUDIT_RESULTS`, `COMPLIANCE_EVALUATION`, `MANUAL` |
| `IsoFileSubjectType` | the 11 entity types a file can be attached to (below) |

### Staged constants (plan §5.1)

These live in `src/enums.ts` outside the contract enums until ISO-1b, after M3 stores them in the Postgres enums
(ISO-2b), M13 labels the entity types (ISO-12a) and M10's export switch takes new kinds (ISO-11e):

| Constant | Values | Joins in ISO-1b |
|---|---|---|
| `ISO_ENTITY_TYPES` (`IsoEntityType`) | the 18 v2 types in §5 | `EntityType` |
| `ISO_NOTIFICATION_KINDS` (`IsoNotificationKind`) | `ISO_ACTION_DUE`, `ISO_ACTION_OVERDUE`, `ISO_REVIEW_DUE`, `ISO_AUDIT_STARTING`, `ISO_CERTIFICATE_EXPIRING`, `ISO_SURVEILLANCE_DUE`, `ISO_EXTERNAL_RESPONSE_DUE`, `ISO_MANAGEMENT_REVIEW_DUE`, `ISO_EFFECTIVENESS_DUE` | `NotificationKind` |
| `ISO_EXPORT_KINDS` (`IsoExportKind`) | `ISO_NC_LOG_XLSX`, `ISO_RISK_REGISTER_XLSX`, `ISO_AUDIT_REPORT_PDF`, `ISO_REVIEW_PACK_PDF` | `ExportKind` |

Until then no route writes an `AuditEvent` with an ISO entity type and no `can()` resource names one; the mock keeps
its ISO audit events apart (README decision 49). `ExportCreateBody` refuses the ISO kinds (its `kind` is `ExportKind`);
once they join, it checks their `filters` against `ISO_EXPORT_FILTERS` (the NC and risk list queries without paging,
`{ internalAuditId }` for the audit report, `{ managementReviewId }` for the review pack) instead of
`RegisterFilterQuery`.

### Machines

`isoTransition(machine, from, action, facts)` (M4) holds the transition tables of model §4; M16 enforces them. A
state that does not allow the action is `409 INVALID_TRANSITION` with details `{ entity, from, action }`; a failed
guard is `400 VALIDATION`, or `422 REASON_REQUIRED` when the missing field is a reason.

| `IsoMachine` | States | Actions | `entity` in the 409 |
|---|---|---|---|
| `NONCONFORMITY` | `NcState` | `NcAction` | `nonconformity` |
| `DOCUMENT_REVISION` | `RevisionState` | `RevisionAction` | `document_revision` |
| `DOCUMENT` | `DocumentStatus` | `DocumentAction` | `controlled_document` |
| `INTERNAL_AUDIT` | `InternalAuditState` | `InternalAuditAction` | `internal_audit` |
| `EXTERNAL_AUDIT` | `ExternalAuditState` | `ExternalAuditAction` | `external_audit` |
| `MANAGEMENT_REVIEW` | `ManagementReviewState` | `ManagementReviewAction` | `management_review` |
| `CLAUSE_NA` | `ClauseNaState` | `ClauseNaAction` | `clause_assessment` |
| `ISO_ACTION` | `IsoActionState` | `IsoActionAction` | `iso_action` |

A field edit or a new child row on a locked record is refused with `action: 'UPDATE'`. A manager (FA, CO or CA) who
takes a step for the person named is audited with `delegated: true` in `after` (model §4 preamble).

### Views (`src/api/iso.ts`)

Each view is its record plus what the screen needs; the derived parts come from the engine.

| View | Adds |
|---|---|
| `ClauseAssessmentView` | `standardId`, `clauseNumber`, `clauseTitle`, `exclusionAllowed`, `allowedActions: ClauseNaAction[]` |
| `DocumentView` | `currentRevision` (label), `openRevisionId` (the DRAFT or IN_REVIEW revision), `reviewStatus: IsoDueStatus`, `allowedActions` (`REVIEW`, `MAKE_OBSOLETE`, `DRAFT_REVISION`) |
| `RevisionView` | `allowedActions` (`RevisionAction` without `DRAFT_REVISION`) |
| `RiskItemView` | `reviewStatus: IsoDueStatus` |
| `ObjectiveView` | `progress: ObjectiveProgress` |
| `AuditProgrammeView` | `coverage: AuditProgrammeCoverage` |
| `InternalAuditView` | `managementSystemId`, `allowedActions: InternalAuditAction[]` |
| `CertificationView` | `cycle: CertificationCycle` |
| `ExternalAuditView` | `allowedActions: ExternalAuditAction[]` |
| `NonconformityView` | `status: NonconformityStatus`, `findingId`, `allowedActions` (`NcAction` without `RAISE`) |
| `IsoActionView` | `status: IsoDueStatus`, `allowedActions: IsoActionAction[]` |
| `ManagementReviewView` | `allowedActions` (`ManagementReviewAction` without `PLAN`) |
| `ReviewInputView` | `key`, `title`, `source`, `clauseRefs: { standard, clauseNumber, item }[]`; `sourceFigures: ReviewInputFigures \| null` is the stored copy for a HELD or CLOSED review, computed as of the client's today for a PLANNED one, null for a CANCELLED review or a MANUAL input, with the values system-wide and the ids cut to those the reader may read; `figuresStoredAt` is set exactly when it is the stored copy; no `figuresEngineVersion` |
| `ReviewOutputView` | `key`, `title`, `clauseRefs` |
| `IsoReviewDefs` | `{ inputs: IsoReviewInputDef[]; outputs: IsoReviewOutputDef[] }` |
| `IsoOverview` | `{ asOf; systems: IsoSystemOverview[] }`: per system, clause and certification readiness, climate gaps, NC, action, document, risk, objective, audit programme, management review, certificate and incident figures, each with the ids behind it |

`allowedActions` is the machine's table intersected with `can()` and the guards that need no input, for the
signed-in person.

### Files (`IsoFile`, `IsoFileView`)

ISO files are kept apart from evidence: `Evidence`, `EvidenceView`, the evidence table, the vault and M7's
`/evidence/{id}/*` routes do not change.

```ts
interface IsoFile extends Base {                    // stored form: one nullable column per subject, exactly one set
  clientId: Id
  clauseAssessmentId, documentRevisionId, riskItemId, objectiveReadingId, internalAuditId, auditFindingId,
  externalAuditId, certificationId, nonconformityId, isoActionId, managementReviewId: Id | null   // ISO_FILE_SUBJECT_COLUMNS
  fileName: string; mimeType: string; sizeBytes: number /* ≤ MAX_ISO_FILE_BYTES, the evidence limit */; sha256: string
  scanStatus: ScanStatus; uploadedById: Id; uploadedAt: Instant
  removeReason: string | null                       // set exactly with archivedAt
  storageKey: string                                // never returned
}
interface IsoFileView { /* IsoFile without storageKey and the subject columns */ subject: { type: IsoFileSubjectType; id: Id } }
```

Same pipeline as evidence: a 5-minute upload URL with the evidence file-type and size rules, confirm (PENDING), the
virus scan, download only when `CLEAN` through a 5-minute signed URL, every download audited on the subject
(`EVIDENCE_ADD`, `EVIDENCE_DOWNLOAD`, `EVIDENCE_REMOVE`). Removing archives with a reason; nothing is deleted. Files
on an incident NC and its actions download only for the people model §6 names.

### Engine (`IsoEngineApi`, M4)

A separate interface beside `EngineApi`, so adding it never breaks the engine's `satisfies EngineApi`. Pure, with
explicit dates.

```ts
riskRating(likelihood, severity): number                                      // 1-25
isSignificant(item: { rating, obligationIds, significantOverride }, rule: IsoRiskRule): boolean   // an override wins
clauseReadiness(assessments, clauses): ClauseReadiness                         // IMPLEMENTED 1, PARTIAL 0.5; approved exclusions leave the denominator
certificationReadiness(system: IsoSystemInput, data: CertificationReadinessData, asOf): CertificationReadiness
objectiveProgress(readings, objective & { createdOn }, asOf, cal: { fyStartMonth }): ObjectiveProgress  // createdOn: createdAt as a client-zone date
auditProgrammeCoverage(audits, checklistItems, system, clauses /* with excluded */, fy): AuditProgrammeCoverage
incidentCounts(ncs, period: { from; to }, timeZone): IncidentCounts
climateDeterminationGaps(system, contextItems, riskItems): ClimateGap[]
isoTransition(machine: IsoMachine, from, action, facts): IsoTransitionResult  // { ok: true; to } | INVALID_TRANSITION | { GUARD; guard; fields }
nonconformityStatus(nc, actions, asOf, s: { dueSoonDays }): NonconformityStatus
actionStatus(action, asOf, s: { dueSoonDays }): IsoDueStatus
certificationCycle(certification, externalAudits, asOf): CertificationCycle  // empty before the certificate is issued
managementReviewDue(system & { standards }, reviews, asOf, s: { dueSoonDays }): ManagementReviewDue
reviewDue(reviewDueOn, asOf, s: { dueSoonDays }): IsoDueStatus
planIsoNotifications(items: IsoNotificationInput[], schedule: IsoReminderSchedule, asOf): PlannedIsoNotification[]
reviewInputFigures(source: S, data: ReviewFigureData[S], since, asOf): ReviewInputFigures   // model §5.4
```

`ReviewFigureData` holds, per input source, the records of the review's system the source reads, archived ones
included, with no unit scope. Every ISO row carries `createdOn` and `archivedOn` (`ReviewFigureDays`, client-local
days); actions (`ReviewFigureAction`) also `subject` and `doneOn`, nonconformities `reportedOn`. CONTEXT carries
`contextChanges`, RISKS `ratingChanges` and NONCONFORMITIES `notEffectiveSteps`: the `{ entityId, on }` days
(`ReviewFigureEventDay`) of the audited events model §5.4 names, in the window. COMPLIANCE_EVALUATION's instances are
read as they are now. M16 calls it live for a PLANNED review and once at RECORD_HELD with `asOf = heldOn`; a HELD or
CLOSED review's figures are never computed again.

Results (`src/schemas/iso-results.ts`): `IdCount { count, ids }` (every number carries the ids it counts), `IsoTiming`
(`ON_TIME`, `DUE_SOON`, `OVERDUE`, `CLOSED`), `IsoDueStatus { timing, overdueDays }`, `NonconformityStatus` (adds
`effectivenessOverdueDays`), `ReadinessScore`, `ClauseReadiness { overall, byStandard }`, `CertificationGate`
(`INTERNAL_AUDIT`, `MANAGEMENT_REVIEW`, `SCOPE`, `POLICY`, `OBJECTIVES`, `RISKS`), `GateResult { gate, met, missing }`,
`CertificationReadiness`, `ObjectiveProgress`, `AuditProgrammeCoverage`, `IncidentCounts`, `ClimateGap` (`UNDECIDED`,
`RELEVANT_NO_RISK`, `RELEVANT_NO_ISSUE`), `CertificationCycle` (items of kind `SURVEILLANCE_1`, `SURVEILLANCE_2`,
`RECERTIFICATION`) and `ManagementReviewDue`. `ReviewFigure { key, value, ids }` and `ReviewInputFigures` live in
`src/schemas/iso.ts`, since `ReviewInput` stores them.

### Reminders (`src/defaults.ts`)

ISO records are not instances, so ISO reminders have their own shapes and send key. `IsoNotificationInput { kind,
isoSubjectType, isoSubjectId, anchorDate, open, recipientIds }` is what M9 passes per subject; `IsoReminderRule {
kind, isoSubjectType, offsetDays, repeatEveryDays }` and `IsoReminderSchedule` (one rule per kind and subject type)
say when; `PlannedIsoNotification { kind, recipientId, isoSubjectType, isoSubjectId, sendDate, offsetDays }` is the
result. A send happens at most once per `ISO_NOTIFICATION_DEDUPE_KEY` (`isoSubjectType`, `isoSubjectId`, `kind`,
`sendDate`, `recipientId`). `ISO_REMINDER_SCHEDULE` is model §7's table (11 rules, not editable in v1); the overdue
management system rule repeats every 30 days. `EngineApi` and `PlannedNotification` do not change.

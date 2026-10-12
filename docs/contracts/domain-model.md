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
| `NotificationKind` | `OWNER_REMINDER`, `APPROVER_ESCALATION`, `CONSULTANT_DIGEST`, `INVITE`, `MAGIC_LINK`, `EXPORT_READY`, `APPROVAL_REQUESTED`, `SENT_BACK` | |
| `ExportKind` | `REGISTER_XLSX`, `CERTIFICATE_PDF`, `ACT_REPORT_XLSX`, `DEPARTMENT_REPORT_XLSX`, `OVERDUE_REPORT_XLSX` | |
| `JobStatus` | `QUEUED`, `RUNNING`, `DONE`, `FAILED` | Exports and imports. |

Excel to enum mapping (import, case-insensitive after trimming): Criticality "Super Critical" → `SUPER_CRITICAL`, "HIGH"/"High" → `HIGH`, etc.;
Status "Complied" → `APPROVED`, "Pending" → `OPEN`, "Not Applicable" → `NOT_APPLICABLE`.

## 3. Tenancy, entities and people

```ts
interface Firm extends Base, Versioned { name: string; settings: FirmSettings }
interface FirmSettings {
  criticalityWeights: Record<Criticality, number>   // default {SUPER_CRITICAL:5, CRITICAL:4, HIGH:3, MEDIUM:2, LOW:1}
  dueSoonDays: number                               // default 7
  mfaRequiredForFirmRoles: true                     // fixed true in v1
}

interface Client extends Base, Versioned {          // org group, e.g. "Aditya Birla Group"
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

interface Company extends Base, Versioned { clientId: Id; name: string }          // "Hindalco"
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

Hierarchy paths in Excel ("Aditya Birla Group/ Hindalco/ Plant", "India/ West Bengal/ Belur") map to Client / Company / Unit and Country / State / City.

## 4. Library

```ts
interface Act extends Base, Versioned {
  name: string; shortName: string | null
  jurisdiction: Jurisdiction; stateCode: string | null
  aliases: string[]                                 // other spellings that resolve to this Act on import
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
}
interface TemplateRef { label: string; fileName: string | null; templateFileId: Id | null } // fileName set + templateFileId null = "file not attached"
```

`externalRef` parsing: `DOMAIN-JUR-...` when it has 5 dash-separated parts; otherwise (e.g. `ENV-117-0031`, `INT-FA-1-1`) domain from the
first part and jurisdiction from the Act, with an `UNPARSED_EXTERNAL_REF` INFO issue.

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
  clientId: Id; companyName: string; unitId: Id; unitName: string; locationLabel: string   // "India / West Bengal / Belur"
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
  actorId: Id | null; actorKind: "PERSON" | "SYSTEM" | "IMPORT"
  action: AuditAction
  entityType: "client" | "company" | "unit" | "location" | "department" | "person" | "membership" | "act" | "category" | "obligation" | "assignment" | "instance" | "evidence" | "import_batch" | "export"
  entityId: Id
  before: Record<string, unknown> | null; after: Record<string, unknown> | null   // changed fields only; never file contents or signed URLs
  reason: string | null
}
```

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
interface PortfolioRow { clientId: Id; clientName: string; result: ScoreResult; dueThisWeek: number; dueThisWeekFilter?: { dueFrom: LocalDate; dueTo: LocalDate; workflowState: WorkflowState[] }; lastActivityAt: Instant | null }
interface PlannedNotification { kind: NotificationKind; recipientId: Id; instanceId: Id; sendDate: LocalDate; offsetDays: number }
interface ExportJob extends Base { clientId: Id; kind: ExportKind; params: Record<string, unknown>; status: JobStatus; fileName: string | null; requestedById: Id }
```

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
type Resource = { type: AuditEvent["entityType"]; clientId: Id | null; unitId?: Id; ownerId?: Id; approverId?: Id }
can(ctx: RequestContext, action: Action, resource: Resource): boolean
```

The M0 stub `can()` (`can` in `@canopy/contracts`, from contracts 1.3.0) allows according to the role matrix in `ENDPOINTS` (endpoints.md), within each membership's client and unit scope, `own` for OWNER and APPROVER, and only after MFA for firm roles. M6, M7, M8 and M10 use it until M5 merges.

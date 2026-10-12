# M10-0001: Dashboards, reports and exports API

Status: accepted (M10 PR 1) · 2026-10-12

## Context
M10 serves `docs/contracts/endpoints.md` §6: the portfolio, client overview, breakdowns, calendar, Act-wise,
department-wise and overdue reports, and Excel/PDF exports. Its acceptance (MODULES.md) is that every KPI equals
the matching filtered instance count from M7, and that the register export re-imports with no changes.
M7's register list endpoint and the M3 adapter for M10's reads are not merged yet.

## Decisions
1. **One data path for every number.** A read loads the client's register rows (M3 `instances.register` shape)
   for the period and the actor's units, adds `status`/`overdueDays` with `engine.deriveStatus`, and passes them to
   `computeScore`, `computeBreakdown` and `summarizeKpis`. No status or score maths in M10 (root rule 3). Breakdown
   groups are department, Act, criticality, unit and owner ids; labels are the register names (criticality in UI
   sentence case).
2. **Narrow port, memory store first.** `dashboard/ports.ts` (`ReportsStore`) lists exactly what M10 reads and
   writes. `MemoryReportsStore` mimics RLS (firm-scoped reads) for tests. The Postgres adapter over M3 repositories
   comes in M10 PR 2; the queries it needs that M3 lacks are listed below.
3. **Scope.** Unit-limited approvers and owners get only their units: the store query is limited to them and each
   row is checked with `can(action, instance resource)` as well. A requested `unitId` outside the scope gives an
   empty result rather than 403, so unit ids are not probed.
4. **asOf.** Default is today in the client's time zone (`localDateIn`). Only FIRM_ADMIN, CONSULTANT and VIEWER may
   pass `asOf`; anyone else gets 403 `FORBIDDEN` with the endpoint's action.
5. **Period.** `fy` or `from`/`to` (either side may be open). Dashboards and reports default to the FY containing
   `asOf`, per the client's `fyStartMonth`. The register export defaults to all dates, because it reproduces a
   register view; the certificate and report exports default to the current FY.
6. **Overview lists.** `upcoming` is UPCOMING and DUE_SOON rows by due date; `myTasks` is the signed-in person's OPEN
   and SENT_BACK instances, as M7's `GET /me/tasks`. Each lists at most 10.
7. **Calendar** lists only dates with items, at most 366 days per request (longer → 400 `VALIDATION`).
8. **Register export format.** The 19 sample headers in the sample's order. Status words are the register's:
   APPROVED → Complied, NOT_APPLICABLE → Not Applicable, every other state → Pending with no Activity Date (the
   importer rejects a pending row with a date). The register has no word for work in progress, so a SUBMITTED or
   SENT_BACK instance exports as the open instance it was before the work started (its submitted date is not in
   the file); work approved in the app exports as Complied with its date and re-imports unchanged. Owner Comments carries the NA reason for NA rows, else the
   instance's first comment. Organization is `client / company / unit`; Location keeps the sample spelling.
9. **Round trip.** Exporting the imported sample and analysing it again against the post-import state creates
   nothing and updates no obligation or assignment. Three instances still count as updated in M8's dry run: their
   stored comment lists hold notes the first import added (two folded duplicate rows, one assumed completion
   date), which the register has no column for. Every other field matches, and the incoming comments are already
   on the instance in order. The test allows exactly that difference, so it keeps passing when M8 treats
   already-present comments as unchanged (requested below).
10. **Exports run off the request.** `POST /exports` stores a QUEUED job and its `EXPORT` audit event, then an
    `ExportRunner` builds the file. PR 1 runs it in-process; a pg-boss `exports` worker (M9's runner) can call the
    same `runExport`. Files go to S3-compatible storage under `exports/<firm>/<client>/<job>/`; downloads are
    5-minute presigned GETs, never logged. A job and its link are visible only to the person who requested it,
    since its contents follow their unit scope. `Idempotency-Key` (UUID) is honoured for 24 hours per person, in
    memory (one API process in v1); reusing a key for another client or request is a 400 `VALIDATION`. Export requests are rate limited to 10 a minute per client IP.
11. **Certificate PDF** (pdf-lib, standard fonts) shows the client, company, unit, location, period, asOf, score,
    on-time rate, status counts, a by-Act table and the overdue list (ID, title, due date, days). It names no
    owner or approver. Its counts are of compliance items (instances), not obligations. The generation time is
    printed in the client's time zone (root rule 4). Characters outside WinAnsi print as "?". Product name:
    "PlanetPulse Compliance".

## Requests to other modules
- **M3**, for the Postgres adapter: `registerRows` with multi-value `unitIds`, `departmentIds`, `actIds`,
  `categoryIds` and `domain` (the register filter takes single ids today); an export-detail read per instance
  (obligation `description` and `applicabilityText`, instance `naReason`, first comment); latest audit time per
  client; a unit with its company name and location label.
- **M8**: in the dry run, treat an instance whose incoming comments are already on it, in order, as unchanged
  (comments are append-only, so re-import cannot change them). Then the register round trip reports zero updates.
  Also, when a stored instance is SUBMITTED or SENT_BACK, treat an incoming "Pending" row with no Activity Date as
  unchanged: the register cannot carry work in progress, and a re-import must never move it back to OPEN.

## Consequences
New dependencies in `apps/api`: `exceljs` (already used by the importer) for workbooks and `pdf-lib` for the
certificate. When M7's register list route lands, the cross-check test can compare the two endpoints over HTTP;
today it filters by `engine.deriveStatus`, the function that fills the register's status column, without importing
M7's internals.

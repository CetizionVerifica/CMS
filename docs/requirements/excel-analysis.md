# Requirements source: the client compliance register (Excel)

Source file: `/mnt/project-files/ASPxGridView1 (15) (1).xlsx`, one sheet, 424 rows x 19 columns.
It is an export of a statutory compliance register for one plant (Kestrel Aluminium, Riverbend, West Bengal) for
Indian financial year 2022-23. It is the reference for what Canopy must store, show, import and calculate.
Every number below was computed from the file on 2026-10-10. Organisation and site names here are fictional stand-ins for the real ones.

## 1. What one row is

One row is **one occurrence of one legal obligation** at one unit, with a due date, a status, an owner and an approver.
The same obligation repeats for each period:

| Rows per Compliance ID | IDs | Meaning |
|---|---|---|
| 1 | 27 | annual or one-time |
| 2 | 10 | half-yearly |
| 4 | 75 | quarterly (most "On Going" items, due 30 Jun, 30 Sep, 31 Dec, 31 Mar) |
| 5 | 1 | irregular, needs review |
| 12 | 6 | monthly (e.g. TDS/TCS deposit by the 7th) |

So the product has two core objects: an **Obligation** (the law-derived requirement, 119 in the file)
and a **Compliance instance** (one dated occurrence of it, 424 in the file).

## 2. Column-by-column mapping

| Excel column | Belongs to | Canopy field | Notes from the data |
|---|---|---|---|
| EY Compliance ID | Obligation | `externalRef` + parsed `domain`, `jurisdiction` | Pattern `TAX-CL-033-6067-60218`. Prefix = domain (HRS 182 rows, EHS 179, TAX 34, IT 13, INT 8, ENG 4, ENV 4). Second segment = jurisdiction (CL central 279, WB West Bengal 133, a few others). Keep the raw ID; never use it as our primary key. |
| Compliance Title | Obligation | `title` | 117 unique titles for 119 IDs, so titles are not unique. |
| Type (TimeLine) | Obligation | `timelineType` = `TIME_BASED` / `ONGOING` | On Going 332 rows, Time Based 92. "Ongoing" still gets periodic review instances (quarterly here). |
| Compliance Description | Obligation | `description` (rich text) | Multi-paragraph, numbered steps; render line breaks. |
| Compliance Categorization | Obligation | `category` (lookup) | 12 raw values, including duplicates "Procedural Requirement" / "Procedural Requirements" and "Statutory Records" / "Statutory Registers and Records". Needs an alias table. |
| Applicability | Obligation | `applicability` (text) | 72 unique, 4 blanks. Drives the applicability assessment for new clients. |
| Act | Obligation → Act | `actId` (lookup to Act) | 36 Acts. Some are the same Act spelled differently (e.g. Petroleum Rules 2002/2003/2005 variants, "Factories Act , 1948"). |
| Activity Date | Instance | `completedOn` | Blank on all 201 Pending rows; never later than Due Date in this file. |
| Compliance Status | Instance | `status` | Complied 211, Pending 201, Not Applicable 12. Canopy derives Overdue, Due soon, Complied late. |
| Due Date | Instance | `dueDate` | 2022-04-07 to 2023-03-31. |
| Form Description | Obligation | `forms[]` | 377 blank or "NA". Values are statutory forms ("Form XIV", "ER I") or file names ("Form 8.docx"). |
| Log Sheet Description | Obligation | `logSheets[]` (checklist templates) | 266 blank. Often a file name ("Schedule.docx", "Washing Facilities.xlsx"): templates the owner fills as evidence. |
| Organization | Instance (via Unit) | `unitId` → Company → Group | Single value "Kestrel Metals Group/ Kestrel Aluminium/ Plant": a 3-level path Group / Company / Unit. |
| Location | Unit | `location` path | Single value "India/ West Bengal/ Riverbend": Country / State / City. State decides which state laws apply. |
| Owner | Instance (default from assignment) | `ownerId` | 14 spellings, 12 people case-insensitively (e.g. "surajit dasgupta", "Surajit Dasgupta"). |
| Owner Comments | Instance | first comment on the instance | Mostly "Complied"/"Done". For Not Applicable it holds the justification ("We do not transport compressed gas"). |
| Approvers | Instance | `approverId` | 11 spellings, 10 people. |
| Department | Obligation assignment | `departmentId` | 10 values; "HR" and "Human Resources" are the same. |
| Criticality | Obligation | `criticality` enum | Super Critical 8, Critical 22, High 294 (+4 "HIGH"), Medium 17, Low 79. |

## 3. Requirements this implies

1. **Obligation library**: Acts, obligations, categories, forms and log-sheet templates, reusable across clients.
2. **Entity hierarchy** per client: Group → Company → Unit (plant/site/office), each unit with a Country / State / City location.
3. **Applicability**: an obligation is assigned to a unit (with department, owner, approver) only if it applies; Not Applicable needs a written reason and approver sign-off.
4. **Recurrence**: generate instances per period from a rule (monthly on day N, quarterly at quarter end, half-yearly, annual, one-time, event-driven), on the Indian FY (Apr-Mar) by default.
5. **Maker-checker workflow**: owner submits with date, comment and evidence; approver approves or sends back. The register's "Complied" is the approved end state.
6. **Evidence**: challans, filled forms and log sheets attached to the instance ("Challan Attached for payment made").
7. **Views the Excel already gives users**: a filterable grid by Act, Department, Owner, Criticality, Status, Due Date. Canopy's register must do everything this grid does, plus saved views and bulk actions.
8. **Import**: clients and consultants already hold registers like this; importing one must be a first-class, repeatable flow with cleanup of the dirty values above.
9. **Dashboards** (from the Canopy design): compliance score, overdue, due this week, pending approval, by department/Act/criticality, calendar.

## 4. Gaps the sheet does not answer (defaults chosen in PLAN.md)

- No reminder or escalation rules: default T-7, T-3, due day to owner; +1 and +7 days overdue to approver.
- No score formula: default criticality-weighted on-time score (see `packages/engine/CLAUDE.md`).
- No user roles beyond owner/approver: default roles in `apps/api/CLAUDE.md`.
- No regulatory-change feed: out of scope for v1, library is maintained by the consultant.
- No penalties or consequence data: optional field on Obligation, not in v1 import.

## 5. Import acceptance numbers (use as test fixtures)

The authoritative golden counts, import profiles and per-module assertions are in
[docs/contracts/fixtures.md](../contracts/fixtures.md) §3 to §5 (owned by M0). Headline numbers:
119 obligations; 424 instances raw, **422 after the recommended merges** (once "HR" = "Human Resources",
HRS-CL-014-3059-30387 and HRS-CL-005-3174-30354 each have two rows due 2022-04-30 that collapse to one);
12 owners and 10 approvers after case-insensitive dedupe; 5 criticality levels; 1 company; 1 unit;
raw status split 211 / 201 / 12; zero instances completed after their due date.
All 12 Not Applicable rows and all Complied rows except one carry an Activity Date; Pending rows never do.
Six IDs do not follow the 5-part pattern (ENV-117-0031, INT-FA-1-1 and four INT-H-… IDs), so ID parsing must tolerate them.

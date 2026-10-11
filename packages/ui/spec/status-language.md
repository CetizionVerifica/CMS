# Status and criticality language

Fixed vocabulary. Components render it; the API (engine output) decides which status applies and how many days. A component never computes overdue days or status.

## Instance status → `StatusPill`
| Enum (`DerivedStatus`) | Label | Tone | Dot | Background / text | Lucide icon (optional, `size="sm"` hides) |
|---|---|---|---|---|---|
| `UPCOMING` | Upcoming | neutral | `--muted` | `--neutral-soft` / `--muted` | `CalendarClock` |
| `DUE_SOON` | Due in N days ("Due today", "Due tomorrow" for 0 and 1) | warn | `--warn` | `--warn-soft` / `--warn-ink` | `Clock` |
| `OVERDUE` | Overdue N days ("Overdue 1 day") | crit | `--crit` | `--crit-soft` / `--crit-ink` | `AlertCircle` |
| `SUBMITTED` | Awaiting approval | warn | `--warn` | `--warn-soft` / `--warn-ink` | `Hourglass` |
| `SENT_BACK` | Sent back | crit | `--crit` | `--crit-soft` / `--crit-ink` | `Undo2` |
| `COMPLIED` | Complied | ok | `--ok` | `--ok-soft` / `--ok-ink` | `CheckCircle2` |
| `COMPLIED_LATE` | Complied late | ok | `--warn` (the only mixed case) | `--ok-soft` / `--ok-ink` | `CheckCircle2` |
| `NOT_APPLICABLE` | Not applicable | neutral | none, hollow ring in `--line-strong` | `--neutral-soft` / `--muted` | `MinusCircle` |

Plural rules: "Due in 2 days", "Overdue 12 days". Day counts above 99 show "Overdue 99+ days" with the exact count in the accessible name and tooltip.

Excel mapping (for importer and demos): Excel "Complied" → `COMPLIED` or `COMPLIED_LATE`; "Pending" → `UPCOMING`, `DUE_SOON` or `OVERDUE` by date; "Not Applicable" → `NOT_APPLICABLE`.

## Obligation criticality → `CriticalityTag`
| Enum | Label | Treatment | Why it differs |
|---|---|---|---|
| `SUPER_CRITICAL` | Super critical | Filled `--crit-soft`, text `--crit-ink` 700, `OctagonAlert` icon | Only filled + icon level, so it stands out from Critical without a second red |
| `CRITICAL` | Critical | Outline 1px `--crit`, text `--crit-ink` | |
| `HIGH` | High | Outline 1px `--warn`, text `--warn-ink` | |
| `MEDIUM` | Medium | Outline 1px `--line-strong`, text `--muted` | |
| `LOW` | Low | No border, text `--muted` on `--neutral-soft` | |

Note: the brief writes "Super Critical" in title case (from the Excel). The UI uses sentence case per the copy rule: "Super critical". The enum and importer keep the source spelling.

Shape rule: status is always a round **pill** (999px); criticality is always a squarer **tag** (6px). The two never look alike in a row that shows both.

## Workflow verbs (buttons and audit sentences)
| Action | Button | Audit sentence |
|---|---|---|
| Owner submits | Submit for approval | "Priya Rane submitted for approval" |
| Approver approves | Approve | "Rohit Agarwal approved" |
| Approver sends back | Send back | "Rohit Agarwal sent back: *reason*" |
| Owner requests NA | Request not applicable | "Priya Rane requested not applicable: *justification*" |
| Approver accepts NA | Mark not applicable | "Rohit Agarwal marked not applicable" |
| Reassign | Reassign | "Owner changed from A to B" |
| Due date change | Change due date | "Due date changed from 30 Jun 2027 to 15 Jul 2027" |
| Evidence | Add evidence / Remove | "Added evidence Challan_Apr.pdf" |

Never write "task" for an obligation or instance in UI copy (root vocabulary rule). "My tasks" is acceptable only as the overview card title if Shyam wants it; the spec default is **"My open items"**.

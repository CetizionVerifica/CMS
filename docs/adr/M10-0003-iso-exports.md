# M10-0003: ISO exports

Status: accepted (M10, ISO-11d part 1: the NC log and the risk register) · 2026-10-27

## Context
ISO-11d builds the four ISO export kinds (`ISO_EXPORT_KINDS`) and the ISO part of the client archive
(`docs/iso/model.md` §9). ISO-11e made M10 refuse the kinds until it builds them, and ISO-11b made every ISO kind
answer 403 `FEATURE_NOT_ENABLED` while the add-on is off. M16 has no NC or risk routes yet, and M10 never imports
another module's code, so M10 reads the ISO records through M3's repositories. ISO-11d lands in parts; this ADR
records part 1 and grows with the later parts.

## Decisions
1. **Order of the checks at create.** The role check, then the add-on (403 `FEATURE_NOT_ENABLED`), then whether M10
   builds the kind (400 `VALIDATION`), as ISO-11b set it. `BUILT_KINDS` gains each ISO kind in the part that builds it.
2. **An ISO export takes its list's filters only.** `filters` is the list query of `ISO_EXPORT_FILTERS` (the contract
   checks it). `unitId` and `fy` are refused with 400 `VALIDATION`: the list's `unitId` filter carries the units, and an
   ISO list has no period. The job's `asOf` is the client's today when it is created, and the NC timing and the risk
   review status are the engine's (`nonconformityStatus`, `reviewDue`) on that day.
3. **Read when the job runs, through M3.** The store reads every page of `nonconformities.list` and `riskItems.list`
   with the resolved filters (`me` is the requester) and the requester's unit scope (plan §3.3): `unitScope`'s units
   and the requester's person id, or no scope for a reader who sees the whole client. M3 applies the scope in SQL, the
   named-person rule included. The scope is the one the creating request carried: the worker runs with that request's
   context and does not look the requester's memberships up again, as for every kind. It does re-read the add-on
   (ISO-11b). The filters a list computes rather than stores (`incident`, `overdue`, and `q` over number, description and
   root cause for NCs, or activity, description and impact for risks) are applied by M10 after the read, as the
   contract mock's lists apply them; the rows keep the lists' order (NCs newest first by `reportedOn` then number,
   risks by rating, highest first, then in the order added).
4. **Names, not ids.** People, units, systems, clauses ("ISO 9001 8.7") and statutory obligations print by name,
   archived ones included, since a record keeps naming them. Clauses are the exception: a clause prints by name only
   while it and its standard are live in the account's catalogue, and an archived one prints blank. Codes print as words (model §4.7): sentence case with a
   space for each underscore, with "PPE" and the standard titles as the model's exceptions. A record with no unit of its
   own prints "The whole system".
5. **The NC log.** One row per NC with its record fields, timing, days overdue and open actions. The incident columns
   are the type, the client-local day it occurred, the place, the outcome, the lost days and whether it is reportable.
   The person category is never printed (model §3.11), and no injured person's details exist in the record to print.
6. **The risk register.** It prints the account's significance rule (`FirmSettings.isoRisk`) above the items, as the
   documented significance criteria (14001 6.1.2): the threshold, the legal-link rule when it applies, that an override
   with its reason decides instead, and that the residual rating does not decide it. Each item shows its stored
   `significant`, any override and its reason, its controls in place (with the hierarchy) and its open treatment
   actions. `includeArchived=true` adds archived items with the day they were archived.
7. **The heading says what the file covers.** The account's product name, the title, the client, the as-of day, the
   filters in words, and, for a reader limited to some units, that only their units' records and those naming them
   are in it.
8. **Tests.** The memory store applies the same filters and a model of M3's scope, for the route and worker tests;
   the Postgres tests check M3's scope, every page and the names of archived people on the real tables.

## Part 2: the internal audit report PDF

9. **One audit, checked at create.** `ISO_AUDIT_REPORT_PDF` takes `internalAuditId` only. Create reads the audit through
   `internalAudits.list({ ids, scope })` with the requester's unit scope (plan §3.3: the audit's units, or its
   programme's system's units when it names none, or a person it names) and answers 404 `NOT_FOUND` for an audit that
   is unknown, archived, another client's or out of scope, so nothing is queued. The worker reads it again; if it has
   been archived or left the requester's scope since, the job fails and nothing is stored.
10. **What the report prints.** The audit's plan (state, planned days, reported day, units or "The system's units",
    clauses), its people, the independence note (9.2.2) or, when no auditor is an auditee, a line saying so, the
    summary, every checklist row (clause, unit, result, question, auditor's note, why it was not audited), and every
    finding with its type in the model's words ("Minor nonconformity", "Opportunity for improvement"), the number of
    the NC it raised and its improvement actions. An audit not yet reported is headed as a draft; a cancelled one gives
    its reason. Records only: the PDF computes nothing.
11. **Tests.** Content, the draft and cancelled headings, the independence note, 404 at create, unit scope and the
    named-person rule on the memory store; the same reads, another firm's audit and an archived lead's name on Postgres.

## Part 3: the management review pack PDF

12. **One review, checked at create.** `ISO_REVIEW_PACK_PDF` takes `managementReviewId` only. Create answers 404
    `NOT_FOUND` for a review that is unknown, archived, another client's, or out of the requester's scope (plan §3.3:
    the system's units, or its chair or an attendee, through M3's `managementReviews.list` scope), and computes no
    figures. The worker reads it again with the requester's scope.
13. **Figures by state (model §3.13 item 5).** HELD and CLOSED print the stored copy, never recomputed, headed "Figures
    for <since> to <asOf>, recorded <figuresStoredAt in the client's time zone> (engine <figuresEngineVersion>)"; a row
    without one is headed "No figures: held before the system was set up in the app". PLANNED computes each non-MANUAL
    input through M3's `reviewFigures.gather` and the engine's `reviewInputFigures` as of the client's today when the
    pack is made, with `localDateIn` in the client's time zone and no unit scope, headed "Draft: figures for <since>
    to <asOf>". CANCELLED and MANUAL rows print notes only.
14. **Values for everyone, references for the reader.** Each figure prints its value as the review has it, in the
    words of `FIGURE_WORDS` (one entry per `REVIEW_FIGURE_KEYS` key, as the review screen words them; a key the
    contract does not list prints by its key). Its ids go through M3's `isoVisibleIds` with the requester's unit scope
    and person (none for a client-wide reader) when the job runs, and only those print, as short references: "NC 12",
    an audit's title, an action's text, an obligation with its due date. Where fewer are readable the value says so,
    as the screen does: "2 (1 you can open)".
15. **Incidents withheld.** An INCIDENTS row whose ids the requester cannot all read prints "Figures and notes withheld:
    they count incidents you may not open" with neither its figures nor its notes, unless the requester chairs or
    attends the review (model §3.13 item 4). The test reads the row's ids, not the system's units.
16. **The rest.** The pack prints the review's state, dates, chair, attendees and minutes, then inputs in key order
    with their clause and notes, outputs with their decisions, and the review's actions. The audit report now names
    any auditor who is also an auditee when no independence note was recorded, since only M16's save rule, not the
    database, requires the note (#335 audit Info).
17. **Tests.** Every figure key has words; the memory store covers each state's heading, cut references, withholding
    and its exceptions (chair, attendee, a person named on the incident) and 404 at create; Postgres covers the stored
    figures with a reference of each kind the test seeds, a unit-limited approver, an attendee, figures unchanged after a
    record is archived, a planned review computed through `gather`, and another firm.

## Part 4: ISO data in the client archive

18. **Always there, never computed.** `CLIENT_ARCHIVE_ZIP` writes an `iso/` folder with the add-on on or off, read
    with no unit scope since only an account admin makes the archive (ADR M10-0002 decision 2). Nothing in it is
    computed for the archive: a review's figures are the copy its inputs stored when it was held, and a planned or
    cancelled review has none there.
19. **The two workbooks.** `iso/nc-log.xlsx` is the NC log export with no filters (live NCs, as the log lists them:
    M3's NC list has no archived option) and `iso/risk-register.xlsx` the risk register export with archived items,
    both as of the client's today.
20. **A register of the other records.** `iso/records.xlsx` has one sheet per kind of record, each row the record as
    M3 holds it with one column per field (lists joined with "; ", nested values as JSON), archived rows included where
    M3's list can include them: management systems, context items, the clause checklist, documents of every status and
    their revisions, certifications, external audits, objectives and readings, audit programmes, internal audits,
    their checklists, findings, actions, management reviews, review inputs (with their notes) and outputs. "Review
    figures" holds each stored figure in full, one row per figure and id (so no list outgrows a cell): the review,
    the input and its key, the source, `since`, `asOf`, `figuresStoredAt`, `figuresEngineVersion`, the figure's key,
    value and id. "Names" gives the name of each person, unit, system and clause the ids refer to. A sheet keeps M3's
    field names, so it reads back as the records it came from. No sheet holds an incident: NCs, with their incident
    columns as the NC log prints them, are in the NC log only.
21. **Files as evidence.** Live ISO files scanned CLEAN go under `iso/<subject type>/<subject id>/<file name>` (names
    made safe and numbered on a clash as for evidence) and are listed in `iso/index.csv`; others are counted in the
    README as "Left out", and a file missing from storage as "Not found", apart from the evidence counts (ADR
    M10-0002 decisions 5-6). Removed files stay out.
22. **Tests.** The memory store covers the folder with the add-on on and off, file paths, the index, the README
    counts, the workbooks and the review figures sheet; Postgres covers every sheet with a record of each kind, the
    held review's stored figures with window, recording time and engine version, a removed and a pending file, the
    add-on off, and another firm's archive. The review pack's file name and PDF title now both name the day a review
    was held (#337 audit Info).

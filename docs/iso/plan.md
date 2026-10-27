# ISO management systems add-on: plan (v2)

Status: v2.5.4, 2026-10-27. Decisions: ADR [M16-0001](../adr/M16-0001-iso-management-systems.md), amended by ADRs
[M16-0002](../adr/M16-0002-iso-plan-v2.md) and [M16-0003](../adr/M16-0003-stored-review-figures.md). v2 answers the 58
findings of the independent review of v1 (trace at the end of [packages.md](packages.md)). v2.1 takes in the departures
the ISO contracts (ISO-1, contracts 1.8.0) list in `docs/contracts/README.md` decision 51 (a-n), and points the API,
engine and screen briefs at the M0 mock's own readings in `docs/contracts/iso-mock.md` (trace at the end of
[packages.md](packages.md)). v2.2 adds ISO-1a, the M0 patch (contracts 1.8.1) that fixes the findings of the ISO-1
audit: one action per route, an NC's severity moved to reassignment, and a calendar date for `objectiveProgress`. v2.3
gives ISO states one set of plain words for the screens and the audit trail (model §4.7), adds ISO-12d for them, passes
notes from the ISO-12a and ISO-2c audits to later briefs, and has M6 refuse edits to a STANDARD act and `clauseRefs`
outside the add-on (ISO-9b). v2.4 accepts that those refusals live in the API only, passes on what ISO-2d (#276),
ISO-10a (#277) and their audits leave for later briefs, splits ISO-14 so the catalogue copy is wired as soon as ISO-9
merges (ISO-14a), and gives the jobs a list of the accounts that have a feature (ISO-2f). v2.5 stores a held management
review's input figures once, when the review is recorded held, instead of rebuilding them from the audit trail on every
read (ADR [M16-0003](../adr/M16-0003-stored-review-figures.md); model §1.7, §3.11, §3.13, §4.5, §5.4, §8-§10; plan §3.3,
§7 items 9 and 19; ISO-1a2, ISO-1a3, ISO-2g, ISO-2h, ISO-3b). It also keeps `clauseRefs` out of the obligation bodies,
so only the catalogue copy writes them, and passes on what the audits of ISO-1a (#271), ISO-2e (#280) and ISO-9 (#279)
leave for later briefs. v2.5.1 closes the gaps a check of v2.5 found after it merged (incident, objective-close,
climate-decision and late-finding days; risk kinds per input key; the window's first day; client-local days in M3; the
residual-clear marker's writer) and shows a review's incident figures only to readers who see its whole system or took
part in it (the #291 audit; model §3.11, §3.13, §5.4, §9; plan §3.3; ISO-1a3, ISO-2h, ISO-3b, ISO-6c, ISO-8b, ISO-8c,
ISO-11d). v2.5.2 words the readings ISO-1a3 took where the model was silent (an external audit's moved `endOn`, records
with no trail, a rationale-only climate change; model §3.11, §5.4, §8) and adds ISO-1a4, an `ids` filter on five of the
six ISO lists the overview links to by ids, since the lists are paged (certification keeps its page's own filter: a
client has few certificates) (the #296 audit, Info 4; ISO-6b, ISO-6c, ISO-8b, ISO-8c). It also places what ISO-8a (ADR
M16-0004) and the ISO-2g audit leave to others: ISO-2i, M3's side of the `ids` filter, a role lookup so a client role
can name a firm admin or consultant, and documents found by issuer; the mock's N/A error path in ISO-1a4; `storeFigures`
limits in ISO-2h. Its final review adds ISO-2j, the M3 list filters ISO-8b and ISO-8c need, the person's own state in
the role lookup and two reads the #308 audit asks of M3 for ISO-10c, and moves ADR M16-0004's external-audit decisions 3
and 4 into ISO-8c. v2.5.3 places what the two audits of ISO-8b (#320) leave to others: the ISO file routes join the
integrated security sweep when ISO-14b wires them, and ISO-8c takes three follow-ups (the action list's missing tests, a
risk item's unit move authorized on the new unit, and ADR M16-0005 decision 3's wording). It records that ISO-8a to
ISO-8c are `Tooling:` PRs because each also changes M14's security spec, that ISO-8b already moved the named-person
check onto M3's role lookup (model §1.5), and that ISO-8c and ISO-11d do not wait for ISO-1c. v2.5.4 records what ISO-1c
(#324, contracts 1.8.6) settled: `IsoEngineApi.reviewInputFigures` takes the data of the source it names; `Act.kind` and
`Obligation.clauseRefs` stay optional, because modules that build records from the read types still leave them out, and
`AccountOverride.removedFeatures` because it is only a request body (contracts README decision 56). It adds ISO-1c2,
which makes the mock's overview count overdue nonconformities as the NC list does (the #321 audit), and ISO-1e, which
makes `kind` and `clauseRefs` required once their creators set them (the #324 audit). It also passes on the #322 audit's
notes on ISO-8c's parts and ADR M16-0006's rule for who owns and approves an NC.

Every ISO thread reads, in order: the root `CLAUDE.md`, this file, its own brief in [packages.md](packages.md), the
parts of [model.md](model.md) and [catalogue.md](catalogue.md) its brief names, then the area `CLAUDE.md` of the paths
it changes.

| File | What it holds |
|---|---|
| `plan.md` (this file) | Scope, roles and permissions, on/off behaviour, how the work is split and ordered, package table, acceptance |
| [model.md](model.md) | Tables, fields, references, state machines, engine functions, files, reminders, audit, exports, routes |
| [catalogue.md](catalogue.md) | STANDARD acts, the recurring activity catalogue, clause flags, review inputs and outputs, editions |
| [packages.md](packages.md) | One brief per package, complete enough to hand to a thread on its own; the review trace |

## 1. What it is

An optional add-on for companies that run, or are working towards, certified management systems:

| Standard | Edition in v1 | Topic |
|---|---|---|
| ISO 9001 | 2015 + Amd 1:2024 | Quality |
| ISO 14001 | 2015 + Amd 1:2024 | Environment |
| ISO 45001 | 2018 + Amd 1:2024 | Occupational health and safety |

All three share the same structure for clauses 4 to 10, so one client can run them as one **integrated management
system**: one internal audit, one management review, one nonconformity log and one set of recurring activities cover
every standard the client has chosen. Editions are data (catalogue.md §6).

The add-on is off by default. The platform operator turns it on or off per account in the operator console (§4).
Statutory compliance does not change for an account without it, and its statutory numbers never count ISO work.

## 2. Scope

Already covered by the app (no change): the legal register, which is 14001 and 45001 6.1.3 (compliance obligations),
and the statutory compliance score and evidence, which feed the evaluation of compliance (14001 and 45001 9.1.2).

| Clause area | Feature in v1 of the add-on | Model |
|---|---|---|
| 4.1-4.4 Context, interested parties, scope | **Management system**: standards, scope statement, units, issues and interested parties, the climate-change decision (Amd 1:2024) | model §3.1-3.2 |
| All clauses | **Clause checklist** (gap analysis): one row per assessable clause per standard, owner, notes, files; N/A only where the standard allows it, with approval; clause readiness score | model §3.3, catalogue §4 |
| 5.2 Policy, 7.5 Documented information | **Document control**: controlled documents with code, type, owner, approver, review date, retention (forms); revisions with approval, superseded history, periodic review without change | model §3.4, §4.2 |
| 6.1 Risks and opportunities, 14001 6.1.2 aspects, 45001 6.1.2 hazards | **Risk register** with four kinds: likelihood × severity before and after treatment; aspect impact, life-cycle stage, control or influence; hazard routine or not, people exposed; hierarchy of controls; significance rule with legal link and override; treatment actions | model §3.5 |
| 6.2 Objectives | **Objectives** for one or more standards, linked risks, target, readings, progress, and action plans (what, resources, who, when) | model §3.6 |
| 7.1.5, 7.2, 7.3, 8.1.4, 8.2, 9.1, 45001 5.4 | **Recurring ISO activities** run through the statutory obligation, instance, reminder and evidence workflow; each shipped once | catalogue §2-3 |
| 9.2 Internal audit | **Audit programme** per FY with coverage, **internal audits** with checklist, independence note, report to management, **findings** with improvement actions | model §3.7, §3.9, §4.3 |
| 9.3 Management review | **Management reviews** at planned intervals, inputs and outputs per standard, attendees, minutes, review actions | model §3.13, §4.5, catalogue §5 |
| 10.2, 9001 8.7, 45001 incidents | **Nonconformity log**: raise, containment and correction, disposition, root cause, similar occurrences, risk and system updates, corrective actions, effectiveness check on a date; incidents and near misses with investigation fields | model §3.10-3.11, §4.1 |
| 10.1, 10.3 Improvement | **Actions** on any ISO record: corrective, treatment, objective plan, improvement, review | model §3.12 |
| Certification | **Certificates** (scope, units) and **external audits** (stage 1 and 2, surveillance, recertification, special, transition) covering one or more standards, with recommendation and response deadline; cycle due dates computed from them | model §3.8, §4.4 |
| Overview and reports | ISO overview per client (clause readiness with certification gates, NCs, actions overdue by subject, audit programme coverage, incidents, certificate expiry, next review); NC log and risk register Excel; internal audit report and management review pack PDF; ISO data in the client archive | model §5, §9 |

**Later** (not in v1; keep the model open, do not build): Excel import of existing NC logs, HIRA and aspect registers; a
supplier register with scoring (9001 8.4; in v1 the external-provider activity carries the approved supplier list);
per-person training records (in v1 the competence review carries the training matrix); a customer complaints portal; ISO
27001, 50001 and other standards; moving an existing system to a newer edition (clause mapping, carrying assessments
over); a records retention schedule with automatic disposition; incident frequency rates (LTIFR), which need hours
worked; monitoring indicators with limits that raise NCs from readings; raising an NC from the register's instance
drawer; recording an event-driven statutory instance (such as an accident notice) from an incident; an editable risk
matrix or significance rule; console visibility of a stuck catalogue copy beyond the flag in ISO-5b; a clause picker
that gives an activity staff add under a STANDARD act its `clauseRefs`; a step that retakes a held management review's
stored figures, with a reason (until then a wrong figure is corrected in notes, model §3.13 item 6); a figure window per
standard for a review that covers several standards, and leaving out of a review's figures what the review that set its
`since` already counted on that day (model §5.4).

## 3. Roles and permissions

### 3.1 Roles (no new roles)

| Role | In the add-on |
|---|---|
| Account admin (FA), consultant (CO) | Set-up and record work for the clients they can see, as §3.2 grants it. They do not take the approver's steps (approve a document, verify an NC, decide a clause N/A), nor the steps §3.2 keeps for the people named and client admins: an NC owner's steps, cancelling or reopening an NC, and completing, cancelling or reopening an action |
| Client admin (CA) | Management representative: sets up the system, plans audits and reviews, cancels or reopens NCs, acts as delegate approver (audited `delegated: true`); may take owner, lead-auditor and chair steps as delegate, never a checker step on a record where they took a maker step (model §4) |
| Approver (AP) | Approves documents and clause N/A requests, verifies NC effectiveness, cancels actions on records they approve, approves activity instances |
| Owner (OW) | Does what is assigned: checklist rows, documents as author, risk items, objectives and readings, actions; raises nonconformities, incidents and near misses for their units |
| Viewer (VI) | Reads everything in the add-on within their access (external auditors, time-boxed as today) |

Internal auditors are the people named on an audit (owner role or above). Self-audit needs a recorded independence
note (model §3.7).

### 3.2 `can()` actions

ISO-1 lists these in `docs/contracts/endpoints.md` and ISO-4b adds **one `POLICY` row per action** in
`apps/api/src/auth/policy.ts`. Names are two-part `<resource>.<verb>` in camelCase, because the `Action` regex
(`packages/contracts/src/schemas/context.ts`) allows one dot. There is no `iso*.*` wildcard row: a `<resource>.*` row
gives every verb the same grants (`ruleFor`). "own" means the actor is the person named in that role on the record.

`grantHolds` compares an OWNER with `Resource.ownerId` and an APPROVER with `Resource.approverId` only, and ISO-4b does
not change it. So M16 builds each ISO `Resource` per action (one builder, ISO-8a). For a record with one owner or
approver, those are `ownerId` and `approverId`; for `isoAction.*` they are the subject's owner and approver (and the
action's owner for `isoAction.complete`). A finding of an internal audit takes its audit's lead auditor as owner; a
finding of an external audit has no owner; a management review takes its chair as owner. Findings, management
reviews, risk items and objectives have no approver, so only a client admin cancels their actions. Where "own" names other people (lead or auditor for `isoAudit.conduct`, chair
for `isoReview.write`), M16 sets both `ownerId` and `approverId` to `ctx.personId` when the actor is one of them, and
leaves them unset otherwise. For `isoFile.write`, M16 first checks the subject's own write action and passes the
result the same way. Model §4's Who columns name the person who normally takes a step; this table decides who may
call it (model §4 preamble).

| Action | FA | CO | CA | AP | OW | VI | Covers |
|---|---|---|---|---|---|---|---|
| `<resource>.read` for every resource below | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | reads, lists, files' download URLs (an incident NC's files only for the people model §6 names); the catalogue and the overview, which have no resource of their own, use `isoSystem.read` |
| `isoSystem.write` | ✓ | ✓ | ✓ | | | | systems, scope, units, context items, climate decision, audit programmes |
| `isoChecklist.write` | ✓ | ✓ | ✓ | | own | | status, notes, files of a checklist row |
| `isoChecklist.requestNa` | ✓ | ✓ | ✓ | | own | | REQUEST_NA, WITHDRAW_NA |
| `isoChecklist.decideNa` | | | ✓ | ✓ | | | APPROVE_NA, REJECT_NA (never the requester) |
| `isoDocument.write` | ✓ | ✓ | ✓ | | own | | documents, revisions, SUBMIT, RECORD_EDITION |
| `isoDocument.approve` | | | ✓ | own | | | APPROVE, SEND_BACK, REVIEW, MAKE_OBSOLETE |
| `isoRisk.write` | ✓ | ✓ | ✓ | | own | | risk items, controls, REVIEW, reassessment |
| `isoRisk.override` | ✓ | ✓ | ✓ | | | | significance override |
| `isoObjective.write` | ✓ | ✓ | ✓ | | own | | objectives, readings, closing |
| `isoAudit.plan` | ✓ | ✓ | ✓ | | | | plan, edit and cancel internal audits |
| `isoAudit.conduct` | ✓ | ✓ | ✓ | own | own | | START, checklist, findings, REPORT, CLOSE (own = lead or auditor on the audit) |
| `isoCertification.write` | ✓ | ✓ | ✓ | | | | certificates, external audits and their findings |
| `isoNc.raise` | ✓ | ✓ | ✓ | ✓ | ✓ | | RAISE, for a unit the actor can see |
| `isoNc.work` | | | ✓ | | own | | ADD_ROOT_CAUSE, PLAN_ACTIONS, SUBMIT, SUBMIT_NO_ACTION; the NC's PATCH: every field but owner, approver, dates, severity and incident outcome (description, standards, clauses, unit, source instance, the other incident fields and the investigation fields) |
| `isoNc.reassign` | ✓ | ✓ | ✓ | | | | the NC's reassign route: owner, approver, `dueOn`, `effectivenessDueOn`, `severity` and incident `outcome`, with a reason (model §3.10, §4.1) |
| `isoNc.verify` | | | ✓ | own | | | VERIFY_EFFECTIVE, VERIFY_NOT_EFFECTIVE |
| `isoNc.cancel` | | | ✓ | own | | | CANCEL |
| `isoNc.reopen` | | | ✓ | | | | REOPEN |
| `isoAction.write` | ✓ | ✓ | ✓ | | own | | create and edit actions (own = owner of the subject) |
| `isoAction.complete` | | | ✓ | | own | | COMPLETE (own = action owner) |
| `isoAction.cancel` | | | ✓ | own | | | CANCEL (own = approver of the subject) |
| `isoAction.reopen` | | | ✓ | | | | REOPEN |
| `isoReview.plan` | ✓ | ✓ | ✓ | | | | PLAN, CANCEL; the review's replan route: standards, `plannedOn` and chair while PLANNED |
| `isoReview.write` | ✓ | ✓ | ✓ | own | own | | the review's PATCH (attendees, minutes), inputs, RECORD_HELD, outputs, CLOSE (own = chair) |
| `isoFile.write` | ✓ | ✓ | ✓ | own | own | | upload, confirm, remove: whoever may write the subject |

ISO-1 may split or rename an action where a route needs it, keeping the rules above; the coordinator then corrects
this table (§5.6). ISO-1 (contracts 1.8.0, README decision 51 h and i) added `isoNc.reassign`, so an NC's owner cannot
reassign their own NC or move its dates, and gave the catalogue and overview reads `isoSystem.read`. **One action per
route** (ISO-1a, contracts 1.8.1, README decision 51 o). In 1.8.0 two routes listed two actions. The M0 stub `can()`
allows an action when any endpoint listing it grants the role, so those routes leaked rights (an NC's owner got
`isoNc.reassign`, a review's chair `isoReview.plan`, FA and CO `isoNc.work`); the generic route gate checks only the
first action an endpoint lists, so under M5's per-action policy it would have refused FA and CO on the NC's PATCH (the
ISO-1 audit, Medium 1). Now the NC's PATCH is `isoNc.work` only and `POST .../nonconformities/{id}/reassign` is
`isoNc.reassign`; the review's PATCH is `isoReview.write` only and `POST .../management-reviews/{id}/replan` is
`isoReview.plan`. No ISO route lists two actions.

### 3.3 Unit scope

As for the register and the evidence vault (`docs/contracts/endpoints.md` §1), an approver or owner whose
membership lists `unitIds` sees an ISO record only when:

- its `unitId` is one of their units;
- for a record with a units list (management system, internal audit, certificate), that list overlaps theirs. An
  empty list on an internal audit or certificate means its management system's units. An empty list on a management
  system means every unit of the client;
- a record with no unit of its own (context item, checklist row, document, objective, management review, external
  audit, and a risk item or nonconformity whose `unitId` is null) takes its management system's units; or
- it names them as owner, approver, lead auditor, auditor, auditee, reported-to, chair, attendee or investigator.

The current approved revision of a system document, and its file, stays readable by every member of the client
whatever their units (model §4.2, §6).

A child record (finding, action, revision, reading, checklist item, control, file) takes its parent's units. M16
applies the rule in the SQL of every ISO list, in the overview counts and in the ISO exports, not only on
single-record reads. `can()` checks the unit part: ISO-1 adds an optional, non-empty `Resource.unitIds`, and ISO-4b
makes `inScope` require an overlap when it is present. M16 passes `unitIds` for multi-unit records and, for a record
without its own unit, its management system's `unitIds` when that list is not empty (never a missing unit), and
checks the named-person exception itself. So with two systems in one client (plant A on 9001, plant B on 14001 and
45001), an owner of plant A sees none of plant B's system records.

One exception: a management review's input figures cover its whole system. Every reader of the review sees each value,
and each figure's ids list only the records that reader may read (model §3.13). The values include other units' NCs,
incidents with their outcomes and lost days, audit results and the statutory score; they are counts and sums with no
names, and a reader limited to some units sees them for the review as a whole. The exception stops at incidents: a
reader who may not read every incident the INCIDENTS row counts, and who is neither the review's chair nor an attendee,
gets that row with `figuresWithheld` and without its figures or notes, on screen and in the pack, since an outcome and
its lost days can point to a person (model §3.11, §3.13 item 4). M3 gathers the figures without the caller's unit scope
(ISO-2h), for M16 and for M10's pack of a PLANNED review; no other ISO read does.

### 3.4 People

Every person named on an ISO record must hold a live role in the record's client covering its unit (model §1.5).
Incident records hold no injured person's name or health detail outside files (model §3.11).

## 4. Turning the add-on on and off

### 4.1 The switch

- Feature flag `isoManagement`, listed in `KNOWN_FEATURES` (contracts 1.7.0).
- **Operator console (M15, ISO-5):** the account page has an **Add-ons** card with one switch per known feature. A
  switch needs a reason and writes `PUT /accounts/{id}/override`; the change is an `OVERRIDE_CHANGE` operator audit
  event mirrored into the account's trail. `AccountOverride.removedFeatures` lets a switch turn off a feature the plan
  includes. The console rebuilds the override from what it can read (`overrideFrom` in
  `apps/operator/lib/account-actions.ts`), so it derives `removedFeatures` as the plan features missing from the
  entitlements, and the switch and the "Override limits" drawer each change only their own part and never wipe the
  note, which the console reads from the latest `OVERRIDE_CHANGE` operator audit event (`noteFrom`) because the API
  has no override read (ISO-5, merged). The drawer's free-text features field leaves known features alone: it
  neither shows nor sends them. The server keeps a known flag's stored state when the body names it in neither
  `features` nor `removedFeatures`, and the switch always names the flag it changes, in `features` when on and in
  `removedFeatures` when off, whether or not the plan includes it (ISO-5b).
- **Customer side:** `Me.account.features` lists the account's features (ISO-4a); the Account page shows each add-on
  as On or Off (ISO-12b); nobody in the account can change it.
- **Plans:** no plan includes `isoManagement` by default. The operator may add it to a plan; that is a change of
  effective features like any other (§4.3).

### 4.2 Effective features, and when a switch takes effect

- Features = (plan features ∪ override features) − removed features (`effectiveFeatures` in contracts). M3 computes
  it in exactly two reads, `app_account()` (which the API and jobs read) and `platformAccounts.entitlements` (which the
  console reads), changed together in ISO-2a with db tests on both sides. Both reads repeat the formula in SQL
  (0036), so ISO-2c moves both onto one IMMUTABLE SQL function, `canopy_effective_features(plan, added, removed)`, that reads
  no table. No other module computes features.
- A switch takes effect on the **next request**, without ending sessions, as `ACCOUNT_SUSPENDED` does (ADR M15-0001
  decision 4). `requireFeature` (ISO-4a, merged) reads the account's features fresh on every gated request through
  M3's `account.features(tx)` (a features-only read of `app_account()`, ISO-2a), in its own short lookup transaction
  (`AuthStore.accountFeatures`), never from `Me`, the session or an in-process cache. Jobs read them per firm per run
  (`FirmTx.accountFeatures()`, with the copy time, ISO-10a). Consumers and the export worker re-read them when they handle a
  queued event or export, so work queued before a switch-off is not sent or produced after it (ISO-10b, ISO-11b).

### 4.3 Turning it on: the catalogue copy

The first time an account has `isoManagement`, M6's `copyIsoCatalogue(db, accountId, requestId)` copies the ISO
catalogue (catalogue.md §1) into it.

- **Event.** `account.features_changed { accountId, added: FeatureFlag[], removed: FeatureFlag[] }` is an account
  outbox event (docs/contracts/events.md "Accounts", producer M15, consumer M9). M15 writes it through
  `platform_record_account_event` in the same transaction as the change, whenever an account's effective features
  change: from the override route, from the plan-change route, and from a plan edit, once for each account on that
  plan whose features change (ISO-5b).
- **Consumer and sweep.** M9 consumes the event and, when `added` has `isoManagement`, calls the copier through a
  `JobDeps` port (`IsoCatalogueCopier`, like `LibraryCopier`). A sweep every 10 minutes also calls it for every TRIAL
  or ACTIVE account whose features include `isoManagement` and whose copy is not recorded; that covers an account
  created on a plan that has the flag, and a missed delivery (ISO-10a). `wiring.ts` injects the copier (ISO-14a, as
  soon as ISO-9 and ISO-10a have merged: until then a switch-on fails its retries and the sweep logs an error every
  10 minutes, and nothing is lost). From ISO-10b the sweep lists only the accounts that have the feature, through
  M3's `listFirmIdsWithFeature` (ISO-2f), instead of reading every account.
- **Marker.** The copy runs in the account's system context and records itself with
  `app_mark_iso_catalogue_copied()`: a SECURITY DEFINER function owned by `canopy_platform`, callable only in the
  account's own system context, which sets `firm.iso_catalogue_copied_at` once and returns whether it set it. It works
  in TRIAL and ACTIVE (unlike 0023's `app_mark_library_copied`, which needs PROVISIONING, and the app role cannot
  update that column). The copier marks first, in the same transaction as the copy, so a concurrent second copy
  waits on the row and then copies nothing, and a failed copy rolls the marker back and is retried. Turning the
  feature off and on again copies nothing more (ISO-2c, ISO-9). M5 and M9 read the marker through M3's
  `account.isoCatalogueCopiedAt(tx)` (ISO-2c), which reads the firm row like `account.libraryCopied`.
- **Until the copy is recorded** every `/iso` route answers `409 FEATURE_NOT_READY` (ISO-4c's message), ISO screens
  show "ISO management systems is being set up. Try again in a few minutes.", and ISO jobs skip the account. The console
  shows the copy time and flags a TRIAL or ACTIVE account whose copy is still missing 15 minutes after the later of
  the switch-on and its move into TRIAL or ACTIVE, since the marker sets nothing in other statuses (ISO-5b).

### 4.4 Turning it off

**Off hides and refuses; it never deletes.** ISO data means: every row of the ISO tables (model.md), the STANDARD acts
with their obligations, assignments and instances, the comments, evidence and audit history of those instances,
`iso_file` rows, and the ISO export kinds. While the add-on is off:

- every `/iso` route answers `403 FEATURE_NOT_ENABLED`, reads included, file routes included;
- any other route that names an ISO item by id answers the same 403 (the table in §4.5);
- every list, count, score, calendar, report, export, digest, reminder and email leaves ISO data out; bulk approve
  refuses ISO instance ids per item;
- ISO activity instances are not generated; ISO screens and the sidebar group are hidden, and a direct ISO URL shows
  "ISO management systems is not turned on for your account" with no data (ISO-7 in the shell, ISO-6a in
  `iso/layout.tsx`);
- the client audit trail (`/clients/{clientId}/audit`) keeps listing ISO events, and the client archive
  (`CLIENT_ARCHIVE_ZIP`, the account export one client at a time) always includes ISO data;
- `act.kind` cannot be used to get round the switch: it is set at insert and a trigger refuses any change, only the
  system-job context may insert a STANDARD act, the library create and update bodies take no `kind`, and M6 refuses
  merges and obligation moves across kinds (ISO-2c, ISO-9b);
- M6 also refuses any edit or merge of a STANDARD act, whose values are fixed (catalogue §2); there is no act-archive
  route, and the merge route, which archives its source acts, refuses a STANDARD source. Only the catalogue copy writes
  `clauseRefs` in v1: the contracts' obligation create and update bodies are strict and have no such field, so a body
  that names it answers 400 `VALIDATION` whatever the act's kind and whatever the switch, and an activity staff add
  under a STANDARD act has no clause references. The database allows all of these to staff (ISO-2c), and that is
  accepted: the act refusals keep the catalogue's shape and are M6 route checks guarded by ISO-9b's route tests, and the
  `clauseRefs` refusal is the contract's own. In the database, `act.kind` cannot be used to get round the switch (it
  never changes, and only the system job inserts a STANDARD act); the switch itself, and merges and moves across kinds,
  are refused in the API.

Turning it back on brings everything back as it was. The account purge (ADR M15-0002) removes ISO rows and files like
any other client data.

### 4.5 Where the off switch is enforced

| Module | Gate when off | Package |
|---|---|---|
| M16 | every `/iso` route, files and overview included: 403; `409 FEATURE_NOT_READY` before the copy | ISO-8a-c |
| M6 | library acts and obligations (list, by id, push, merge) leave out or refuse STANDARD rows; assignments (list, create, bulk, by id) leave out or refuse those on STANDARD obligations | ISO-9b |
| M7 | instance list, `/me/approvals`, `/me/tasks`, evidence vault leave out STANDARD instances; instance get, patch and transitions, bulk approve (per item), comments, evidence upload, list, download and remove, instance audit answer 403 for a STANDARD instance | ISO-11a |
| M9 | generate-instances, reminders, escalations, consultant digest, workflow emails skip STANDARD instances; ISO reminders skip the account; the ISO file scan runs whether the add-on is on or off, so files uploaded before a switch-off still reach the client archive | ISO-10b, ISO-10c |
| M10 | portfolio, overview, breakdowns, calendar, act-wise, department-wise and overdue reports, register export and certificate PDF leave out STANDARD instances; ISO export kinds answer 403 on create and download; the export worker re-checks | ISO-11b, ISO-11d |
| M12 | register, approvals, calendar and evidence screens show the Source filter only when on | ISO-11c |
| M13 | portfolio and overview register links carry `source=LAW` when on | ISO-12c |
| M11, M17 | sidebar group hidden; `FeatureNotEnabled` on a direct URL | ISO-7, ISO-6a |

### 4.6 Statutory numbers never count ISO activities

With the add-on on or off, the statutory compliance score, KPIs, breakdowns, the act-wise, department-wise and
overdue reports, the certificate PDF and the consultant digest read STATUTE-act instances only (ISO-2f gives the
reads an act-kind filter; ISO-10b, ISO-11b use it). When the add-on is on, the instance list, `/me/approvals`,
`/me/tasks`, the vault and the calendar take a `source` filter (`LAW` = STATUTE acts, `ISO` = STANDARD acts; absent =
both), and overview numbers link to the register with `source=LAW` (ISO-12c) so a number always equals its filtered
list.
ISO has its own scores (model §5.1).

## 5. How the work is split and ordered

### 5.1 Staging rule for database-backed enums and new fields

`EntityType`, `NotificationKind`, `ExportKind` and `AuditAction` are Postgres enums built from the contract enums
(`packages/db/src/schema/enums.ts`), so the db drift test fails if contracts list a value before a migration stores
it, and exhaustive maps in other modules stop compiling. The order is always:

1. **M0 stages** the values as separate constants, outside the contract enum (`ISO_ENTITY_TYPES` in 1.7.0, updated
   by ISO-1 to the v2 list in model §8; `ISO_NOTIFICATION_KINDS` and `ISO_EXPORT_KINDS` in ISO-1).
2. **M3 stores** them (`ALTER TYPE ... ADD VALUE`), adds them to the `new Set([...X.options, ...])` unions in
   `enums.ts` with a comment, and lists them in the "ahead" rows of `packages/db/test/schema.test.ts` (ISO-2b), as was
   done for `account`, `CLIENT_ARCHIVE_ZIP` and `TRIAL_ENDING`.
3. **M13 labels** the entity types in the audit page's `ENTITY` map
   (`apps/web/app/(shell)/c/[clientId]/audit/audit-model.ts`), keyed ahead of the contracts (ISO-12a).
3a. **M10 opens its export switch** (ISO-11e). `buildFile` in `apps/api/src/modules/reports/service.ts` switches over
   every `ExportKind` with no `default`, so a new contract value would stop `apps/api` compiling (TS2366) in a file M0
   cannot edit. As contracts 1.5.2 (#212) needed M10's default branch before `CLIENT_ARCHIVE_ZIP` joined, M10 adds a
   `default:` branch and refuses at create a kind it does not build, before ISO-1b joins `ISO_EXPORT_KINDS`.
4. **M0 joins** them into the contract enums (ISO-1b). No ISO route writes an `AuditEvent` with an ISO entity type,
   and no `can()` resource names one, before ISO-1b merges.

New fields on existing shapes arrive **optional**, with the meaning of a missing value written down (a missing
`Act.kind` reads as STATUTE, a missing `clauseRefs`, `removedFeatures` or `features` as empty). `.default()` alone is
not enough, because `NewEntity<T>` and the create callers in M6 and M8 use the output type. A field becomes required
only in a later contracts bump, after its column exists and every provider and create caller sets it. ISO-1c (#324,
contracts 1.8.6) checked: M3 sends `kind` and `clauseRefs` on every read, but M6's master library (`master-data.ts`,
`from-register.ts`), its `NewRow<T>` and `createObligation`, M8's import commit (an obligation's `clauseRefs`) and test
builders in M3, M6 to M10 and M16 build records from the read types without them, and `removedFeatures` is only on the
override's request body, where a missing list means none. So all three stay optional for now (contracts README
decision 56). ISO-1e makes `kind` and `clauseRefs` required once those creators and builders set them; `removedFeatures`
stays optional. `features` lives on `AccountSummary` as an optional field (1.7.0), so `AccountView`, which spreads its
shape, keeps compiling.

### 5.2 New error codes

A new error code reaches M5's message table before the contracts list it (`apps/api/src/auth/errors.test.ts` checks
every contract code has a message), as #248 did for `FEATURE_NOT_ENABLED`. The add-on has one more:
`FEATURE_NOT_READY` (409), whose message lands in ISO-4c before ISO-1 lists it. Guards and wrong states use the
existing `VALIDATION` (400), `REASON_REQUIRED` (422) and `INVALID_TRANSITION` (409); ISO-1 widens
`ERROR_DETAILS.INVALID_TRANSITION` with a member for ISO machines (`{ entity, from, action }`).

### 5.3 One package, one module

The module-paths guard reads the first `M<n>` of a PR title and fails any file outside that module's paths, so each
package below belongs to exactly one module and its PRs are titled `M<n>: ISO ...`. Shared files
(`apps/api/src/server.ts`, the app `package.json` files, the lockfile, `docs/adr/`) may be touched by any package. Files
no module owns (`apps/api/src/wiring.ts`, `apps/api/src/main.ts`, `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md`) change
only in a PR with no module prefix, titled `Tooling: ISO ...`, as earlier wiring changes were (#196, #208, #220, #239).
ISO-14a (the catalogue copy) and ISO-14b (ISO files) are those packages. ISO-8a, ISO-8b and ISO-8c are titled
`Tooling: ISO ...` too (#305, #320): each mounts M16 routes that leave `UNMOUNTED` in M14's
`e2e/integrated/04-security.spec.ts`, so the same PR adds them to that spec's sweeps, and ISO-14b does the same for the
ISO file routes. ISO-1c2 and ISO-1e are `Tooling: ISO ...` as well: ISO-1c2 changes M0's mock with M17's `iso-data.json`
(the snapshot of that mock which M17's component tests read) and M17's overview link to overdue NCs, and ISO-1e changes
the contracts with the creators and test builders of other modules. A `Tooling:` title switches off the module-paths
guard, so the audit of each `Tooling: ISO ...` PR holds it to its brief's Paths, as the #305 and #320 audits did (the
#322 audit).

### 5.4 Start order

- **Start a package only when every package in its Needs column has merged.** `tooling/scripts/plan-wave.mjs` gates
  modules, not packages: with M0 to M15 merged it lists M16 and M17 as startable at once, and it never lists ISO
  packages in modules that have already merged. The coordinator starts ISO packages by the table in §6, whatever
  plan-wave prints, and uses plan-wave only to check path overlaps.
- **One thread per module at a time.** Two packages of the same module never run at once (they would edit the same
  paths, and two M3 migrations in flight collide on `migrations/meta/_journal.json`). When several are startable, the
  one listed first in §6 goes first.
- M17's `e2e/tests/iso/`, M11's `e2e/tests/shell/`, M12's `e2e/tests/register/` and M13's `e2e/tests/overview/` lie
  inside M14's `e2e/`. A package that changes files there and an M14 thread may run at the same time only while the
  M14 thread does not touch those files (§5.5).
- Up to five threads at once, as for the main build, not counting ISO-1a, ISO-1a2, ISO-1a3, ISO-1a4, ISO-1c, ISO-1c2 and
  ISO-1e, which continue the ISO-1 thread: six run while one of them is open, and another package starts only when fewer
  than five of the others run. Each thread marks its PR ready only when it expects it to pass, gets it audited in a
  separate session, and merges `main` before marking ready.

### 5.5 Merging main

The "Harden the app for launch" thread finished on 2026-10-25, so no ISO package waits for it. Every package merges
`main` before marking ready. Packages that change files under `e2e/` (ISO-6a-c, ISO-7b, ISO-8a-c, ISO-11c, ISO-12b,
ISO-12c, ISO-13, ISO-14b) check that no open M14 PR touches the same files; if one does, the coordinator sequences the
two.

### 5.6 Changing this plan

After v2 merges, only the ISO planning thread ("Add ISO management systems module") changes `docs/iso/`, through
`Tooling:` PRs. A module thread whose work has to depart from its brief (a renamed action, a staged value, a changed
order) says so in its PR description, does not edit `docs/iso/`, and tells the coordinator, who has the plan updated
before any package that depends on the change starts.

## 6. Packages and waves

Briefs: [packages.md](packages.md). Waves are for orientation; the Needs column decides. Status as of 2026-10-27
(`origin/main` at #324). ISO-3 and ISO-7b started before ISO-1a was added to their Needs, and merged after it. ISO-6b
may start before ISO-1a4 but marks its PR ready only once ISO-1a4 has merged (its brief), which the Needs column cannot
hold.

| Wave | Package | Module | Title | Needs | Status |
|---|---|---|---|---|---|
| I0 | ISO-0 | M0 | Feature contracts (contracts 1.7.0) | plan v1 | merged (#247) |
| I1 | ISO-2a | M3 | Store add-on switches and the ISO library columns | ISO-0 | merged (#253, #258) |
| I1 | ISO-7 | M11 | Gate the shell on the ISO add-on | ISO-0 | merged (#254, #257) |
| I1 | ISO-4a | M5 | Check the add-on feature on requests | ISO-0 | merged (#255, #259) |
| I1 | ISO-5 | M15 | Add an add-ons switch to the operator console | ISO-0, ISO-2a | merged (#252) |
| I2 | ISO-4c | M5 | Message for FEATURE_NOT_READY ahead of the contracts | ISO-4a | merged (#261) |
| I2 | ISO-12b | M13 | Show add-ons on the Account page | ISO-0, ISO-7 | merged (#262) |
| I2 | ISO-1 | M0 | ISO contracts (shapes, endpoints, events, engine API, fixtures, mock) | ISO-0, ISO-4c | merged (#265) |
| I3 | ISO-1a | M0 | ISO contract fixes from the ISO-1 audit (contracts 1.8.1) | ISO-1 | merged (#271) |
| I3 | ISO-1a2 | M0 | Stored review figures and the ISO-1a audit fixes (contracts 1.8.2) | ISO-1a | merged (#284) |
| I3 | ISO-2b | M3 | Stage ISO enum values and give the send log an ISO subject | ISO-1, ISO-2a | merged (#272) |
| I3 | ISO-3 | M4 | ISO engine functions and transition tables | ISO-1, ISO-1a | merged (#270) |
| I3 | ISO-7b | M11 | Mock features per demo user for ISO screens | ISO-1, ISO-1a, ISO-7 | merged (#269) |
| I3 | ISO-12a | M13 | Audit trail words for ISO entity types | ISO-1, ISO-12b | merged (#268) |
| I3 | ISO-11e | M10 | Default branch in the export builder ahead of new export kinds | ISO-1 | merged (#267) |
| I3 | ISO-11c | M12 | Source filter on register, approvals, calendar and evidence screens | ISO-1, ISO-7b | merged (#290) |
| I3 | ISO-6a | M17 | ISO screens 1: gate, overview, systems, checklist, documents, certification | ISO-1, ISO-7, ISO-7b | merged (#296) |
| I3 | ISO-2c | M3 | Library guards, clause references and the catalogue marker | ISO-2b | merged (#273) |
| I3 | ISO-12d | M13 | ISO states in words on the audit trail page | ISO-12a | merged (#275) |
| I3 | ISO-1b | M0 | Join the staged ISO enum values | ISO-1a, ISO-2b, ISO-12a, ISO-11e | merged (#294) |
| I3 | ISO-16 | M8 | Import matches and creates STATUTE acts only | ISO-2c | merged (#287) |
| I3 | ISO-5b | M15 | Features-changed event and copy status in the console | ISO-1, ISO-2c, ISO-5 | merged (#285) |
| I4 | ISO-1a3 | M0 | Review figures: step days, figure keys, nothing before set-up, withheld incidents | ISO-1a2, ISO-1b | merged (#306) |
| I4 | ISO-1a4 | M0 | An `ids` filter on the ISO lists the overview links to | ISO-1b | merged (#313) |
| I4 | ISO-2d | M3 | ISO tables 1: catalogue copy, systems, checklist, documents, certification, files | ISO-2c | merged (#276) |
| I4 | ISO-4b | M5 | ISO policy rows, `hasFeature`, readiness and multi-unit scope | ISO-1a, ISO-2c, ISO-4c | merged (#281) |
| I4 | ISO-10a | M9 | Copy the ISO catalogue when the add-on comes on | ISO-1, ISO-2c | merged (#277) |
| I4 | ISO-3b | M4 | As-of date reads for review figures | ISO-3, ISO-1a3 | merged (#315) |
| I4 | ISO-6b | M17 | ISO screens 2: risks, objectives, actions | ISO-6a, ISO-1b | merged (#311) |
| I4 | ISO-12c | M13 | Statutory numbers link to Law only | ISO-1, ISO-11c, ISO-12a | merged (#298) |
| I4 | ISO-9 | M6 | ISO catalogue as code and `copyIsoCatalogue` | ISO-2d | merged (#279) |
| I4 | ISO-2e | M3 | ISO tables 2: risks, objectives, actions, audits, NCs, reviews | ISO-2d | merged (#280) |
| I4 | ISO-15 | M7 | ISO file service (`IsoFiles`) | ISO-1b, ISO-2d | merged (#301) |
| I5 | ISO-8a | M16 | ISO API 1: gate, audit gate test, systems, checklist, documents, certification, files | ISO-1b, ISO-2d, ISO-3, ISO-4b | merged (#305) |
| I5 | ISO-2f | M3 | Act-kind and feature-aware reads, accounts by feature | ISO-2e | merged (#282) |
| I5 | ISO-2g | M3 | Stored review figure columns and live-only review-row keys (migration) | ISO-2e, ISO-1a2 | merged (#299) |
| I5 | ISO-2h | M3 | Review figure reads: gather, store, visible ids, rows that follow a replan | ISO-2g, ISO-1a3 | merged (#316) |
| I5 | ISO-2i | M3 | `ids` on four ISO lists; role lookup for people named by client roles; documents found by issuer | ISO-2e | merged (#304) |
| I5 | ISO-2j | M3 | More ISO list filters; the person's own state in the role lookup | ISO-2i | merged (#310) |
| I5 | ISO-6c | M17 | ISO screens 3: audits, nonconformities, management reviews | ISO-6b, ISO-1a3, ISO-1a4 | started (part 3a, #321) |
| I5 | ISO-8b | M16 | ISO API 2: risks, objectives, actions | ISO-8a, ISO-2e, ISO-1a4, ISO-2i, ISO-2j | merged (#320) |
| I5 | ISO-8c | M16 | ISO API 3: internal audits, external-audit findings, nonconformities, management reviews, overview | ISO-8b, ISO-2h, ISO-3b, ISO-2i, ISO-2j | started (part 1 merged, #323; part 2, #325) |
| I5 | ISO-9b | M6 | Hide and refuse STANDARD library rows when off; no cross-kind changes | ISO-9, ISO-2f, ISO-4b | merged (#300) |
| I5 | ISO-11a | M7 | Source filter and the off switch on instances and evidence | ISO-15, ISO-2f, ISO-4b | merged (#312) |
| I5 | ISO-10b | M9 | Off switch in the existing jobs, STATUTE-only digest, ISO file scan | ISO-10a, ISO-1b, ISO-2d, ISO-2f | merged (#308) |
| I5 | ISO-14a | none (`Tooling:`) | Wire the ISO catalogue copy | ISO-9, ISO-10a | merged (#283) |
| I5 | ISO-11b | M10 | Statutory numbers exclude ISO; off switch | ISO-1b, ISO-2e, ISO-2f, ISO-4b, ISO-11e | merged (#309) |
| I6 | ISO-10c | M9 | ISO reminders | ISO-10b, ISO-2e, ISO-3, ISO-2j | merged (#318) |
| I6 | ISO-11d | M10 | ISO exports and ISO data in the client archive | ISO-11b, ISO-3, ISO-3b, ISO-2h | started (part 1 merged, #319) |
| I7 | ISO-14b | none (`Tooling:`) | Wire ISO files | ISO-8c, ISO-10c, ISO-14a, ISO-15 | |
| I7 | ISO-13 | M14 | Integrated ISO journey and off-switch sweep | every other package | |
| I7 | ISO-1c | M0 | Type the engine API's review figures; keep three add-on fields optional | ISO-1b, ISO-2c, ISO-4a, ISO-5, ISO-5b, ISO-9, ISO-16, ISO-3b | merged (#324) |
| I7 | ISO-1c2 | M0 | The mock's overview counts overdue nonconformities as the NC list does | ISO-1c, ISO-6c | |
| I7 | ISO-1e | M0 | Require `Act.kind` and `Obligation.clauseRefs` once their creators set them | ISO-1c, ISO-1c2, ISO-8c, ISO-11d | |

Modules with ISO packages: M0, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13, M14, M15, M16, M17, and Tooling.

## 7. Acceptance (the auditor checks the items that apply to each package)

1. Tenant isolation test for every new table, catalogue copies and join tables included; every table with `firm_id`
   is in `canopy_purge_tables()`; the purge removes every ISO row and every ISO file of a deleted account.
2. Every ISO state change writes an `AuditEvent` in the same transaction. M16 ships its own gate,
   `apps/api/src/modules/iso/audit-gate.db.test.ts`, modelled on M7's `apps/api/src/modules/instances/
   audit-gate.db.test.ts` but on M16's own fixtures under `apps/api/src/modules/iso/testing/` (no import from M7). An
   `onRoute` probe over every route M16 registers, reads and file routes included, must match one row; each row
   asserts the exact `AuditEvent`s and outbox events a successful request writes, and that a refused request (feature
   off, wrong role) writes none. A new ISO route without a row fails it. M7's gate does not cover ISO routes. File
   routes reach M7's code only through the `IsoFiles` port, which M16's tests fake: their rows assert that a
   successful request calls the port once with the right subject and that a refused request does not call it. The
   file `AuditEvent`s each port call writes are asserted in ISO-15's db tests and end to end in ISO-13.
3. With the feature off: every ISO route answers 403 `FEATURE_NOT_ENABLED`; every route in §4.5 refuses or leaves out
   ISO items; an M14 test calls every `ENDPOINTS` entry with an ISO fixture id (ISO record, STANDARD act, obligation,
   assignment, instance, ISO file) and expects 403 or no ISO item; no reminder, escalation, digest line or workflow
   email mentions ISO work. With it back on, all data is unchanged. The next request after a switch sees it.
4. Turning the feature on copies the catalogue once, whether through an override, a plan change or a plan edit, with
   the event delivered twice and the sweep running at the same time; ISO routes answer 409 `FEATURE_NOT_READY` until
   the copy is recorded.
5. Engine: coverage 95%, and 100% on `src/iso-score.ts` and `src/iso-status.ts`; explicit-value tests for risk rating
   and significance (threshold, legal link, override), clause readiness (N/A on a 14001 or 45001 clause scores 0, an
   unapproved N/A scores 0, an approved N/A on a 9001 `exclusionAllowed` clause is excluded, clauses 1-3 and heading
   clauses are not scored), certification gates on both sides of the 12-month boundary, a clause marked NOT_AUDITED
   not counting as covered, climate gaps (each kind of risk item, context item missing), the certification cycle
   with an audit from the previous cycle (not met) and a late surveillance (met late), a rejected N/A restoring the
   earlier status and a withdrawn N/A scoring again, and every arrow of every machine in model §4; an M4 ADR and an
   `ENGINE_VERSION` bump.
6. API and engine tests cover every arrow of the NC table, including RAISE per role, SUBMIT_NO_ACTION refused for
   MAJOR and EXTERNAL_AUDIT, SUBMIT refused when every action is cancelled, VERIFY_NOT_EFFECTIVE back to OPEN, an
   INCIDENT that cannot reach ROOT_CAUSE_FOUND without a risk review; after VERIFY_NOT_EFFECTIVE to ACTIONS_PLANNED,
   SUBMIT is refused until a new action is DONE and VERIFY_EFFECTIVE is refused before the new `effectivenessDueOn`;
   a client admin who took ADD_ROOT_CAUSE or SUBMIT on an NC cannot verify it.
7. Clause 4.1 cannot be set to IMPLEMENTED while the climate decision is undecided; changing the decision is audited,
   and once decided it cannot return to undecided.
8. An ISO file is scanned, downloadable only when CLEAN, included in the client archive, and removed by the purge; a
   file cannot be added to or removed from a locked subject by any role; a locked subject also refuses field edits
   (model §1.8); a file cannot be attached to another client's record (foreign-key test); a viewer and an owner of the
   unit who is not named on an incident NC cannot download its files.
9. Role × unit-scope tests: an owner and an approver limited to unit A get 404 or nothing for unit B's NCs (incidents
   included), actions, risk items and internal audits in lists, single reads, overview counts and exports, and still see
   a unit-B audit where they are named. A management review's figures are the one exception: their values cover the
   whole system, and only their ids are cut, except that such a reader who neither chairs nor attends the review, and
   may not read every incident counted, gets the INCIDENTS row's figures and notes withheld (§3.3, item 19).
10. A person without a live role in the client is refused on every person field; a client-A record cannot reference a
    client-B unit, instance or ISO record (foreign-key test).
11. A consultant context cannot write catalogue rows, cannot insert a STANDARD act, and no context can change
    `act.kind`; merges and obligation moves across kinds are refused; staff cannot edit or merge a STANDARD act, and
    no obligation create or update sets `clauseRefs` (400); import never matches a STANDARD act.
12. Every activity in catalogue §3 exists exactly once, under the act catalogue §3 names, and its `clauseRefs` name
    every standard it serves (for example the emergency drill: 14001 8.2 and 45001 8.2; calibration: 9001 7.1.5,
    14001 9.1.1, 45001 9.1.1).
13. Two ISO reminders to one person on the same day are two emails, and a second run sends neither again.
14. Statutory scores, KPIs, the digest and golden counts are unchanged for an account without the add-on, and unchanged
    by ISO activity instances for an account with it.
15. No ISO standard text in the repo: clause numbers and titles, with summaries in our own words.
16. Fictional names only in fixtures, tests and demos (`tooling/scripts/check-client-names.mjs`).
17. New screens checked in light mode at 1280 and 375, keyboard-only, axe-clean; every ISO page has loading, empty,
    error, no-permission, not-turned-on and being-set-up states.
18. The root definition of done, and the staging order of §5.1 (no contract enum value before its migration).
19. A held management review's input figures are stored once, at RECORD_HELD, with the engine version, and never change:
    an NC closed or cancelled afterwards, a re-rating, an archive, a new reading or a new engine version leaves them as
    they are, and the database refuses any change to them, or to the row's review, definition or archive, once they are
    set. Every reader sees the same values, with the ids cut to what that reader may read, except the INCIDENTS rows
    withheld under §3.3. A PLANNED review's figures are computed as of today, and a CANCELLED review has none; from
    ISO-1a3, neither does a review held before its system's `createdOn` (model §3.13).

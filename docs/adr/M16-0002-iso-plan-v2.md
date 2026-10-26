# M16-0002: ISO add-on plan v2

Status: accepted, 2026-10-25; amended by [M16-0003](M16-0003-stored-review-figures.md). Amends
[M16-0001](M16-0001-iso-management-systems.md). Plan: `docs/iso/plan.md` (v2),
with `model.md`, `catalogue.md` and `packages.md` beside it.

## Context

Plan v1 merged on 2026-10-25 with ISO-0 (contracts 1.7.0, PR #247) following it. An independent review then found 58
problems (C1-C58), each confirmed by a second reader: work that no module could do under the path guard, contract
changes that would turn `main` red, an evidence design that the scan job and the archive could not serve, reminders
the send log would merge, a catalogue copy with no trigger, an off switch that left ISO data reachable, and gaps
against what certification bodies check (clause exclusions, NC steps, incidents, risk register fields, actions,
external audits, document control, management review inputs). Six packages had already started from v1 and a first
set of briefs. This ADR records how v2 settles them.

## Decisions

1. **ISO files get their own table (D1).** ISO files are rows of a new `iso_file` table with one nullable composite
   foreign key per ISO subject that can hold files and `CHECK (num_nonnulls(...) = 1)`. The `evidence` table and the
   `Evidence`/`EvidenceView` contracts do not change. Keys sit under `evidence/<firmId>/<clientId>/iso/...`, inside the
   purge prefix. The upload, confirm, download and remove code is M7's, exported from M7's public index and called by
   M16 through an `IsoFiles` port that `server.ts` connects, built on the evidence storage as the evidence service
   is. M9's scan job scans `iso_file` rows; the client archive
   (the account export) includes ISO files. The off switch applies to the file routes.
2. **The catalogue is a per-account, firm-wide copy written only by the system (D2).** Standards, clauses and review
   input and output definitions are tables with `firm_id` and no `client_id`, forced RLS, isolation tests and purge
   entries, writable only under `app_system_job()`. `act.kind` is immutable (trigger), STANDARD acts can be inserted
   only by the system job, the library bodies take no `kind`, M6 refuses merges and obligation moves across kinds, and
   M8 imports match and create STATUTE acts only.
3. **The copy has a trigger, a sweep, a marker and a "not ready" answer (D3).** M15 writes `account.features_changed
   { accountId, added, removed }` whenever an account's effective features change (override, plan change, plan edit
   per affected account). M9 consumes it and also sweeps every 10 minutes for TRIAL and ACTIVE accounts that have the
   feature and no copy. M6's `copyIsoCatalogue` runs through a `JobDeps` port, marks
   `firm.iso_catalogue_copied_at` through a SECURITY DEFINER `app_mark_iso_catalogue_copied()` that works in TRIAL and
   ACTIVE, and is idempotent. Until the marker is set, ISO routes answer `409 FEATURE_NOT_READY`.
4. **ISO reminders are planned and logged on their own key (D4).** The engine gets `planIsoNotifications` returning
   `PlannedIsoNotification`; `planNotifications` stays instance-only. `notification_send` gets a nullable ISO subject
   with its own unique index, and the digest key is narrowed so ISO sends never merge. The ISO notification kinds are
   stored in the database before the contracts list them.
5. **Database-backed enum values are staged, and new fields arrive optional (D5).** For `EntityType`,
   `NotificationKind` and `ExportKind`: M0 stages the values as separate constants, M3 stores them and lists them as
   "ahead" values, M13 labels entity types, then M0 joins them. New fields are optional with a written default and
   become required only in a later bump. ISO-0 already worked this way; v2 makes it the rule.
6. **One action entity (D6).** `IsoAction` serves nonconformities, risk items, objectives, audit findings and
   management reviews, with one nullable foreign key per subject and `num_nonnulls = 1`, so a cross-client reference
   cannot exist. It replaces `CorrectiveAction` and `ReviewAction`. The staged ISO entity types change accordingly:
   `iso_action` replaces `corrective_action` and `review_action`; `external_audit`, `risk_control` and
   `audit_checklist_item` are added; files are audited on their subject. ISO-1 updates `ISO_ENTITY_TYPES` before
   anything stages it.
7. **One package, one module (D7).** Every package belongs to one module, because the path guard allows one module per
   PR. v1's ISO-11 (M7 + M10) and the large ISO-2, ISO-6, ISO-8 and ISO-10 are split; the register, approvals and
   calendar Source filter is M12's package; the wiring is a `Tooling:` package. Started ids (ISO-0, ISO-2a, ISO-4a,
   ISO-4b, ISO-5, ISO-7) keep their ids and scopes; new ids use letter suffixes or continue from ISO-15.
8. **Packages start by the plan's Needs column (D8).** `plan-wave.mjs` gates modules, not packages, so the coordinator
   starts each ISO package when its Needs have merged, one thread per module at a time. Every ISO package merges `main`
   before it is marked ready (the launch-hardening thread has finished, so nothing waits for it).
   `MODULES.md`'s Uses for M16 and M17 now match `tooling/modules.json`.
9. **Plan changes go through the planning thread (D9).** After v2, `docs/iso/` changes only in `Tooling:` PRs from
   the ISO planning thread; module threads report drift to the coordinator.
10. **Domain changes.** Clause N/A only on ISO 9001 clauses that allow exclusion, with approval; only assessable
    clauses count. Nonconformities gain a raise step, correction, disposition, similar occurrences, risk and system
    updates, an effectiveness date, a no-action path for minor cases, a return to root cause, a source instance and
    incident fields with a personal-data rule. Risk items gain aspect and hazard fields, the hierarchy of controls,
    existing controls versus treatment actions, and a significance rule with a legal link and an override. Objectives
    serve several standards and link risks. External audits are visits that can cover several certificates.
    Internal audits gain a checklist, cancellation, reporting to management and a recorded independence note.
    Document state moves to the revision, with periodic review and superseded history. Management reviews get
    planned dates, inputs and outputs per standard, and reminders. The climate decision of Amd 1:2024 is recorded.
    Certification readiness gates sit beside clause readiness. Four STANDARD acts (one per standard and an
    integrated one) ship each recurring activity once. Unit scope and the people rule apply to every ISO record.

## What this supersedes in M16-0001

- Decision 4 as plan v1 applied it (one STANDARD act per standard): now four acts, each activity once (decision 10
  above).
- Decision 5, the entity list: `CorrectiveAction` and `ReviewAction` become `IsoAction`; external audits, checklist
  items and risk controls are added; the catalogue tables are firm-wide copies, not client tables.
- Decision 6, "one evidence store through a nullable ISO subject on `evidence`": replaced by decision 1 above.
- Decision 7, "self-audit warns but is allowed": self-audit needs a recorded independence note.
- Decision 8, editions "without a code change" by moving a system: editions stay data, but moving an existing system
  to a newer edition is Later.
- Consequences, contract versions: there are four ISO bumps, not two (1.7.0 feature fields; ISO-1 shapes; ISO-1b
  joins the staged values; ISO-1c makes fields required), each taking the next free version when it merges.

- Decision 9's "usual contracts-first order (plan §7)": database-backed values go database first (decision 5 above),
  and packages start by plan §6's Needs column (decision 8).

Decisions 1, 2 and 3 of M16-0001 stand, read with decisions 3, 5 and 7 above; decision 9 stands except for its order.

## Consequences

- 41 packages instead of 15, each in one module; the table in plan §6 is the start order.
- `platform_purge_account`'s table list, the client archive and the account export cover every ISO table and file.
- The review trace at the end of `docs/iso/packages.md` maps each finding to where v2 answers it.
- Later (plan §2): Excel import of ISO registers, supplier register, per-person training records, complaints portal,
  more standards, edition moves, retention schedules, LTIFR, monitoring indicators with limits, raising NCs from the
  register drawer, recording an event-driven statutory instance (such as an accident notice) from an incident, console
  visibility of a stuck catalogue copy beyond the ISO-5b flag, an editable risk matrix.

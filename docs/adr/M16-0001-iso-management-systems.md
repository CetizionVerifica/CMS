# M16-0001: ISO management systems add-on

Status: accepted, 2026-10-25. Amended by [M16-0002](M16-0002-iso-plan-v2.md). Plan: `docs/iso/plan.md`.

## Context

Shyam asked (2026-10-25) for companies to be able to manage ISO 9001, ISO 14001 and ISO 45001 in the app, as an extra
feature the platform operator turns on or off per account. v1 already covers the legal register (14001 and 45001
§6.1.3) and the evaluation of compliance, but none of the management-system work: clause checklists, documents, risk
registers, objectives, internal audits, management reviews, nonconformities and corrective actions, certification.

## Decisions

1. **One add-on, one flag.** `isoManagement` covers all three standards. Each client chooses which standards its
   management system covers; the three can run as one integrated system on the shared clause 4-10 structure.
2. **The operator switches it per account.** Flags already exist on plans and account overrides (ADR M15-0001). The
   console gets an Add-ons card driven by a `KNOWN_FEATURES` list in contracts, and `AccountOverride.removedFeatures`
   lets a switch turn a feature off for one account even when the plan includes it. Each switch is an
   `OVERRIDE_CHANGE` operator audit event with a reason. No plan includes the add-on by default.
3. **Off hides, never deletes.** With the flag off, ISO routes answer `403 FEATURE_NOT_ENABLED`, ISO screens, jobs and
   activity instances are hidden or skipped, and every row stays. Turning it back on restores everything. Account and
   client exports always include ISO data. Purge on account deletion removes ISO rows like any other client data.
4. **Reuse the statutory workflow for recurring activities.** `Act.kind` is `STATUTE` or `STANDARD`; recurring ISO
   activities are obligations under STANDARD acts, so instances, reminders, evidence and maker-checker need no new code.
   Statutory compliance scores never count STANDARD acts.
5. **New entities for the rest** (plan §3), each with `firm_id`, `client_id`, RLS, isolation test and audit events.
   Nonconformities and controlled documents get maker-checker state machines whose transition tables live in the engine.
6. **One evidence store.** ISO files use the existing evidence upload, scan and signed-download flow through a nullable
   ISO subject on `evidence`, so the personal-data and 5-minute URL rules hold without a second store.
7. **No new roles.** Client admin acts as management representative; approvers verify and approve; owners do assigned
   work; viewers (external auditors) read. Auditors are people named on an audit; self-audit warns but is allowed.
8. **No ISO text in the repo.** The clause catalogue holds clause numbers and titles with summaries in our own words.
   Editions are data, so a revised standard is a new catalogue edition, not a code change.
9. **Two new modules.** M16 owns the ISO API (`apps/api/src/modules/iso/`) and this plan (`docs/iso/`); M17 owns the ISO
   screens (`apps/web/app/(shell)/c/[clientId]/iso/`) and their e2e tests. Changes in other modules' paths are made by
   threads briefed as those modules, through the usual contracts-first order (plan §7).

## Consequences

- Contracts gain a minor version for the feature fields and another for the ISO schemas.
- `platform_purge_account`, the account export and the client archive must list the new tables; the auditor checks this.
- An account that never turns the add-on on sees no change, and its statutory scores and golden counts stay the same.
- Later: importing existing ISO registers from Excel, supplier evaluation, complaints, more standards (27001, 50001).

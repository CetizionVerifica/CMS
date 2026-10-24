# ADR M6-0002: Master library version 2 from the sample register

## Context
ADR M6-0001 shipped master library version 1 empty, because its content was the consultancy's to supply. On
2026-10-24 Shyam supplied it: the client register export that is already our golden import file
(`docs/requirements/excel-analysis.md`). Its statutory part (Acts, categories, obligations, recurrence) is what a
new account should start with. Its units, people, departments and dated instances belong to one client and are
already the `pnpm db:seed` demo data (M8).

## Decisions
1. **Version 2 is generated, not hand-written.** `testing/write-master.ts` plans the anonymised sample register into
   an empty account with the "recommended" profile (`docs/contracts/fixtures.md` §3, the decisions the seed takes)
   and keeps only the Acts, categories and obligations (`masterFromPlan`). It writes `master-data.ts`.
   `from-register.test.ts` fails when the file drifts from the register or from the import.
2. **The content is exactly what an import gives.** Titles, descriptions, applicability, criticality, forms and log
   sheets are the cleaned register values. Category and Act spellings merge as the recommended import merges them.
   `evidenceRequired` is false, as on import.
3. **Rules are the engine's inference, with its confidence.** 113 rules match every due date in the register and are
   CONFIRMED. 6 do not and stay TO_REVIEW, so instance generation skips them until a consultant confirms the rule
   (ADR M9-0001). No rule is invented or edited here.
4. **No company, site or person is copied.** One register "Act" names the plant whose consent it renews. The bundle
   files that obligation under "Water (Prevention and Control of Pollution) Act, 1974 and Air (Prevention and
   Control of Pollution) Act, 1981", the laws the consent is granted under. Four register titles are the plant's own
   petroleum and fire licence numbers; the bundle titles them by what each licence is for ("Licence to store
   petroleum (Form XV)"). Tests check that no fictional company, site or pseudonymised person name, and nothing
   shaped like a licence or registration number, reaches the bundle. Forms and log sheets that the register names by file
   name keep the name with no file attached; the consultant uploads the templates.
5. **State law is kept.** 40 obligations are West Bengal law. They copy into every account like the rest; the
   applicability step decides per unit whether they apply.

## Consequences
- A new account opens with 10 categories, 33 Acts and 119 obligations, each audited as a CREATE with reason
  "Master library version 2".
- Importing the same register into such an account matches the obligations by external ID and adds no duplicates.
- Accounts created while version 1 was live keep their empty library; pushing a version to existing accounts is
  still a later operator feature (ADR M6-0001).
- A new version of the library is a new generator input or rule change, a `MASTER_VERSION` bump and a regenerated
  `master-data.ts`, reviewed in its own PR.

# ADR M6-0003: The ISO catalogue and its copy

## Context
The ISO add-on (docs/iso/plan.md, ADR M16-0001) gives an account its own copy of the ISO 9001, 14001 and 45001
clause catalogue, the management review inputs and outputs, four STANDARD acts, one category and the recurring
activities of docs/iso/catalogue.md §3. ISO-9 writes that catalogue (`library/iso-catalogue.ts`) and the copy
(`library/db-iso-catalogue-copy.ts`, `copyIsoCatalogue`), which M9 runs the first time the add-on is on. Clause text
is copyrighted: the catalogue holds clause numbers, short titles and summaries in our own words only.

## Decisions
1. **The copy is once per account and records itself first.** In the account's system context it reads the effective
   features; without `isoManagement` it copies nothing. It then calls `app_mark_iso_catalogue_copied()`, which sets
   `firm.iso_catalogue_copied_at` once, only while the account is TRIAL or ACTIVE, and locks the firm row, so a
   second delivery waits and copies nothing. A failed copy rolls the mark back, and the retry copies.
2. **A broken catalogue never half-copies.** `checkIsoCatalogue` runs before any write and refuses repeated editions,
   clause numbers, review keys, act keys or names and activity keys; a clause without its parent; an exclusion outside
   ISO 9001 or on a clause that is not assessable; an over-long title or summary; a review definition or activity
   clause reference naming a clause the catalogue lacks; an activity with no clause or under an unknown act; and a
   rule M4's engine cannot generate (the same `ruleIssues` the library routes use).
3. **Clause flags follow from the numbers.** The parent is the number less its last part. A clause is `assessable`
   when it is in clauses 4 to 10 and has no sub-clauses, so readiness counts leaves only (8.3 is not; 8.3.1 to 8.3.6
   are). `hlsKey` is the clause's own number when it is one of the shared-structure clauses the three standards have
   in common (4, 4.1-4.4, 5, 5.1-5.3, 6, 6.1, 6.2, 7, 7.1-7.5, 8, 8.1, 9, 9.1-9.3, 10, 10.1-10.3), else its first two
   levels when those are, else null: ISO 9001 7.1.5.2 is "7.1", and every standard's 8.2 and ISO 9001 8.5.1 are null.
4. **The exclusion list (ISO 9001 only):** 7.1.5.2, 8.3.1 to 8.3.6, 8.5.3 and 8.5.5. 8.3 itself is left out because
   it is not assessable (decision 3); excluding design and development means excluding its sub-clauses.
5. **Review items.** Each review input and output stores the clause and item the catalogue §5 tables name. Where a
   row names two items (ISO 45001 interested parties, risks and opportunities), the first is stored (`b1`, `b3`),
   since a definition has one item.
6. **Reuse, never a law.** A STANDARD act with the same name is reused, a STATUTE act of that name never is
   (`act_name_key` is per kind). The category is reused by name. An activity whose source ID is already filed under
   its act is not copied again. Only rows the copy creates get a CREATE audit row (actor SYSTEM, reason
   "ISO catalogue version 1"); standards, clauses and review definitions are reference data and are not audited.
7. **The master library holds no ISO row.** `copyMasterLibrary` writes STATUTE acts and obligations without clause
   references; a test checks it.
8. **Editions seeded:** ISO 9001 2015+A1:2024, ISO 14001 2015+A1:2024, ISO 45001 2018+A1:2024 (catalogue §6).
   ISO 14001:2026 (April 2026) and ISO 9001:2026 (September 2026) have since been published. Catalogue §6 asks for
   them as separate editions; this PR does not seed them, because their clause lists must be checked against the
   published standards rather than written from memory. Seeding them is a follow-up change to this catalogue before
   any account copies it in production; since the copy runs once per account, a later edition needs its own top-up
   path once accounts hold version 1.

## Consequences
- The library routes refuse staff edits and merges of a STANDARD act, any merge across kinds, and moving an
  obligation between a law and a standard (400 `VALIDATION`). ISO-9b adds the off switch: while the add-on is off,
  lists leave STANDARD rows out and the routes that name one answer 403 `FEATURE_NOT_ENABLED`, before those 400s.
- `clauseRefs` are written only by this copy. The obligation create and update bodies never carry them in v1
  (plan §4.4), so a body that names them gets the contract's 400 `VALIDATION`, whatever the act's kind or the switch.
- The DUPLICATE finder for acts looks among STATUTE acts only, matching `act_name_key`.

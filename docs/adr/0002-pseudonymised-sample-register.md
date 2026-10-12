# 0002. The golden sample register is pseudonymised

Date: 2026-10-11. Module: M8 (Excel importer). Status: accepted.

## Context
Root `CLAUDE.md` names `packages/importer/fixtures/sample-register.xlsx` as the golden fixture, and
`docs/contracts/fixtures.md` §7 planned to keep the xlsx as given while pseudonymising the JSON fixtures.
The original register holds 21 real employee names (owners and approvers) and the name of the person who last
saved the workbook. Root `CLAUDE.md` rule 6 treats such names as personal data, and a committed fixture spreads to
every clone, CI log and test failure message.

## Decision
The committed fixture is the original with every Owner and Approvers value replaced by a fixed pseudonym per
person ("Person Alpha" ... ), with each distinct source spelling kept as a distinct spelling of the pseudonym
(same case pattern where possible), and the workbook author fields reset.
All other cells are unchanged. `packages/importer/scripts/pseudonymise-sample.mjs` rebuilds it from the original,
which stays in the project files, outside the repository.

## Consequences
- Every golden count in `docs/contracts/fixtures.md` §2 to §5 is unchanged: names are only compared
  case-insensitively, and the pseudonyms keep the same case-only spelling variants and have no near matches.
- Display names in importer tests are pseudonyms ("Person Echo"), not the "Owner 01" style planned for
  `firm-a.sample.json`; M0 may align the two when it generates the JSON fixtures from this file.

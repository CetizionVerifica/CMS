# Importer fixtures

## sample-register.xlsx

The golden import file: the client's register export (`ASPxGridView1 (15) (1).xlsx`, one sheet, 424 rows x 19
columns) with one change. Every **Owner** and **Approvers** value is replaced by a pseudonym ("Person Alpha",
"Person Bravo", ...), keyed by the case-insensitive name. Each distinct source spelling maps to a distinct pseudonym spelling
that keeps its case pattern ("person alpha" for an all lower-case original), so spelling counts survive. The workbook's author fields are reset too. All other cells are byte-for-byte
the original values, so every count in `docs/contracts/fixtures.md` §2 and §3 still holds (14 owner spellings
for 12 people, 11 approver spellings for 10, 21 people, one person who is both, no near-match names).

Why: root `CLAUDE.md` rule 6 treats employee names as personal data, and a fixture is copied into every clone,
CI log and test snapshot. See `docs/adr/0002-pseudonymised-sample-register.md`.

Rebuild it from the original (kept outside the repo) with:

```
node packages/importer/scripts/pseudonymise-sample.mjs "<original>.xlsx" packages/importer/fixtures/sample-register.xlsx
```

Do not edit the fixture by hand; add new fixtures instead.

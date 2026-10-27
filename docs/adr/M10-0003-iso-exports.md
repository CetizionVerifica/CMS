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
   named-person rule included. The worker re-reads the add-on and the requester's scope when it runs, as for every
   kind. The filters a list computes rather than stores (`incident`, `overdue`, and `q` over number, description and
   root cause for NCs, or activity, description and impact for risks) are applied by M10 after the read, as the
   contract mock's lists apply them; the rows keep the lists' order (NCs newest first by `reportedOn` then number,
   risks by rating, highest first, then in the order added).
4. **Names, not ids.** People, units, systems, clauses ("ISO 9001 8.7") and statutory obligations print by name,
   archived ones included, since a record keeps naming them. Codes print as words (model §4.7): sentence case with a
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

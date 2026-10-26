# M16-0004: Where the ISO API, part 1, departs from the mock

Status: accepted, 2026-10-26. Package ISO-8a (`docs/iso/packages.md`). Plan: `docs/iso/plan.md`; model §1.5, §3.4,
§4.4, §4.6 and §6; `docs/contracts/iso-mock.md`.

## Context

ISO-8a serves the first 45 ISO routes from Postgres: catalogue reads, management systems, context, the climate
decision, the clause checklist with its N/A machine, controlled documents and revisions, certificates, external audit
visits (RECORD_HELD and CANCEL) and ISO files. The brief keeps each of the mock's picks for these areas, or records
here where the real routes answer differently. Six places differ, and decision 7 records one of the mock's picks kept
on purpose. None changes a contract shape.

## Decisions

1. **Document search.** `q` on `GET .../iso/documents` matches the code and the title, not the issuer and the
   external reference as the mock does. The M3 read (`controlledDocuments.list`, ISO-2d) searches those two columns
   and is not M16's to change. If people need to find an external document by its issuer, M3 adds the columns to the
   search and the route needs no change.

2. **The `IsoFiles` port takes the caller.** Model §6 sketched the port with only `tx`. Every write
   (`uploadUrl`, `confirm`, `downloadUrl`, `remove`) also takes `Pick<RequestContext, 'firmId' | 'personId' |
   'requestId'>`, since the tenant transaction carries neither the person nor the request id that an `AuditEvent`
   and a storage key need. The port also has `get(tx, fileId)`, removed files included, so M16 finds a file's subject
   and checks its scope and lock before a download or a removal. This is the shape ISO-15 implements in
   `apps/api/src/modules/evidence/`.

3. **External audit steps.** ISO-8a offers RECORD_HELD and CANCEL only. `allowedActions` on an external audit lists
   those two while it is PLANNED, for a writer; RECORD_RESPONSE, CLOSE and the findings arrive with ISO-8c, which adds
   them to the list.

4. **Changing an external audit's standards.** `PATCH .../external-audits/{id}` checks that each standard is one of the
   system's. It cannot yet check that no finding cites a clause of a standard being removed, because findings are
   ISO-8c's. ISO-8c adds that check to the same route.

5. **N/A on a clause that allows no exclusion.** REQUEST_NA on such a clause answers `400 VALIDATION` with the path
   `status`, the field the engine's guard names (`EXCLUSION_ALLOWED` in `packages/engine/src/iso-status.ts`). The mock
   names `clauseId`. The client shows the message either way; the mock should follow the engine.

6. **People named by a client role.** Model §1.5 lets a record name a firm admin or a consultant of the client. M16
   checks the person's memberships inside the request's tenant transaction, and the `membership` policy (migration
   0001) shows a client-role actor only memberships of clients they can see. A client admin therefore cannot see a
   firm admin's or consultant's membership, and naming one answers `400 VALIDATION`; a firm admin or consultant
   naming the same person succeeds. M7's assignee check has the same limit. The fix is an M3 read that answers
   "does this person hold one of these roles in this client and unit" without showing the rows; until it lands, client
   roles name client members.

7. **A report still being scanned.** RECORD_HELD counts a report file that is PENDING or CLEAN, as the mock does, so
   a visit can be recorded held while its report is still being scanned (seconds, as a rule). If the scan then finds
   the file INFECTED, the visit stays HELD but has no readable report. The client admin uploads the report again; the
   external audit stays open to files until it is CLOSED or CANCELLED. Asking for a CLEAN file would make people wait
   on the scan for a record they already hold on paper.

## Consequences

- The coordinator passes decisions 1 and 5 to M0 for the mock, and decision 6 to M3 as a request for the lookup.
- ISO-8c extends decisions 3 and 4; ISO-15 implements the port in decision 2.

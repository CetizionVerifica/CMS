# M16-0005: Where the ISO API, part 2, departs from the mock

Status: accepted, 2026-10-27. Package ISO-8b (`docs/iso/packages.md`). Plan: `docs/iso/plan.md`; model §1.7, §3.5,
§3.6, §3.12, §5.1, §5.2 and §6; `docs/contracts/iso-mock.md`; contracts 1.8.5 (`ids` on the ISO lists).

## Context

ISO-8b serves 26 more ISO routes from Postgres: risk items with their controls, REVIEW and the significance override;
objectives with CLOSE and their readings; and actions on every subject with COMPLETE, CANCEL and REOPEN. It also adds
`ids` to the document list and file routes for risk items, objective readings and actions. The brief keeps the mock's
picks for these areas, or records here where the real routes answer differently. Decisions 1 and 2 close two items
ADR M16-0004 left open, decisions 3 and 4 are departures, and decisions 5 to 8 record the mock's picks kept on purpose.
None changes a contract shape.

## Decisions

1. **People named by a client role (closes M16-0004 decision 6).** M16 now checks a named person with M3's
   SECURITY DEFINER lookup `memberships.holdsRole` (migrations 0044 and 0045) instead of reading memberships under
   the actor's RLS. A client admin can name the client's consultant or a firm admin, as model §1.5 allows and the mock
   does. The lookup still needs a live person and a live membership with one of the roles asked for, in the client and
   covering the unit when there is one.

2. **Document search (closes M16-0004 decision 1).** M3 (ISO-2i) added the issuer and the external reference to
   `controlledDocuments.list`'s `q`, so `q` on `GET .../iso/documents` now matches what the mock matches. The route did
   not change.

3. **How the three new lists page.** Risk items sort by rating, highest first. The risk and objective lists filter `q`
   on text M3 does not search; the action list reads `q` itself, although M3 searches the action's text (ISO-2j), so
   that it also matches `resources`, as the mock does. M16 reads every row the SQL filters return (unit scope, `ids`, system, kind,
   owner, state and the rest, a page of 200 at a time), applies `q` (and, for actions, `overdue`, which is the
   engine's), sorts, and then pages with its own cursor. `ids` is therefore applied in SQL after the unit scope and
   before paging, and an id the reader cannot see, of another client or archived drops out with no error. A client's
   register holds hundreds of rows, not tens of thousands; if one grows past that, M3 adds the rating order and the
   text search and the route needs no change.

4. **An objective's first day.** CLOSE takes a `closedOn` from the objective's creation day to today. M16 reads the
   creation day as `createdAt` in the client's time zone (`localDateIn`), where the mock uses its own clock. The two
   agree in use; only a test that fixes the server's clock and not the database's sees a difference.

5. **A control's source action.** The cross-row rule ISO-2e left to M16 (#280), that a control's `sourceActionId` is
   an action on its own risk item, holds by construction: `POST .../risks/{id}/controls` takes no `sourceActionId`, and
   the only writer of one is COMPLETE on an action whose subject is that item, which checks it again before writing.

6. **Completing a treatment action** writes, as the mock does, the action's TRANSITION (`after.action` COMPLETE), the
   control's CREATE, a DUE_DATE_CHANGE setting the item's `reviewDueOn` to today, and, once no treatment action of the
   item is left OPEN and the item has a residual rating, one UPDATE clearing the residual likelihood, severity and
   rating. Both risk-item events carry the action's `sourceActionId`, so M4's review figures do not count them as a
   re-rating (model §8); the owner's re-rating that follows is a PATCH, and its UPDATE never carries one.

7. **The subject closed to its actions.** Field edits, COMPLETE and REOPEN on an action whose subject is closed
   (model §3.12: a CLOSED or CANCELLED nonconformity, audit or review; a closed objective; an archived subject) answer
   `409 INVALID_TRANSITION` naming the subject, `{ entity, from, action: 'UPDATE' }`, before the engine runs, as the
   mock does; the engine's own `subjectOpen` guard is then always met. CANCEL is allowed on a closed subject, so an
   action left open there can be cleared away. New actions on a closed subject answer the same 409.

8. **Files on an action.** An action's files lock once it is DONE or CANCELLED, and an OPEN action's files lock only
   when its subject is a CLOSED or CANCELLED nonconformity, as the mock does; other closed subjects stop the action's
   field edits (decision 7) but not its files. An action on a nonconformity with an incident takes the incident's
   download rule (model §6): its owner, approver and investigators, and client admins, consultants and firm admins.

## Consequences

- The coordinator can tell M0 and M3 that M16-0004 decisions 1 and 6 are closed.
- ISO-8c serves nonconformities, audits and reviews; it reuses `actionSubject` for their actions and adds their files.

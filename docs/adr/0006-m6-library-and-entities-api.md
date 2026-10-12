# 0006: Library and entities API (M6) before its dependencies merge

Status: accepted (M6, 2026-10-12)

## Context
M6 serves the clients, entities, people, memberships, library and assignments endpoints from
`packages/contracts/src/api/endpoints.ts`. Its data access has to go through M3's typed repositories (M3 PR 2) and its
authorisation through M5's `can()` and request context. Neither had merged when M6 started, and both were being built
in parallel. Shared API helpers (`apps/api/src/lib/`) belong to no module yet.

## Decisions
1. **Routes come from the contracts table.** `mount()` registers each endpoint with the path, method, status, params,
   query and body schemas of its `ENDPOINTS` entry, so a route cannot drift from the spec. A test checks every M6
   entry has a route, answers its status and parses with its response schema.
2. **A store port, not SQL.** Services use `Store`/`Tx` (`modules/entities/store.ts`): one `Repo` per table plus the
   few cross-table reads M6 needs (`clientPersonIds`, `firmStaffIds`, `personReach`, `assignedObligationIds`), audit and outbox
   writes. The Postgres implementation is an adapter over M3's repositories, added when they merge. Route tests run
   on `MemoryStore`, which mimics the RLS policies and rolls back a failed transaction; it does not replace M3's
   isolation tests on Postgres.
3. **Two authorisation checks.** Every route declares `config.auth: 'session'`, so M5's hook answers 401, MFA and
   CSRF first, and each call checks the endpoint's role table and M5's `can()`. A client the actor cannot see is 404;
   a visible one the role may not touch is 403. Lists across clients check each of a client role's clients; routes on
   one person follow the person rules below. The "limited" rows are enforced in the routes: a client admin may PUT
   only `reminders`; only a firm admin grants, changes or ends firm roles; consultants and client admins manage client
   roles in their own clients.
6. **Person rules.** A person record is shared by every client they belong to, so person routes check where the
   person reaches (`personReach`: every client of their memberships, assignments and instances, firm-wide, plus
   whether they hold a firm role), not only what the actor's context can see.
   - A firm admin reaches everyone. Consultants and client roles reach only people of clients they work in (404
     otherwise); a consultant is never firm-wide here.
   - Firm staff are changed by a firm admin only; consultants may read them.
   - A write (rename, email, merge) must stay inside the actor's clients: a person who also belongs to another client
     is 403 for anyone but a firm admin, so a merge never leaves another client's rows on an archived person.
   - The email of an `ACTIVE` person is their sign-in, so only a firm admin changes it.
   - On Postgres, `personReach` needs a narrow security-definer function from M3, since a client context cannot see
     the other clients' rows.
4. **HTTP helpers stay in M6's paths** (`modules/entities/http/`): error envelope, cursor pagination, request id.
   They can move to `lib/` in a tooling PR once another module needs them.
5. **Every write is audited in its transaction** with the changed fields only; an update that changes nothing writes
   no audit row and keeps the version. Merges audit each moved row as `MERGE_ALIAS`; instance reassignments as
   `REASSIGN` with an `instance.reassigned` event.

## Defaults where the contract is open (raised with M0)
- `POST /clients/{clientId}/people` gives the new person a membership in `body.role` (contracts 1.2.0: `OWNER` by
  default, the role imported people have, or `APPROVER` or `CLIENT_ADMIN`) on every unit, checked with M5's
  `canGrantRole`. A person belongs to a client only through a membership, assignment or instance (the person RLS
  policy).
- Person status follows email (README decision 10): adding an email to an `UNCLAIMED` person makes them `INVITED`
  (ready for M5's invite); removing it from an `INVITED` person makes them `UNCLAIMED`; an `ACTIVE` person keeps one.
- `push` emits `obligation.pushed`; M9 regenerates the future instances, so `instancesUpdated` is 0 from this call and
  `assignmentsUpdated` counts the live assignments of that obligation in the named clients.
- Recurrence rules are checked with the engine over the current and next FY: `RULE_INVALID` when a periodic rule
  generates no due dates, or a due date falls before its period starts.
- Archiving a company with live units, a unit with live assignments or an obligation with live assignments is refused
  with `VALIDATION`, so nothing is left pointing at an archived row. A merge source who has signed in (`ACTIVE`) is
  never merged away, and the firm keeps at least one firm admin.

## Consequences
- When M3's repositories merge, M6 adds the Postgres `Store` adapter plus `test:db` tests, and `main.ts` mounts M6
  with it.
- If M0 settles the open points differently, the change is local to one route each.

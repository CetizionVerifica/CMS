# 0003: Library and entities API (M6) before its dependencies merge

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
   few cross-table reads M6 needs (`clientPersonIds`, `firmStaffIds`, `assignedObligationIds`), audit and outbox
   writes. The Postgres implementation is an adapter over M3's repositories, added when they merge. Route tests run
   on `MemoryStore`, which mimics the RLS policies and rolls back a failed transaction; it does not replace M3's
   isolation tests on Postgres.
3. **Two authorisation checks.** Each call checks the endpoint's role table and `can()`. Until M5 merges, `can` is
   `stubCan`, built from the same table. A client the actor cannot see is 404; a visible one the role may not touch
   is 403. The "limited" rows are enforced in the routes: a client admin may PUT only `reminders`; only a firm admin
   grants, changes or ends firm roles; consultants and client admins manage client roles in their own clients.
4. **HTTP helpers stay in M6's paths** (`modules/entities/http/`): error envelope, cursor pagination, request id.
   They can move to `lib/` in a tooling PR once another module needs them.
5. **Every write is audited in its transaction** with the changed fields only; an update that changes nothing writes
   no audit row and keeps the version. Merges audit each moved row as `MERGE_ALIAS`; instance reassignments as
   `REASSIGN` with an `instance.reassigned` event.

## Defaults where the contract is open (raised with M0)
- `POST /clients/{clientId}/people` has no role. A person belongs to a client only through a membership, assignment
  or instance (the person RLS policy), so the new person also gets an `OWNER` membership for all units, the role
  imported people have.
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
  with it. When M5 merges, `can` and `context` come from `auth/`.
- If M0 settles the open points differently, the change is local to one route each.

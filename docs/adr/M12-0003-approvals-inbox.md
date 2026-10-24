# M12-0003. Approvals inbox: one client's queue, shortcuts and the drawer

Status: accepted (M12 PR 5, 2026-10-24)

## Context
apps/web/CLAUDE.md gives `/c/[clientId]/approvals` a list with keyboard shortcuts: J/K move, A approves, S sends back
with a reason. `packages/ui`'s TaskList has an approver mode with exactly those keys and an empty state. GET
/me/approvals lists what waits for the person across every client, with no client filter, and the web app's demo API
answers it with a count only (the Approvals badge). The page sits under one client, like every page in the shell.

## Decisions
1. **This client's queue, the count for all of them.** The inbox lists `listInstances` with `workflowState=SUBMITTED`
   for this client, oldest due date first: `approverId=me` for an APPROVER, the whole client for a CLIENT_ADMIN (GET
   /me/approvals' own rule). The line above the list says how many wait here and, when more wait elsewhere, how many
   across all the person's clients, from the same GET /me/approvals count as the badge. The client switcher moves to
   another client's inbox.
2. **Approve without a confirm, and no Undo.** A press of A or Approve approves at once, with the version on screen,
   and says so in a toast. TaskList suggests an Undo toast, but an approver can't reopen (REOPEN is FIRM_ADMIN,
   CONSULTANT and CLIENT_ADMIN), so Undo would have to delay the approval, which a closed tab would lose without a word.
   A stale or already-decided row is refused by the API, and the list is re-read.
3. **Send back asks for a reason.** S or Send back opens a ConfirmDialog with a required reason. A refusal keeps the
   dialog and the reason; a row that moved on closes it and re-reads the list. Focus goes to the row that took the
   decided row's place.
4. **The drawer over the inbox.** `/approvals/[instanceId]` renders the inbox with that instance's drawer open, as the
   register does (M12-0002 §1, §2): a plain click or Enter opens it with `pushState`, previous and next move through the
   queue, and its phone back button says "Back to approvals". A row decided in the drawer stays listed until the drawer
   closes, so previous and next still work; then it leaves and the page is refreshed.
5. **Only approvers.** The page shows No access to anyone without CLIENT_ADMIN or APPROVER in the client, the roles the
   sidebar shows Approvals to.

## Consequences
An approver works through a client's queue from the keyboard without page loads. Someone approving in several clients
sees the total and switches client to reach the rest; a cross-client list can come later from GET /me/approvals once
the demo API returns its rows.

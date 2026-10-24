# M12-0002. Instance drawer: route, actions, evidence and refresh

Status: accepted (M12 PR 4, 2026-10-24)

## Context
apps/web/CLAUDE.md gives the instance drawer its own route, `/c/[clientId]/register/[instanceId]`, "over the register
(deep-linkable)", with description, applicability, Act, forms, log sheets, evidence, comments and history, and a primary
action that depends on role and state. The contracts (`InstanceDetail.allowedActions`, the M7 transition, comment,
evidence and audit endpoints) say what a person may do; the web app only shows it. Evidence goes to storage through a
presigned PUT (api-conventions.md §6), and the demo API's upload URLs point at `files.mock.invalid`.

## Decisions
1. **One page, two paths.** `register/[instanceId]/page.tsx` re-exports the register page, so a drawer link, a bookmark
   and a reload all render the register with that instance open. RegisterView reads the instance from the path.
2. **Opening a row stays in the browser.** A plain click (or Enter on a row) on a title link calls
   `history.pushState` to `/register/<id>?<view>`; Next's router follows the path without a server round trip, so the
   loaded rows, "Show more" and the scroll position stay. Close pushes the register path again, so Back reopens the
   drawer as any URL state would. Previous and next (buttons, J/K) move through the loaded rows with `replaceState`, so
   they don't fill the history. A modified click (new tab or window) follows the href.
3. **Only `allowedActions`.** The footer offers Submit or Approve as the primary action, and Send back, Not applicable
   and Reopen as secondary ones, only when the API lists them. Each sends the version the person is looking at. A
   STALE_VERSION or INVALID_TRANSITION answer reloads the drawer and says why; other refusals keep what was typed.
   Submit needs a completion date and a comment (SubmitBody); the date has no default, because only the API knows
   "today" in the client's time zone, and DATE_IN_FUTURE is shown on the field.
4. **Server Actions answer outcomes, not errors.** An error thrown from a Server Action reaches the browser without its
   code, so `instance-actions.ts` returns `{ ok, data }` or `{ ok: false, code, message }`, with the message worded per
   error code in `_lib/instance-api.ts`. Arguments are checked against the contracts' schemas first (root rule 7).
5. **No server refresh while the drawer is open.** A change patches its row in the grid at once (`rowOf(detail)`), and
   the drawer re-reads its own comments and history. The page is refreshed (`router.refresh()`) when the drawer closes,
   so counts and the Approvals badge catch up without the drawer reloading under the person.
6. **Evidence uploads go browser to storage.** The browser hashes the file (SHA-256), asks for a ticket, PUTs the bytes
   with the ticket's headers and confirms. A URL on a `.invalid` host (RFC 2606: it can never resolve) gets no PUT,
   which is what lets the demo API's uploads work; any other host gets the PUT. Confirmed files show as "Checking for
   viruses" until the drawer's re-reads (every 2 s, up to 30 times) return a result; only CLEAN files open, through a
   5-minute signed URL fetched on click and never stored or logged (root rule 6).
7. **Removing evidence asks for a reason.** The contract requires one, so confirmed files are the drawer's own list
   (Open, Remove) rather than FileDrop rows, whose confirmation has no reason field. Remove is shown while uploads are
   allowed, to FIRM_ADMIN, CONSULTANT and CLIENT_ADMIN, and to the instance's owner; the API still decides.
8. **Names.** Comment authors and history actors are named from the client's people (first page) plus the instance's
   owner and approver; anyone else is "Someone", and system or import events are the product.
9. **Not in this PR.** Reassign and change due date (REASSIGN, CHANGE_DUE_DATE) need a person picker and a reason form;
   they come in a later drawer PR. Forms and log sheets are listed by label and file name; the contracts have no
   template download yet.

## Consequences
The register and the drawer share one client tree, so working through a list of instances costs no page loads. A
person who opens a drawer from a link lands on the register's current period with that instance over it.

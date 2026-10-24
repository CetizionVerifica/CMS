# M12-0004. Evidence vault: the client's files, filtered in the URL

Status: accepted (M12 PR 6, 2026-10-24)

## Context
MODULES.md gives M12 an evidence vault at `/c/[clientId]/evidence`. GET /clients/{clientId}/evidence (`evidenceVault`)
pages the client's current (not removed) evidence, newest first. APPROVER and OWNER see only their units'. Its filters
are unit, Act, department, upload dates, virus-check result and a file-name search. An EvidenceView names its instance
by id only, and a file opens through a 5-minute signed URL (root rule 6).

## Decisions
1. **Filters in the URL, under the API's names.** `q`, `scanStatus`, `unitId`, `uploadedFrom` and `uploadedTo` are both
   the page's URL and the API query, so a link shows the same files. Each value is checked against the contract on
   the server and a bad one is dropped rather than failing the page. A backwards date range keeps its start.
2. **What the table shows.** The table lists file and size, upload time in the client's time zone, who added it, the
   virus check (the drawer's words) and Open. Act and department filters wait for a need: the register already
   filters instances by them, and the vault's rows don't name an Act.
3. **A file leads to its instance.** The file name links to `/register/<instanceId>`, the drawer over the register,
   where the instance's title, state and history are. The vault doesn't look up every row's instance.
4. **Opening is the drawer's.** Open shows only for CLEAN files. It fetches the signed URL on the click, through the
   drawer's `evidenceDownload` action and `openEvidence`, which this PR moves out of the drawer into
   `register/_lib/evidence-files.ts` with the file-size and virus-check wording. The URL is never stored or logged.
5. **No removing from the vault.** Removing a file needs a reason and belongs to its instance's state. It stays in
   the drawer.

## Consequences
The vault answers "where is the file for X" from one page, and every action on a file happens in its instance's
drawer, so the audit trail reads the same wherever the person started.

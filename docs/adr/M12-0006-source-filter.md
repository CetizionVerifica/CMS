# M12-0006. Source filter: Law, ISO or both, in the URL

Status: accepted (ISO-11c, 2026-10-26)

## Context
With the ISO add-on, the instance list, `/me/approvals`, the vault and the calendar take `source` (`LAW` = STATUTE acts,
`ISO` = STANDARD acts, absent = both; docs/iso/plan.md §4.6). ISO-11c puts a Source filter on the register, approvals,
calendar and evidence screens, shown only with the add-on (plan §4.5). ADR M12-0001 keeps the register's state in the
URL under the API's own names.

## Decisions
1. **`?source=LAW|ISO` in the URL, under the API's name.** No `source` means both. The register, vault, approvals and
   calendar all read and write it the same way (`register/_lib/source.ts`). A saved view stores it with the other
   filters. Links into the register that carry `source=LAW` (ISO-12c) open filtered.
2. **Only with the add-on.** The pages read `isoManagement` from the shell model. Without it they show no filter and
   ignore a `source` left in a URL, because the API returns statutory work only anyway (plan §4.4). The rows and
   counts always come from the API; the screens do no ISO logic.
3. **Two controls for one filter.** The register and the vault already have a FilterBar, so Source is one more chip
   there, with Law and ISO as its choices. One ticked is that source. None ticked, or both, is both, and the URL leaves
   it out. Approvals and the calendar have no FilterBar, so they show three buttons ("Law and ISO", "Law", "ISO") with
   the current one pressed, like the calendar's Month and List buttons.
4. **Approvals keep the filter on the drawer path** (`/approvals/<id>?source=ISO`), and closing the drawer returns to
   the filtered inbox. While a source is chosen, the count line leaves out "N across all your clients", since that count
   includes both sources and would not compare with the filtered count.

## Consequences
A number on the overview with `source=LAW` (ISO-12c) equals the register's filtered count. Turning the add-on off hides
the filter, and old links still work.

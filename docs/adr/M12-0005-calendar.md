# M12-0005. Calendar: one month, from the URL's period

Status: accepted (M12 PR 7, 2026-10-24)

## Context
PLAN.md asks for a calendar with "month and list views of due dates, coloured by status". GET
/clients/{clientId}/calendar (M10) returns the instances due between two dates, grouped by day. The shell keeps the
selected period in the URL (`?fy=2024-25`, plus `&q=Q3` or `&m=2024-11`), and every page respects it.

## Decisions
1. **The month comes from the period.** A period with a month (`&m=`) shows that month. Otherwise the calendar opens
   on this month (today in the client's time zone) when the period includes it, and on the period's first month when
   it doesn't. Previous and next month write `fy` and `m` back to the URL, so the period picker, Back and a shared link
   all agree. The FY of a month follows the client's FY start month. This is calendar arithmetic in `_lib/month.ts`;
   which instances fall due is the API's answer.
2. **One request per month.** The page asks for the month's first to last day. Weeks start on Monday, padded with the
   neighbouring months' days, which show no due dates.
3. **Month grid and list.** `?view=list` switches between them. In the grid, a day with due dates is a button named
   "15 November 2024, 3 due, 1 overdue". It shows up to two titles with a status dot and "+N more" (a count on a
   phone). Choosing a day lists its instances below, each with its status pill and a link to the drawer over the
   register. The list view has a section per day. The dots use the status language's tones, with sent back shown as
   on the register.
4. **Keyboard.** Every day with due dates is a Tab stop, and Enter or Space opens it. After the h1, the first control is
   "Previous month". M11's shell keyboard test is updated to accept it.

## Consequences
The calendar reads the same period as every other page, so moving from the overview's upcoming deadlines or the
register to the calendar keeps the person in the same time window.

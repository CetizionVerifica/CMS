# DeadlineList

Short list of upcoming due dates for the overview ("Upcoming") and the calendar side panel.

## Anatomy

Card with title (`type-card`) and optional "View calendar" ghost link. Items (min height 52px, 1px `--line` top border except first):

- **Date block** 44px wide, `--mist` bg, `radius-chip`: day (`type-section` 800 tabular) over month (`type-label`).
- **Text**: title (`type-body-strong`, 1 line, truncate) · meta (`type-meta` `--muted`: unit or department · owner).
- **Trailing** (optional): StatusPill `sm` (DUE_SOON / OVERDUE only, so the list stays calm).
  Optional group headings: "Overdue" (due before `today`), "This week", "Next week", "Later" (`type-label` `--muted`). Grouping needs the API's `today`; without it the list is not grouped and a development warning names the missing prop.

## Props

```ts
type DeadlineItem = {
  id: string;
  dueDate: string;
  title: string;
  meta?: string;
  status?: DerivedStatus;
  days?: number;
  href: string;
};
type DeadlineListProps = {
  title?: string;
  items: DeadlineItem[];
  max?: number /* default 5 */;
  groupBy?: 'week' | 'none';
  viewAllHref?: string;
  loading?: boolean;
};
```

Dates in client time zone, formatted per foundations §9; grouping uses the API-provided `today`, never the browser clock.

## States

Loading (4 skeleton items) · empty ("Nothing due in this period." with a calendar icon, compact EmptyState) · more than `max` ("+ 12 more" link to calendar) · item hover bg `--mist` · focus ring on the item link.

## Accessibility

`<ul>`; each item is one link whose name is "{title}, due {31 Oct 2026}, {status label}". The date block is `aria-hidden` (the full date is in the link name).

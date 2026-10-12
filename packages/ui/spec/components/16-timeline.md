# Timeline (audit)

Read-only, chronological record of what changed on an instance, obligation or client. Used in the instance drawer (Activity) and the Audit trail page.

## Anatomy

`<ol>` with a 2px `--line` rail 6px from the left. Item:

- **Dot** 10px on the rail, tone by event: ok (approved, complied), warn (submitted, due date changed), crit (sent back, evidence removed, overdue), neutral `--line-strong` (comment, assignment, created).
- **Sentence** `type-body`: actor bold + verb phrase from `status-language.md` ("**Rohit Agarwal** sent back").
- **Detail** (optional): reason or comment in a quoted block (`--mist` bg, radius 8px, padding 8px 12px); field change as "Due date: 30 Jun 2027 to 15 Jul 2027", old value in `--muted`, new value in `--ink`.
- **Time** `type-meta` `--muted`: "31 Mar 2027, 14:05 IST"; relative ("2 hours ago") in the `title`.
  Day separators when the list spans days: "Today", "Yesterday", "28 Mar 2027" (`type-label`).

## Props

```ts
type TimelineEvent = {
  id: string;
  at: string /* ISO UTC */;
  actor: { name: string } | 'system';
  kind: AuditEventKind;
  summary: string;
  detail?: { reason?: string; from?: string; to?: string; field?: string };
};
type TimelineProps = {
  events: TimelineEvent[];
  timeZone: string;
  order?: 'newest' | 'oldest';
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
};
```

`summary` text comes from the API (built from the event catalogue) so wording is identical in UI, export and email.

## States

Loading (3 skeleton items) · empty ("No activity yet.") · has more ("Show earlier activity" button, appends; focus moves to the first new item) · system actor ("PlanetPulse Compliance" by default, set by `systemName`, with a `Bot` 16px icon instead of avatar; client-facing text never says "Canopy").

## Accessibility

`<ol>` with `aria-label="Activity"`; each item one `<li>` whose text reads sentence, detail, time in order. Dots are `aria-hidden`; the verb carries the meaning. Never editable or deletable from the UI (audit rows are immutable).

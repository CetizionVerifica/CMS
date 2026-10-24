# TaskList

The signed-in person's open instances ("My open items" card on the overview, and the Approvals inbox list). The component is named TaskList in the brief; UI copy avoids "task" per the root vocabulary rule.

## Anatomy

Rows (min height 56px, 1px `--line` top border):

1. **State marker** 16px circle, drawn in `--line-strong` (to do), half-filled `--warn` (awaiting approval), `--crit` ring (sent back or overdue). It is an indicator, **not a checkbox**: completing an item needs evidence and approval, so a tick box would promise something it can't do. (Deviation from the mockup, which shows a square checkbox.)
2. **Text**: title (`type-body-strong`, max 2 lines) · meta line (`type-meta` `--muted`): Act short name · "due 18 Oct" · plus a tone word when relevant ("overdue" crit-ink, "sent back" crit-ink, "awaiting your approval" warn-ink).
3. **Trailing** (Approvals mode only): Approve and Send back Buttons `sm`, shown on row hover and focus, always shown on touch.

## Props

```ts
type TaskItem = {
  id: string;
  title: string;
  meta: string;
  dueDate: string;
  status: DerivedStatus;
  days?: number;
  href: string;
};
type TaskListProps = {
  items: TaskItem[];
  mode?: 'owner' | 'approver';
  onApprove?: (id: string) => void;
  onSendBack?: (id: string) => void; // approver mode
  max?: number;
  viewAllHref?: string;
  loading?: boolean;
};
```

## Keyboard (approver mode, from `apps/web/CLAUDE.md`)

| Key                                                                                                      | Result                                                    |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| J / K                                                                                                    | Move focus down / up                                      |
| Enter                                                                                                    | Open the instance drawer                                  |
| A                                                                                                        | Approve focused item (no confirm; a Toast says it was approved. No Undo: an approver can't reopen, see docs/adr/M12-0003) |
| S                                                                                                        | Send back: opens ConfirmDialog with required reason       |
| Shortcuts are listed in a "Keyboard shortcuts" popover (`?` key) and never fire while typing in a field. |

## States

Loading (4 skeleton rows) · empty owner ("You're all caught up." with `CheckCircle2` in ok) · empty approver ("Nothing waiting for your approval.") · item processing (row dims to 60%, buttons disabled, spinner) · item removed after approve (row collapses 200ms; focus moves to next row).

## Accessibility

`<ul>` with one link per row (accessible name: title, due date, status). Action buttons have names including the item ("Approve Tax collection at source"). After A/S the outcome is announced via Toast (role `status`).

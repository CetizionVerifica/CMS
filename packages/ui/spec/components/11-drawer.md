# Drawer

Right-side panel over the current page. Main use: the instance drawer over the register (`/c/[clientId]/register/[instanceId]`, deep-linkable). Generic component; the instance layout below is its reference composition.

## Anatomy

Radix Dialog, modal, from the right. Width 560 / 480 / full screen (foundations §3). bg `--surface`, `--shadow-overlay`, `--scrim` behind, z `z-drawer`.

1. **Header** (sticky, padding 16px 22px, 1px `--line` bottom): eyebrow (`type-meta` `--muted`: ID, copy button) · title (`type-section`, max 3 lines) · meta row: StatusPill, CriticalityTag, "Due 31 Mar 2027 · in 3 days" · right side: prev/next IconButtons ("Previous instance", "Next instance") and close IconButton ("Close").
2. **Body** (scrolls, padding 22px): sections separated by 22px, each with a `type-card` heading.
3. **Footer** (sticky, `z-sticky`, padding 12px 22px, 1px `--line` top, bg `--surface`): secondary actions left, one primary action right.

## Instance drawer composition (reference for M12)

Body sections, in order: Description (preserve line breaks and numbering, `white-space: pre-line`; "Show more" after 12 lines) · Applicability · Details grid (Act, Category, Unit, Department, Owner, Approver, Frequency, Type) as a 2-column `<dl>` (label `type-meta` `--muted`, value `type-body`) · Forms and log sheets (file links) · Evidence (FileDrop + list) · Comments (textarea + list) · Activity (Timeline).
Footer primary action by role and state (the API returns allowed actions; the drawer renders them):

| Allowed action             | Primary             | Secondary              |
| -------------------------- | ------------------- | ---------------------- |
| submit                     | Submit for approval | Request not applicable |
| approve                    | Approve             | Send back              |
| resubmit (after send back) | Submit again        | Request not applicable |
| none                       | (no footer)         |                        |

## Props

```ts
type DrawerProps = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  onPrev?: () => void;
  onNext?: () => void;
  footer?: ReactNode;
  dirty?: boolean; // guards close with ConfirmDialog "Discard your comment?"
  loading?: boolean;
  error?: { message: string; retry: () => void };
  children: ReactNode;
};
```

## States

Opening (slide 260ms, fade on reduced motion) · loading (header skeleton + 3 section skeletons; close works immediately) · loaded · error (EmptyState error in body; header shows ID if known) · not found / no access (EmptyState no-permission, "This instance isn't available to you") · dirty close guard · action pending (primary button loading, other actions disabled).

## Keyboard

| Key                                  | Result                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Esc                                  | Close (through dirty guard); focus returns to the row that opened it                       |
| Tab / Shift+Tab                      | Cycles within drawer (Radix focus trap)                                                    |
| J / K or Alt+ArrowDown / Alt+ArrowUp | Next / previous instance in the current table order (not while typing)                     |
| Ctrl/Cmd+Enter                       | Trigger primary action when focus is in the comment box (only for non-destructive actions) |

On open, focus moves to the title (`tabindex=-1`), not the close button, so screen readers start with context.

## Accessibility

`role="dialog"`, `aria-modal="true"`, `aria-labelledby` the title, `aria-describedby` the meta row. Prev/next announces the new title via the dialog relabel. Background is inert.

## Responsive

Full screen under 640px with header close as a back arrow ("Back to register") and footer actions stacked full width.

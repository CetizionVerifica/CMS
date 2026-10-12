# ConfirmDialog

Asks for confirmation before a consequential action, optionally collecting a required reason. Radix AlertDialog.

## Anatomy

Centred, width 440px (full width minus 32px under 640px), bg `--surface`, radius `radius-card`, `--shadow-overlay`, `--scrim`, z `z-dialog`, padding 22px:
title `type-section` (the action as a question: "Send back to Priya Rane?") · body `type-body` `--muted` (the consequence in one sentence: "They'll be notified and the instance returns to their list.") · optional reason Textarea (label "Reason (required)", 3 rows, helper "The owner sees this.") · footer right-aligned: Cancel (secondary) and Confirm (primary, or danger for destructive), confirm label repeats the verb ("Send back", never "OK" or "Yes").

## Uses in v1

| Action                                 | Tone    | Reason                                                  |
| -------------------------------------- | ------- | ------------------------------------------------------- |
| Send back                              | primary | required, min 5 characters                              |
| Request not applicable                 | primary | required justification                                  |
| Remove evidence                        | danger  | optional                                                |
| Delete saved view                      | danger  | none                                                    |
| Discard unsaved comment (drawer close) | danger  | none                                                    |
| Bulk approve N items                   | primary | none; body lists count and "12 items, 2 super critical" |

## Props

```ts
type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body?: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  reason?: {
    label: string;
    required: boolean;
    minLength?: number;
    maxLength?: number;
    helper?: string;
    multiline?: boolean; // false: a one-line name field where Enter confirms (saved views)
    initialValue?: string; // pre-fill, e.g. the current name when renaming
  };
  returnFocusTo?: () => HTMLElement | null | undefined; // resolved on close; for actions that remove the trigger
  onConfirm: (reason?: string) => Promise<void> | void; // dialog shows loading until it settles
};
```

## States

Open · reason invalid (Confirm stays enabled; on press the field shows the error and receives focus) · submitting (Confirm loading, both buttons disabled, Esc ignored) · failed (inline error above footer in crit-ink; dialog stays open with the reason kept).

## Keyboard and accessibility

`role="alertdialog"`, labelled by title, described by body. Initial focus: the reason field when present; otherwise **Cancel** for danger tone, Confirm for primary tone. Enter in the textarea inserts a newline; Ctrl/Cmd+Enter confirms. Esc cancels. Focus returns to the trigger on close; after a successful action that removed the trigger (e.g. row approved), focus goes to the next logical element, which the caller passes as `returnFocusTo`.

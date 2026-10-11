# Toast

Brief confirmation of something the user just did, with an optional Undo. Radix Toast.

## Anatomy
Card 360px max, bg `--ink`, text white `type-body`, radius `radius-card`, `--shadow-overlay`, padding 12px 14px: 3px left bar in the tone colour (`--ok` / `--warn` / `--crit`; `--muted` for info) · tone icon 18px in white · message (1-2 lines) · optional action Button (ghost, text `--on-forest-muted` underlined, e.g. "Undo") · close IconButton ("Dismiss").

## Tones and timing
| Tone | Use | Auto-dismiss | Role |
|---|---|---|---|
| success | "Approved. 3 left in your queue." | 5s | `status` |
| info | "Copied ID" | 3s | `status` |
| warn | "Saved, but 2 files are still scanning" | 8s | `status` |
| error | "Couldn't approve. Try again." | never (manual dismiss) | `alert` |

Timers pause on hover and while focus is inside the toast. Max 3 visible; older ones collapse.

## Placement
Bottom-right, 22px from edges (≥640px); bottom-centre full width minus 16px gutters (<640px). z `z-toast`.

## Props
```ts
toast({ tone: 'success'|'info'|'warn'|'error', message: string, action?: { label: string; onClick: () => void }, duration?: number });
```

## Keyboard and accessibility
F8 moves focus to the toast region (Radix hotkey); Tab reaches the action and dismiss; Esc dismisses the focused toast. Undo must be reachable before auto-dismiss: an action toast's minimum duration is 6s. Never put the only path to an outcome in a toast (the register state must also reflect it).

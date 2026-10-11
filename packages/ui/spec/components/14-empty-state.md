# EmptyState

What a region shows when there is nothing to show, something failed, or the user lacks access. Every page and data card uses it (web quality bar: loading, empty, error, no-permission).

## Anatomy

Centred column, max width 420px, padding `space-7` (page) or `space-5` (card):
icon 20px in a 40px circle (`--sage` bg, `--forest` icon; error variant `--crit-soft` bg, `--crit-ink` icon) · title `type-section` · body `type-body` `--muted` (1-2 sentences, says what to do) · actions: one primary Button + optional ghost link.

## Variants

| Variant         | Icon                      | Example title / body                                                                         | Action           |
| --------------- | ------------------------- | -------------------------------------------------------------------------------------------- | ---------------- |
| `first-use`     | `Sparkles` / context icon | "No obligations yet" / "Import your compliance register to get started."                     | Import register  |
| `no-results`    | `SearchX`                 | "No instances match these filters" / "Try removing a filter or widening the period."         | Clear filters    |
| `no-permission` | `Lock`                    | "You don't have access to this" / "Ask a consultant at your firm to add you to this client." | Back to overview |
| `error`         | `AlertTriangle`           | "Couldn't load the register" / "Check your connection and try again."                        | Retry            |
| `done`          | `CheckCircle2` (ok)       | "You're all caught up"                                                                       | none             |

## Props

```ts
type EmptyStateProps = {
  variant: 'first-use' | 'no-results' | 'no-permission' | 'error' | 'done';
  title: string;
  body?: string;
  icon?: LucideIcon;
  action?: { label: string; onClick?: () => void; href?: string };
  secondary?: { label: string; href: string };
  size?: 'page' | 'card';
  errorId?: string;
};
```

`errorId` (request id from the API) renders as `type-meta` `--muted` "Reference: 7f3a…" so support can trace it.

## Accessibility

Title is a heading at the right level for its region (`h2` page, `h3` card; prop `headingLevel`). Error variant uses `role="alert"` only when it appears after a user action; on initial load it is plain content. Icon `aria-hidden`.

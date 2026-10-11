# ClientSwitcher

Top-bar control that shows the current client and switches to another while keeping the rest of the path (`/c/[clientId]/register?…` → same page for the new client).

## Anatomy
Trigger (button, 40px tall, `--surface`, 1px `--line`, radius 10px, padding 7px 12px): Avatar (32, initials) · client name (`type-body-strong`) · meta line (`type-meta` `--muted`: "Metals · 3 units") · `ChevronsUpDown` 16px.
Popover (360px wide, max 420px tall): search input "Find a client" · **Recent** group (max 3) · **All clients** group (alphabetical, with overdue count on the right as a crit-ink number + "overdue") · footer link "All clients overview" → `/portfolio`.

## Props
```ts
type ClientSwitcherProps = {
  current?: ClientSummary;            // undefined → "Choose a client"
  clients: ClientSummary[];           // { id, name, initials, meta, overdueCount }
  recentIds?: string[];
  hrefFor: (clientId: string) => string;   // built by the web app from the current path
  loading?: boolean;
};
```

## States
| State | Treatment |
|---|---|
| Rest / hover (border `--line-strong`) / focus ring / open (border `--forest`) | |
| Long name | truncate with ellipsis at 220px; full name in `title` and the popover |
| Loading clients | 4 skeleton rows in popover |
| No match | "No client matches “abc”." in `--muted` |
| One client only | trigger is static text (no popover, no chevron) |
| <640px | trigger shows avatar + name only; popover becomes a full-height sheet |

## Keyboard (combobox pattern, Radix Popover + listbox)
| Key | Result |
|---|---|
| Enter / Space / ArrowDown on trigger | Open, focus search |
| Typing | Filters by name and meta; first match highlighted |
| ArrowUp / ArrowDown | Move highlight (`aria-activedescendant`) |
| Enter | Navigate to highlighted client; popover closes |
| Esc | Close, focus returns to trigger |
| Ctrl/Cmd+K | Open from anywhere |

## Accessibility
Trigger `aria-haspopup="dialog"`, `aria-expanded`, accessible name "Client: Hindalco Belur, change client". Search is `role="combobox"` with `aria-controls` on the listbox; options `role="option"` with name, meta and "12 overdue" in the accessible name. After switching, the new page title is announced (AppShell rule).

## Content
Client name as entered in setup. Meta = industry · unit count. Overdue count from the API.

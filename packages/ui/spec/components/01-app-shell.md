# AppShell

The frame of every signed-in page: forest sidebar, top bar, main content region.

## Anatomy
```
┌──────────┬───────────────────────────────────────────────────────────┐
│ Logo     │ [ClientSwitcher] [PeriodPicker] [Search........] [Primary] (Av) │  top bar 56px
│ Nav      ├───────────────────────────────────────────────────────────┤
│  Overview│  <main> page title, content                                │
│  Register│                                                           │
│  ...  (4)│                                                           │
│ GROUP    │                                                           │
│  ...     │                                                           │
│ [Help]   │                                                           │
└──────────┴───────────────────────────────────────────────────────────┘
 212px
```
1. **Sidebar** (`<nav aria-label="Main">`): logo, nav items, group labels, optional help card pinned to bottom.
2. **Top bar** (`<header>`): ClientSwitcher, PeriodPicker, search field, page primary action slot, user menu (Avatar → DropdownMenu: Profile, Switch firm, Sign out).
3. **Main** (`<main id="main">`): page content, padding 18px 22px, background `--mist`.
4. **Skip link** "Skip to content" as first focusable element, visible on focus.

## Props
```ts
type AppShellProps = {
  nav: NavGroup[];              // { label?: string; items: NavItem[] }
  activeHref: string;
  topBar: { clientSwitcher?: ReactNode; periodPicker?: ReactNode; search?: ReactNode; primaryAction?: ReactNode; user: UserMenuProps };
  helpCard?: { title: string; body: string; href?: string };
  children: ReactNode;
};
type NavItem = { label: string; href: string; icon: LucideIcon; badge?: { count: number; label: string } };
```
Default nav for a client workspace (v1 statutory scope): Overview, Register, Calendar, Approvals (badge), Evidence; group **Reporting**: Reports, Audit trail; group **Setup**: Entities, People, Import. Firm level: Portfolio, Library. Labels are the user's words; the mockup's ESG items (Frameworks, Emissions, CBAM) are not in v1.

## Tokens
Sidebar bg `--forest`; logo text `--on-forest` 800 15px, mark `--moss`; item text `--on-forest-muted` 500, 18px icon; item hover `--on-forest-hover`; selected bg `--on-forest-selected`, text `--on-forest` 700; group label `type-label` `--on-forest-muted`; help card bg `--on-forest-hover`, radius 10px, 12px text. Top bar bg `--mist` (no border; content scrolls under a 1px `--line` bottom border once scrolled). Item 36px tall, radius 8px, padding 8px 10px.

## States
| State | Treatment |
|---|---|
| Item rest / hover / focus / selected | as tokens; focus ring white on forest |
| Badge | right-aligned count pill |
| Rail (640-1099px) | 64px, icons only, tooltip with label on hover and focus, badge becomes 8px dot with count in accessible name, group labels become 1px dividers |
| Sheet (<640px) | sidebar hidden; top bar shows menu IconButton ("Open menu") left of ClientSwitcher; nav opens as Radix Dialog bottom sheet (max 85vh, drag handle, `--scrim`) |
| Loading | top bar and nav render immediately; main shows page skeleton |
| No client selected | ClientSwitcher shows "Choose a client"; client nav items hidden; Portfolio active |

## Keyboard
| Key | Result |
|---|---|
| Tab from page load | Skip link, then sidebar items, then top bar, then main |
| Enter on skip link | Focus moves to `<main>` (tabindex -1) |
| `/` | Focus search (unless typing in a field) |
| Esc in sheet | Closes sheet, focus to menu button |

## Accessibility
- Landmarks: one `nav[aria-label=Main]`, one `header`, one `main`. Selected item has `aria-current="page"`.
- Rail tooltips are labels, so the link also has `aria-label`.
- Page title updates `document.title` as "Register · Hindalco Belur · Canopy".
- Route changes move focus to the page `h1` and announce the title via a polite live region.

## Responsive
Breakpoints per foundations §8. The primary action collapses into an IconButton with label tooltip under 1100px; search collapses into an IconButton that expands to a full-width field under 640px.

## Demo page
Desktop, rail and sheet variants side by side; long client name; badge 0, 4, 120; no-client state.

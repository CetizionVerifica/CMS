# Canopy foundations

Tokens, type, spacing, elevation, motion, layout and the cross-cutting rules every component in this spec relies on.
Source of truth once code exists: `packages/ui/src/tokens.css`, mirrored in `tailwind.preset.ts`. Machine-readable copy of this file: [`tokens.json`](tokens.json).

Values marked **NEW** are not in `packages/ui/CLAUDE.md` yet. They are needed to meet the contrast rule in that same file; see [`change-requests.md`](change-requests.md).

## 1. Colour

### 1.1 Brand and neutral (from `packages/ui/CLAUDE.md`)
| Token | Value | Use |
|---|---|---|
| `--forest` | #1F6B47 | Sidebar, primary buttons, focus ring, selected state, score ring fill |
| `--leaf` | #2F8F60 | Progress fills, secondary emphasis, chart series 2 |
| `--moss` | #A9C97A | Logo mark, chart series 3. Never text. |
| `--sage` | #D9E8DC | Progress and ring track, FY chip, soft accent backgrounds |
| `--mist` | #F5F7F4 | App background, date block, table row hover |
| `--surface` | #FFFFFF | Cards, tables, drawers, menus, dialogs |
| `--ink` | #13221A | Primary text |
| `--muted` | #5F6F66 | Secondary text, table headers, placeholder |
| `--line` | #E1E7E2 | Card borders, dividers, table row rules (decorative only) |

### 1.2 Status
| Token | Value | Use |
|---|---|---|
| `--ok` | #1E8A55 | Complied: dots, icons, chart fills, delta arrows. Not for text under 18px. |
| `--warn` | #B97A06 | Due soon, awaiting approval: dots, icons, fills. Not for text. |
| `--crit` | #C0442A | Overdue, sent back, Super Critical: dots, icons, fills, destructive button fill |

### 1.3 NEW tokens (contrast fixes and missing roles)
| Token | Value | Why |
|---|---|---|
| `--ok-ink` | #176B42 | Text in ok tone. `--ok` on its pill bg is 3.79:1 (fails); this is 5.68:1. |
| `--warn-ink` | #8C5C04 | Text in warn tone. `--warn` on its pill bg is 3.17:1 (fails); this is 5.09:1. |
| `--crit-ink` | #A8391F | Text in crit tone. `--crit` on its pill bg is 4.24:1 (fails); this is 5.31:1. Also destructive button hover. |
| `--ok-soft` | #E3F3EA | Pill/tag background, ok tone (value from the mockup) |
| `--warn-soft` | #FBF0D9 | Pill/tag background, warn tone |
| `--crit-soft` | #FBE5DF | Pill/tag background, crit tone; error field background |
| `--neutral-soft` | #EEF1EF | Pill/tag background, neutral tone |
| `--line-strong` | #7A8A81 | Borders of inputs, checkboxes, drop zone. `--line` is 1.26:1 and fails WCAG 1.4.11 (3:1 for control boundaries); this is 3.63:1 on white, 3.37:1 on mist. |
| `--forest-hover` | #185A3B | Primary button hover/pressed |
| `--on-forest` | #FFFFFF | Text and icons on forest |
| `--on-forest-muted` | #CFE3D6 | Unselected nav text and sidebar group labels on forest. The mockup's #9CC2AA group label is 3.29:1 and fails. |
| `--on-forest-hover` | rgba(255,255,255,.08) | Nav item hover |
| `--on-forest-selected` | rgba(255,255,255,.13) | Nav item selected (text must be `--on-forest`, 4.9:1) |
| `--scrim` | rgba(19,34,26,.40) | Behind modal drawer, dialog and mobile sheet |

### 1.4 Contrast audit (WCAG 2.2, computed)
| Pair | Ratio | Verdict |
|---|---|---|
| ink on mist / surface | 15.3 / 16.5 | Pass |
| muted on mist / surface | 4.93 / 5.31 | Pass (tight on mist: do not darken mist) |
| muted on neutral-soft | 4.67 | Pass |
| muted on sage | 4.18 | **Fail.** Never put muted text on sage. Use ink or forest. |
| white on forest | 6.46 | Pass |
| forest on sage (FY chip) | 5.08 | Pass |
| forest on surface (links) | 6.46 | Pass |
| ok / warn / crit on white (as text) | 4.36 / 3.59 / 5.12 | ok and warn fail for body text: use the `-ink` tokens |
| ok-ink / warn-ink / crit-ink on their soft bg | 5.68 / 5.09 / 5.31 | Pass |
| leaf fill on sage track | 3.17 | Pass for non-text (3:1) |
| line-strong on white | 3.63 | Pass for control boundary |
| focus ring forest on mist / sage | 5.99 / 5.08 | Pass |

Re-run this table whenever a token changes (the M2 test suite should compute it; see §10).

### 1.5 Chart series
Categorical: `--forest`, `--leaf`, `--moss` in that order; a 4th series uses `--muted`. Status charts use `--ok`, `--warn`, `--crit`, `--neutral-soft` with a `--line-strong` outline. Every chart ships a text summary or a table toggle.

## 2. Typography
One family: **Plus Jakarta Sans** (self-hosted via `next/font`, weights 500, 600, 700, 800; `font-display: swap`). Fallback `system-ui, -apple-system, "Segoe UI", sans-serif`. All numerals `font-variant-numeric: tabular-nums` inside tables, KPIs, dates and counts.

| Token | Size / line height | Weight | Tracking | Use |
|---|---|---|---|---|
| `type-kpi` | 26 / 30 | 800 | -0.02em | KpiCard value |
| `type-page` | 20 / 26 | 800 | -0.01em | Page title (one per page, `h1`) |
| `type-section` | 16 / 22 | 700 | 0 | Drawer title, dialog title, section headings |
| `type-card` | 14 / 20 | 800 | 0 | Card titles |
| `type-body` | 14 / 21 | 500 | 0 | Body, table cells, inputs, buttons (buttons 700) |
| `type-body-strong` | 14 / 21 | 700 | 0 | Row titles, names |
| `type-meta` | 12 / 16 | 600 | 0 | Secondary lines under a title, timestamps, pill and tag text (700) |
| `type-label` | 12 / 16 | 600 | 0.05em, uppercase | Table headers, sidebar group labels |

Rules: 14px is the floor for anything a user reads as content; 12px only for meta, labels, pills and tags. No 11px or 10.5px text (the mockup uses some; spec raises them to 12px). Sentence case everywhere except `type-label`.

## 3. Spacing, size and radius
Spacing scale (4px base): `space-1` 4, `space-2` 8, `space-3` 12, `space-3h` 14, `space-4` 16, `space-5` 22. **NEW:** `space-6` 32 and `space-7` 48 for page-level gaps and empty states (the brief's scale stops at 22, which is too small for page margins).

| Use | Value |
|---|---|
| Card padding | 14px 16px (`space-3h` `space-4`) |
| Gap between cards | 14px |
| Page padding | 18px 22px (desktop), 16px (under 640px) |
| Control height | 36px default, 32px compact (tables only), 44px touch (`pointer: coarse`) |
| Hit target minimum | 36px desktop, 44px touch; a smaller visual (16px icon) gets padding to reach it |
| Sidebar width | 212px; icon rail 64px |
| Top bar height | 56px |
| Drawer width | 560px (≥1100), 480px (640-1099), full screen (<640) |

Radius: `radius-card` 12px, `radius-control` 9px (inputs, buttons, menu items), `radius-chip` 8px (FY chip, date block), `radius-tag` 6px (CriticalityTag), `radius-pill` 999px (StatusPill, badges, avatars).

## 4. Elevation and layering
Cards: border `1px solid var(--line)`, **no shadow**. Overlays only (drawer, menu, popover, dialog, toast): `--shadow-overlay: 0 12px 32px -12px rgba(19,34,26,.28), 0 2px 6px rgba(19,34,26,.08)`.

z-index tokens: `z-sticky` 10 (table header, drawer footer), `z-shell` 20 (sidebar, top bar), `z-drawer` 40, `z-popover` 50 (menus, popovers, tooltips), `z-dialog` 60, `z-toast` 70.

## 5. Motion
`--ease-out: cubic-bezier(.2,0,0,1)`. `--dur-fast` 120ms (hover, pressed, focus), `--dur-base` 200ms (menu, popover, toast), `--dur-slow` 260ms (drawer, sheet). Under `prefers-reduced-motion: reduce` every transition is opacity-only at 0-80ms; no slide or scale. Progress and ring fills animate once on mount (300ms) and never loop.

## 6. Focus
Every focusable element: `outline: 2px solid var(--forest); outline-offset: 2px` on `:focus-visible`. On forest surfaces (sidebar, primary button) the ring is `--on-forest` (white) with offset 2px so it stays visible. Never `outline: none` without this replacement. Focus order follows visual order; overlays trap focus via Radix and return it to the trigger on close.

## 7. Iconography
Lucide only. 16px in tables, pills, tags and inline text; 18px in nav and buttons; 20px in empty states inside a 40px sage circle. Stroke 2 (1.75 at 18px+). Icons inherit `currentColor`. An icon alone always has `aria-label` (icon button) or is `aria-hidden="true"` next to a text label.

## 8. Layout and breakpoints
| Name | Width | Shell |
|---|---|---|
| `sm` | <640px | No sidebar; top bar with menu button opens a bottom sheet nav |
| `md` | 640-1099px | 64px icon rail with tooltips |
| `lg` | ≥1100px | 212px sidebar |
| check widths | 375, 1280 | Definition of done in root `CLAUDE.md` |

Tables scroll horizontally inside their card, never the page. KPI grid: 4 columns ≥1100, 2 columns 640-1099, 1 column <640 (or 2 compact).

## 9. Copy and formatting
- Sentence case. Verbs on buttons: "Submit for approval", "Approve", "Send back", "Request not applicable", "Save view".
- Dates: "31 Mar 2027" (`en-GB`, day month-short year). Relative text sits next to the date, never replaces it: "31 Mar 2027 · in 3 days".
- Date-times: "31 Mar 2027, 14:05 IST" in the client's time zone (default Asia/Kolkata).
- FY: "FY 2022–23" (en dash). Quarter: "Q3 (Oct–Dec)".
- Numbers: `en-IN` grouping (`1,00,000`) by default, since users are Indian plant staff; a client setting can switch to `en-GB` (`100,000`). Percentages without decimals unless under 1%.
- Status words and overdue day counts come from the API (engine output). Components format them; they never compute them.

## 10. Testing contract (applies to every component)
- Storybook story or demo page with every state listed in its spec, including loading, empty, error and disabled where relevant.
- Vitest + Testing Library keyboard test: every interaction in the component's "Keyboard" table.
- `axe-core` run on every story with zero violations (`color-contrast` included).
- A contrast unit test that reads `tokens.css` and asserts the §1.4 pairs.
- Visual check at 375px and 1280px.

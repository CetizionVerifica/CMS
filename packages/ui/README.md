# @canopy/ui

Canopy design system: tokens, Tailwind preset and React components. Rules: [`CLAUDE.md`](CLAUDE.md). Anatomy, states and
keyboard behaviour of each component: [`spec/`](spec/README.md).

## Use it in an app (Tailwind v4)

```css
/* app/globals.css */
@import 'tailwindcss';
@import '@canopy/ui/styles.css';
```

`styles.css` loads `tokens.css`, applies `tailwind.preset.ts` through `@config`, tells Tailwind to scan the component
sources, and sets the base rules (font, focus ring, reduced motion). Load Plus Jakarta Sans (weights 500 to 800) with
`next/font` and expose it as `--font-sans`, or rely on the system fallback.

```tsx
import { AppShell, Button } from '@canopy/ui';
import NextLink from 'next/link';

<AppShell renderLink={(p) => <NextLink {...p} />} … />;
```

Next.js already lists `@canopy/ui` in `transpilePackages`, since the package ships TypeScript source.

## Tokens in Tailwind

| Kind | Utilities |
|---|---|
| Colour | `bg-forest`, `text-muted`, `border-line-strong`, `text-crit-ink`, `bg-ok-soft`… Tailwind's default palette is removed: a colour that is not a token does not exist. |
| Type | `text-kpi`, `text-page`, `text-section`, `text-card`, `text-body`, `text-body-strong`, `text-meta`, `text-label uppercase` (size, line height, weight and tracking together) |
| Spacing | Tailwind's 4px steps. Tokens: space-1 `1`, space-2 `2`, space-3 `3`, space-3h `3.5`, space-4 `4`, space-5 `5.5`, space-6 `8`, space-7 `12` |
| Sizes | `h-control` 36, `h-control-compact` 32, `min-h-control-touch` 44, `w-sidebar`, `w-rail`, `h-topbar`, `w-drawer-lg`, `w-drawer-md` |
| Radius | `rounded-card`, `rounded-control`, `rounded-chip`, `rounded-tag`, `rounded-pill` |
| Other | `shadow-overlay` (overlays only), `z-sticky` … `z-toast`, `duration-fast/base/slow`, `ease-out`, breakpoints `sm:` 640px and `lg:` 1100px, `tabular`, `touch-target` |

`src/tokens.css` is the source of truth. `src/tokens.ts` mirrors it for code (charts, the contrast audit) and
`tokens.test.ts` fails if the CSS, the TypeScript, the preset and `spec/tokens.json` drift apart. `contrast.test.ts`
re-runs the WCAG audit from `spec/foundations.md` §1.4 on every change.

## Develop

```
pnpm --filter @canopy/ui dev        # demo gallery on http://localhost:4310
pnpm --filter @canopy/ui test       # Vitest + Testing Library: keyboard and axe (structure) per component
pnpm --filter @canopy/ui test:e2e   # builds the gallery, then Playwright: axe with colour contrast, keyboard, 1280 and 375px
```

Every component gets a demo page in `demo/pages/`, listed in `demo/routes.ts`; the Playwright suite visits every route
in that list at both widths, so a new page is checked without writing a new test.

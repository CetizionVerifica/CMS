// Canopy Tailwind preset. Every utility resolves to a CSS variable from src/tokens.css, so the browser has one source
// of truth and a future theme only redefines variables. Tailwind's default colour palette is replaced, not extended:
// a colour that is not a token does not exist (apps/web/CLAUDE.md: no colours outside the tokens).
//
// Tailwind v4 loads it through `@config` in src/styles.css; a v3-style config can list it under `presets`.
import type { Config } from 'tailwindcss';

import { breakpoints, colors, radius, size, space, type, zIndex } from './src/tokens';

/** Tailwind spacing step for each spacing token (Tailwind's step is 4px). */
export const spacingScale: Record<keyof typeof space, string> = {
  '1': '1',
  '2': '2',
  '3': '3',
  '3h': '3.5',
  '4': '4',
  '5': '5.5',
  '6': '8',
  '7': '12',
};

const v = (name: string): string => `var(--${name})`;
const fromKeys = <K extends string>(keys: readonly K[], prefix = ''): Record<K, string> =>
  Object.fromEntries(keys.map((k) => [k, v(`${prefix}${k}`)])) as Record<K, string>;
const keys = <T extends object>(o: T) => Object.keys(o) as (keyof T & string)[];

// Layout sizes as spacing keys: `h-control`, `w-sidebar`, `h-topbar`, `w-drawer-lg`.
const sizeSpacing = Object.fromEntries(keys(size).map((k) => [k, v(`size-${k}`)])) as Record<
  keyof typeof size,
  string
>;

const fontSize = Object.fromEntries(
  Object.entries(type).map(([name, t]) => [
    name,
    [
      t.size,
      {
        lineHeight: t.lineHeight,
        fontWeight: String(t.weight),
        ...('tracking' in t ? { letterSpacing: t.tracking } : {}),
      },
    ],
  ]),
) as Record<
  keyof typeof type,
  [string, { lineHeight: string; fontWeight: string; letterSpacing?: string }]
>;

const preset = {
  content: [],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      inherit: 'inherit',
      ...fromKeys(keys(colors)),
    },
    screens: { ...breakpoints },
    fontFamily: { sans: v('font-sans') },
    extend: {
      // The spacing tokens sit on Tailwind's own 4px scale, so numeric utilities stay standard:
      // space-1..7 (4, 8, 12, 14, 16, 22, 32, 48px) are `1`, `2`, `3`, `3.5`, `4`, `5.5`, `8`, `12`.
      // `spacingScale` below is checked against src/tokens.ts by src/tokens.test.ts.
      spacing: sizeSpacing,
      borderRadius: fromKeys(keys(radius), 'radius-'),
      boxShadow: { overlay: v('shadow-overlay') },
      zIndex: fromKeys(keys(zIndex), 'z-'),
      transitionTimingFunction: { out: v('ease-out') },
      transitionDuration: { fast: v('dur-fast'), base: v('dur-base'), slow: v('dur-slow') },
      fontSize,
    },
  },
} satisfies Config;

export default preset;

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import preset, { spacingScale } from '../tailwind.preset';
import { parseColor } from './contrast';
import * as tokens from './tokens';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Custom properties declared in tokens.css, values normalised (lower case, no spaces). */
function cssVars(): Map<string, string> {
  const css = read('./tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars.set(m[1]!, norm(m[2]!));
  return vars;
}
/** Normalises a CSS value: no spaces, lower case, leading zero on decimals, no trailing zeros. */
const norm = (v: string) =>
  v
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/(^|[^\d])\.(\d)/g, '$10.$2')
    .replace(/(\.\d*?[1-9])0+(?!\d)/g, '$1')
    .replace(/\.0+(?!\d)/g, '');

const specTokens = JSON.parse(read('../spec/tokens.json')) as {
  color: Record<string, { $value: string }>;
  space: Record<string, { $value: string }>;
  radius: Record<string, { $value: string }>;
  size: Record<string, { $value: string }>;
  z: Record<string, number>;
  motion: Record<string, string>;
};

describe('tokens.css is the source of truth and tokens.ts mirrors it', () => {
  const vars = cssVars();

  it.each(Object.entries(tokens.colors))('colour --%s', (name, value) => {
    expect(parseColor(vars.get(name)!)).toEqual(parseColor(value));
  });
  it.each(Object.entries(tokens.space))('space --space-%s', (name, value) => {
    expect(vars.get(`space-${name}`)).toBe(value);
  });
  it.each(Object.entries(tokens.radius))('radius --radius-%s', (name, value) => {
    expect(vars.get(`radius-${name}`)).toBe(value);
  });
  it.each(Object.entries(tokens.size))('size --size-%s', (name, value) => {
    expect(vars.get(`size-${name}`)).toBe(value);
  });
  it.each(Object.entries(tokens.zIndex))('z --z-%s', (name, value) => {
    expect(vars.get(`z-${name}`)).toBe(String(value));
  });
  it.each(Object.entries(tokens.motion))('motion --%s', (name, value) => {
    expect(vars.get(name)).toBe(norm(value));
  });
  it('shadow --shadow-overlay', () => {
    expect(vars.get('shadow-overlay')).toBe(norm(tokens.shadow.overlay));
  });
  it('declares no colour that tokens.ts does not know', () => {
    const known = new Set<string>(Object.keys(tokens.colors));
    const prefixes = ['space-', 'radius-', 'size-', 'shadow-', 'z-', 'dur-', 'ease-', 'font-'];
    const unknown = [...vars.keys()].filter(
      (k) => !known.has(k) && !prefixes.some((p) => k.startsWith(p)),
    );
    expect(unknown).toEqual([]);
  });
});

describe('tokens match spec/tokens.json', () => {
  it.each(Object.entries(specTokens.color))('colour %s', (name, { $value }) => {
    expect(parseColor(tokens.colors[name as tokens.ColorToken])).toEqual(parseColor($value));
  });
  it('space, radius, size, z and motion', () => {
    for (const [k, { $value }] of Object.entries(specTokens.space))
      expect(tokens.space[k as keyof typeof tokens.space]).toBe($value);
    for (const [k, { $value }] of Object.entries(specTokens.radius))
      expect(tokens.radius[k as keyof typeof tokens.radius]).toBe($value);
    for (const [k, { $value }] of Object.entries(specTokens.size))
      expect(tokens.size[k as keyof typeof tokens.size]).toBe($value);
    expect(tokens.zIndex).toEqual(specTokens.z);
    expect(tokens.motion).toEqual(specTokens.motion);
  });
});

describe('tailwind.preset.ts mirrors the tokens', () => {
  const theme = preset.theme;

  it('replaces the default palette with exactly the colour tokens', () => {
    const names = Object.keys(theme.colors).filter(
      (k) => !['transparent', 'current', 'inherit'].includes(k),
    );
    expect(names.sort()).toEqual(Object.keys(tokens.colors).sort());
    for (const name of names)
      expect(theme.colors[name as tokens.ColorToken]).toBe(`var(--${name})`);
  });

  it('maps each spacing token to a Tailwind step of 4px', () => {
    for (const [name, step] of Object.entries(spacingScale)) {
      expect(`${Number(step) * 4}px`).toBe(tokens.space[name as keyof typeof tokens.space]);
    }
  });

  it('exposes radius, size, z, motion, breakpoints and type', () => {
    for (const k of Object.keys(tokens.radius))
      expect(theme.extend.borderRadius[k as keyof typeof tokens.radius]).toBe(`var(--radius-${k})`);
    for (const k of Object.keys(tokens.size))
      expect(theme.extend.spacing[k as keyof typeof tokens.size]).toBe(`var(--size-${k})`);
    for (const k of Object.keys(tokens.zIndex))
      expect(theme.extend.zIndex[k as keyof typeof tokens.zIndex]).toBe(`var(--z-${k})`);
    expect(theme.extend.transitionDuration).toEqual({
      fast: 'var(--dur-fast)',
      base: 'var(--dur-base)',
      slow: 'var(--dur-slow)',
    });
    expect(theme.screens).toEqual(tokens.breakpoints);
    expect(theme.extend.fontSize.kpi).toEqual([
      '26px',
      { lineHeight: '30px', fontWeight: '800', letterSpacing: '-0.02em' },
    ]);
    expect(theme.extend.fontSize.body).toEqual(['14px', { lineHeight: '21px', fontWeight: '500' }]);
  });

  it('keeps every text size at or above the 12px floor', () => {
    for (const t of Object.values(tokens.type))
      expect(parseInt(t.size, 10)).toBeGreaterThanOrEqual(12);
  });
});

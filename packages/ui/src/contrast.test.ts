import { describe, expect, it } from 'vitest';

import { contrastRatio, flatten, parseColor } from './contrast';
import { colors as c } from './tokens';

const hex = (rgba: { r: number; g: number; b: number }) =>
  `#${[rgba.r, rgba.g, rgba.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;

describe('contrast maths', () => {
  it('parses hex, short hex and rgba', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#1F6B47')).toEqual({ r: 31, g: 107, b: 71, a: 1 });
    expect(parseColor('rgba(19,34,26,0.40)')).toEqual({ r: 19, g: 34, b: 26, a: 0.4 });
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(() => parseColor('red')).toThrow('Unsupported colour');
  });
  it('matches known WCAG values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
  it('composites translucent colours', () => {
    expect(hex(flatten('rgba(255,255,255,0.5)', '#000000'))).toBe('#808080');
  });
});

// foundations.md §1.4. Text needs 4.5:1, control boundaries and non-text fills 3:1.
const forestSelected = hex(flatten(c['on-forest-selected'], c.forest));
const forestHover = hex(flatten(c['on-forest-hover'], c.forest));

const text: Array<[string, string, string]> = [
  ['ink on mist', c.ink, c.mist],
  ['ink on surface', c.ink, c.surface],
  ['ink on neutral-soft (badge)', c.ink, c['neutral-soft']],
  ['muted on mist', c.muted, c.mist],
  ['muted on surface', c.muted, c.surface],
  ['muted on neutral-soft', c.muted, c['neutral-soft']],
  ['on-forest on forest', c['on-forest'], c.forest],
  ['on-forest on forest-hover', c['on-forest'], c['forest-hover']],
  ['on-forest-muted on forest', c['on-forest-muted'], c.forest],
  ['on-forest on nav hover and help card', c['on-forest'], forestHover],
  ['on-forest on selected nav item', c['on-forest'], forestSelected],
  ['forest on sage (FY chip, avatar)', c.forest, c.sage],
  ['forest on surface (links)', c.forest, c.surface],
  ['forest on mist (ghost button hover)', c.forest, c.mist],
  ['ok-ink on ok-soft', c['ok-ink'], c['ok-soft']],
  ['warn-ink on warn-soft', c['warn-ink'], c['warn-soft']],
  ['crit-ink on crit-soft', c['crit-ink'], c['crit-soft']],
  ['crit-ink on surface (field error)', c['crit-ink'], c.surface],
  ['white on crit (danger button)', c['on-forest'], c.crit],
  ['white on crit-ink (danger hover)', c['on-forest'], c['crit-ink']],
  ['surface on ink (tooltip)', c.surface, c.ink],
];

const nonText: Array<[string, string, string]> = [
  ['line-strong on surface (control border)', c['line-strong'], c.surface],
  ['line-strong on mist', c['line-strong'], c.mist],
  ['leaf fill on sage track', c.leaf, c.sage],
  ['focus ring forest on mist', c.forest, c.mist],
  ['focus ring forest on sage', c.forest, c.sage],
  ['focus ring on-forest on forest', c['on-forest'], c.forest],
  ['crit error border on surface', c.crit, c.surface],
];

describe('token contrast audit (foundations §1.4)', () => {
  it.each(text)('%s ≥ 4.5:1', (_, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(nonText)('%s ≥ 3:1', (_, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3);
  });
  it('documents why status base colours are not text colours', () => {
    expect(contrastRatio(c.warn, c['warn-soft'])).toBeLessThan(4.5);
    expect(contrastRatio(c.muted, c.sage)).toBeLessThan(4.5);
    expect(contrastRatio(c.line, c.surface)).toBeLessThan(3);
    // So nav hover and the help card use --on-forest text, not --on-forest-muted (4.0:1).
    expect(contrastRatio(c['on-forest-muted'], forestHover)).toBeLessThan(4.5);
  });
});

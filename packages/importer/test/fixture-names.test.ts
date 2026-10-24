import { describe, expect, it } from 'vitest';
import { loadSheet } from './helpers.js';

/**
 * The anonymised golden fixture (fixtures/README.md) must hold no real group, company or town name, in any cell
 * or header. The list is the project's banned-name list; matching is case-insensitive and ignores word boundaries.
 */
const BANNED = [
  'aditya',
  'birla',
  'hindalco',
  'grasim',
  'novelis',
  'tata',
  'belur',
  'renukoot',
  'hirakud',
];

describe('sample-register-anonymised.xlsx', () => {
  it('names no real company or town', async () => {
    const sheet = await loadSheet('sample-register-anonymised.xlsx');
    const texts = [
      ...sheet.headers,
      ...sheet.rows.flatMap((row) => Object.values(row.cells).map((cell) => String(cell ?? ''))),
    ].map((text) => text.toLowerCase());
    const found = BANNED.filter((name) => texts.some((text) => text.includes(name)));
    expect(found).toEqual([]);
  });
});

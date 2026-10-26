import { describe, expect, it } from 'vitest';

import { isoOn, sourceFromParams, sourceOfTicks, SOURCE_OPTIONS, withSource } from './source';

const p = (s: string) => new URLSearchParams(s);

describe('the Source filter’s URL state', () => {
  it('is on only for an account with the ISO add-on', () => {
    expect(isoOn(['isoManagement'])).toBe(true);
    expect(isoOn(['somethingElse'])).toBe(false);
    expect(isoOn([])).toBe(false);
  });

  it('reads LAW or ISO with the add-on, and ignores a stale or unknown value', () => {
    expect(sourceFromParams(p('source=LAW'), true)).toBe('LAW');
    expect(sourceFromParams(p('source=ISO'), true)).toBe('ISO');
    expect(sourceFromParams(p('source=iso'), true)).toBeUndefined();
    expect(sourceFromParams(p('source='), true)).toBeUndefined();
    expect(sourceFromParams(p(''), true)).toBeUndefined();
    // Without the add-on a source left in a link means nothing: the API lists statutory work only anyway.
    expect(sourceFromParams(p('source=ISO'), false)).toBeUndefined();
    expect(sourceFromParams(p('source=LAW'), false)).toBeUndefined();
  });

  it('writes one source and leaves both out, keeping the rest of the URL', () => {
    expect(withSource('fy=2024-25&q=Q3', 'ISO').toString()).toBe('fy=2024-25&q=Q3&source=ISO');
    expect(withSource('source=ISO&m=2024-11', 'LAW').toString()).toBe('source=LAW&m=2024-11');
    expect(withSource('source=ISO&m=2024-11', undefined).toString()).toBe('m=2024-11');
    expect(withSource('', undefined).toString()).toBe('');
  });

  it('turns a FilterBar’s ticks into a source: one is that source, none or both is both', () => {
    expect(sourceOfTicks(['LAW'])).toBe('LAW');
    expect(sourceOfTicks(['ISO'])).toBe('ISO');
    expect(sourceOfTicks(['LAW', 'ISO'])).toBeUndefined();
    expect(sourceOfTicks([])).toBeUndefined();
    expect(sourceOfTicks(undefined)).toBeUndefined();
    expect(sourceOfTicks(['NOPE'])).toBeUndefined();
  });

  it('names the choices Law and ISO, in that order', () => {
    expect(SOURCE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['LAW', 'Law'],
      ['ISO', 'ISO'],
    ]);
  });
});

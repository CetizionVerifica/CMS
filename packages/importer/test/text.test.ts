import { describe, expect, it } from 'vitest';
import { actKey, aliasKey, principalActKey } from '../src/aliases.js';
import {
  countryCodeOf,
  looksLikeFileName,
  stateCodeForName,
  stateCodeOf,
  stateNamedIn,
} from '../src/reference.js';
import {
  NearIndex,
  deletionVariants,
  collapse,
  editDistance,
  groupKeyOf,
  looseKey,
  mostFrequent,
  normaliseName,
  tidyMultiline,
  titleCaseName,
} from '../src/text.js';

describe('text helpers', () => {
  it('collapses whitespace and keeps line breaks where asked', () => {
    expect(collapse('  a \t b\n c ')).toBe('a b c');
    expect(tidyMultiline(' 1.  Pay \r\n\r\n\r\n\r\n2. File  \n')).toBe('1. Pay\n\n2. File');
    expect(normaliseName('  Person   ALPHA ')).toBe('person alpha');
    expect(looseKey("Employees' State (Insurance), 1948")).toBe('employees state insurance 1948');
  });

  it('title-cases names but keeps initials and mixed case', () => {
    expect(titleCaseName('person alpha')).toBe('Person Alpha');
    expect(titleCaseName('PERSON ALPHA')).toBe('Person Alpha');
    expect(titleCaseName('MV raghu')).toBe('MV Raghu');
    expect(titleCaseName('McKay o')).toBe('McKay O');
  });

  it('computes bounded edit distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
    expect(editDistance('abcdef', 'uvwxyz', 2)).toBe(3);
  });

  it('hashes group keys so values never appear in them', () => {
    const key = groupKeyOf('PERSON_CASE_MERGE', 'owner', 'person alpha');
    expect(key).toMatch(/^PERSON_CASE_MERGE-[0-9a-f]{20}$/);
    expect(key).not.toContain('alpha');
    expect(groupKeyOf('PERSON_CASE_MERGE', 'owner', 'person alpha')).toBe(key);
  });

  it('picks the most frequent value, first seen on a tie', () => {
    expect(
      mostFrequent(
        new Map([
          ['a', 1],
          ['b', 3],
          ['c', 3],
        ]),
      ),
    ).toBe('b');
    expect(() => mostFrequent(new Map())).toThrow();
  });
});

describe('NearIndex', () => {
  it('finds exactly the names within two edits', () => {
    expect(deletionVariants('abc', 1)).toEqual(new Set(['abc', 'bc', 'ac', 'ab']));
    const names = ['asha rao', 'asha raoo', 'asha r', 'vikram shah', 'asha rai', 'usha rao', 'ash'];
    const index = new NearIndex(names, 2);
    expect(index.near('asha rao')).toEqual(['asha r', 'asha rai', 'asha raoo', 'usha rao']);
    expect(index.near('vikram shah')).toEqual([]);
    // Brute force agrees for every name.
    for (const name of names) {
      const brute = names
        .filter((other) => other !== name && editDistance(name, other) <= 2)
        .sort();
      expect(index.near(name)).toEqual(brute);
    }
  });
});

describe('alias keys', () => {
  it('reads Petroleum Rules year variants as one Act', () => {
    const keys = [
      'Petroleum Act, 1934 read with Petroleum Rules 2002',
      'The Petroleum Act, 1934 and Petroleum Rules, 2003',
      'The Petroleum Act, 1934 & Petroleum Rules, 2005',
    ].map(actKey);
    expect(new Set(keys)).toEqual(new Set(['petroleum act 1934 and petroleum rules']));
  });

  it('keeps different rules under one principal Act apart', () => {
    expect(
      actKey('Environment (Protection) Act, 1986 and Solid Waste Management Rules, 2016'),
    ).not.toBe(
      actKey(
        'Environment (Protection) Act, 1986 and Plastic Waste (Management and Handling) Rules, 2016',
      ),
    );
    expect(
      principalActKey(actKey('Factories Act, 1948 and West Bengal Factories Rules, 1958')),
    ).toBe('factories act 1948');
    expect(principalActKey('no year here')).toBe(null);
  });

  it('matches plural and seeded department and category spellings', () => {
    expect(aliasKey('category', 'Procedural Requirements')).toBe(
      aliasKey('category', 'Procedural Requirement'),
    );
    expect(aliasKey('category', 'Statutory Registers and Records')).toBe(
      aliasKey('category', 'Statutory Records'),
    );
    expect(aliasKey('department', 'HR')).toBe(aliasKey('department', 'Human Resources'));
    expect(aliasKey('department', 'Business')).toBe('business');
    expect(aliasKey('act', 'Factories Act , 1948')).toBe('factories act 1948');
  });
});

describe('reference data', () => {
  it('knows Indian states by code, old code and name', () => {
    expect(stateCodeOf('wb')).toBe('WB');
    expect(stateCodeOf('OR')).toBe('OD');
    expect(stateCodeOf('ZZ')).toBe(null);
    expect(stateCodeForName('west  bengal')).toBe('WB');
    expect(stateCodeForName('Bavaria')).toBe(null);
    expect(stateNamedIn("West Bengal Workmen's House Rent Allowance Act, 1974")).toBe('WB');
    expect(stateNamedIn('Factories Act, 1948')).toBe(null);
  });

  it('knows countries by name or ISO code', () => {
    expect(countryCodeOf('India')).toBe('IN');
    expect(countryCodeOf('np')).toBe('NP');
    expect(countryCodeOf('Atlantis')).toBe(null);
  });

  it('spots attachment file names', () => {
    expect(looksLikeFileName('Schedule.docx')).toBe(true);
    expect(looksLikeFileName('Form No. 6')).toBe(false);
  });
});

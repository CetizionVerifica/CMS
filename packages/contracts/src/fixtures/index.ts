// @canopy/contracts/fixtures: typed fixtures for tests, seeds and the mock API (docs/contracts/fixtures.md).
// Node only (reads files); the browser entry `@canopy/contracts` exports the schemas but not this loader.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DueDatesFixture, ExpectedFixture, FixtureSet } from './schema.js';

export * from './schema.js';

/** Namespace for fixture ids. Changing it changes every fixture id. */
export const FIXTURE_NAMESPACE = '3d0c6f0e-8a5b-4c1e-9f27-6b1d2e4a7c90';

/** RFC 9562 UUID version 5 of `name` in `namespace`. */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Deterministic id from a natural key, e.g. `fixtureId('obligation:TAX-CL-033-6067-60218')`. */
export function fixtureId(key: string): string {
  return uuidV5(key, FIXTURE_NAMESPACE);
}

export type FixtureSetName = 'firm-a.sample' | 'firm-b.synthetic';

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/${file}`, import.meta.url), 'utf8'));
}

/** A firm's fixture set, parsed with the strict entity schemas. */
export function loadFixtureSet(name: FixtureSetName): FixtureSet {
  return FixtureSet.parse(readJson(`${name}.json`));
}

/** Firm A's due dates per obligation and the rules M0 expects inferRule to return. */
export function loadDueDates(): DueDatesFixture {
  return DueDatesFixture.parse(readJson('firm-a.due-dates.json'));
}

/** Firm A's golden counts and scores. */
export function loadExpected(): ExpectedFixture {
  return ExpectedFixture.parse(readJson('firm-a.expected.json'));
}

// @canopy/contracts/fixtures: typed fixtures for tests, seeds and the mock API (docs/contracts/fixtures.md).
// Node only (reads files); the browser entry `@canopy/contracts` exports the schemas but not this loader.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import type { IsoStandardCode } from '../enums.js';
import type {
  IsoClause,
  IsoReviewInputDef,
  IsoReviewOutputDef,
  IsoStandard,
} from '../schemas/iso.js';
import type { Act, Category, Obligation } from '../schemas/library.js';
import {
  DueDatesFixture,
  ExpectedFixture,
  FixtureSet,
  IsoCatalogueFixture,
  IsoFixtureSet,
} from './schema.js';

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

/**
 * Firm B's "today": the day after which nothing in its data has happened yet (its last recorded activity is on
 * 2024-11-06). Pin a mock server serving firm B to it (`createMockServer({ today: FIRM_B_AS_OF })`) so derived
 * statuses and scores agree with the data: an earlier date shows items approved in the future as complied while no
 * item is due yet. It falls in FY 2024-25 Q3 for Northwind (April FY) and FY 2024-25 Q4 for Harbour (January FY).
 */
export const FIRM_B_AS_OF = '2024-11-15';

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

// ---------- ISO add-on ----------

/** Namespace for an account's ISO catalogue ids. Changing it changes every catalogue id in the fixtures. */
export const ISO_CATALOGUE_NAMESPACE = '6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a09';

/**
 * The id of a row of one account's copy of the ISO catalogue, the same on every load: `isoCatalogueId(firmId,
 * 'clause:ISO_14001:2015+A1:2024:6.1.2')`. Keys: `standard:<code>:<edition>`, `clause:<code>:<edition>:<number>`,
 * `review-input:<code>:<key>:<clause>:<item>`, `review-output:<code>:<key>:<clause>:<item>`, `act:<act key>`,
 * `category`, `obligation:<activity key>` (an empty item is "-").
 */
export function isoCatalogueId(firmId: string, key: string): string {
  return uuidV5(`${firmId}:${key}`, ISO_CATALOGUE_NAMESPACE);
}

/** The id of a clause in one account's copy, e.g. `isoClauseId(firmId, 'ISO_9001', '7.1.5')`. */
export function isoClauseId(firmId: string, standard: IsoStandardCode, number: string): string {
  const edition = loadIsoCatalogue().standards.find((s) => s.code === standard)!.edition;
  return isoCatalogueId(firmId, `clause:${standard}:${edition}:${number}`);
}

let catalogue: IsoCatalogueFixture | undefined;

/** The ISO catalogue an account's copy starts from (numbers, titles and our own summaries). */
export function loadIsoCatalogue(): IsoCatalogueFixture {
  catalogue ??= IsoCatalogueFixture.parse(readJson('iso.catalogue.json'));
  return catalogue;
}

/** Firm B's ISO add-on data (Northwind Foods Group's integrated management system). */
export function loadIsoFixtureSet(): IsoFixtureSet {
  return IsoFixtureSet.parse(readJson('firm-b.iso.json'));
}

/** One account's copy of the catalogue, as plain JSON rows. */
export interface IsoCatalogueRows {
  standards: z.input<typeof IsoStandard>[];
  clauses: z.input<typeof IsoClause>[];
  reviewInputDefs: z.input<typeof IsoReviewInputDef>[];
  reviewOutputDefs: z.input<typeof IsoReviewOutputDef>[];
  acts: z.input<typeof Act>[];
  category: z.input<typeof Category>;
  obligations: z.input<typeof Obligation>[];
}

/**
 * What the catalogue copy (docs/iso/catalogue.md §1) writes into an account at `at`: the catalogue tables, the four
 * STANDARD acts, their category and one obligation per activity. Ids come from `isoCatalogueId`.
 */
export function isoCatalogueRows(firmId: string, at: string): IsoCatalogueRows {
  const cat = loadIsoCatalogue();
  const id = (key: string) => isoCatalogueId(firmId, key);
  const base = (key: string) => ({
    id: id(key),
    firmId,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
  });
  const edition = (code: IsoStandardCode) => cat.standards.find((s) => s.code === code)!.edition;
  const standardId = (code: IsoStandardCode) => id(`standard:${code}:${edition(code)}`);
  const clauseKey = (code: IsoStandardCode, number: string) =>
    `clause:${code}:${edition(code)}:${number}`;
  const categoryRow = { ...base('category'), version: 1, name: cat.category, aliases: [] };
  const acts = cat.acts.map((a) => ({
    ...base(`act:${a.key}`),
    version: 1,
    name: a.name,
    shortName: a.shortName,
    jurisdiction: 'CENTRAL' as const,
    stateCode: null,
    aliases: [],
    kind: 'STANDARD' as const,
  }));
  return {
    standards: cat.standards.map((s) => ({
      ...base(`standard:${s.code}:${s.edition}`),
      code: s.code,
      edition: s.edition,
      title: s.title,
      topic: s.topic,
    })),
    clauses: cat.clauses.map((c) => ({
      ...base(clauseKey(c.standard, c.number)),
      standardId: standardId(c.standard),
      number: c.number,
      title: c.title,
      summary: c.summary,
      parentId: c.parent === null ? null : id(clauseKey(c.standard, c.parent)),
      hlsKey: c.hlsKey,
      assessable: c.assessable,
      exclusionAllowed: c.exclusionAllowed,
    })),
    reviewInputDefs: cat.reviewInputs.map((d) => ({
      ...base(`review-input:${d.standard}:${d.key}:${d.clauseNumber}:${d.item ?? '-'}`),
      standardId: standardId(d.standard),
      key: d.key,
      clauseNumber: d.clauseNumber,
      item: d.item,
      title: d.title,
      source: d.source,
    })),
    reviewOutputDefs: cat.reviewOutputs.map((d) => ({
      ...base(`review-output:${d.standard}:${d.key}:${d.clauseNumber}:${d.item ?? '-'}`),
      standardId: standardId(d.standard),
      key: d.key,
      clauseNumber: d.clauseNumber,
      item: d.item,
      title: d.title,
    })),
    acts,
    category: categoryRow,
    obligations: cat.activities.map((a) => ({
      ...base(`obligation:${a.key}`),
      version: 1,
      externalRef: `ISO-${a.key}`,
      domain: 'OTHER' as const,
      jurisdiction: 'CENTRAL' as const,
      stateCode: null,
      actId: id(`act:${a.act}`),
      categoryId: categoryRow.id,
      title: a.title,
      description: `Evidence: ${a.evidence}`,
      applicabilityText: null,
      criticality: 'MEDIUM' as const,
      timelineType: 'TIME_BASED' as const,
      recurrenceRule: a.rule,
      ruleStatus: 'CONFIRMED' as const,
      evidenceRequired: true,
      forms: [],
      logSheets: [],
      libraryVersion: 1,
      clauseRefs: a.clauseRefs,
    })),
  };
}

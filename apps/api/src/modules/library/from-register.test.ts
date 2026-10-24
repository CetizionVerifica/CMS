import {
  Act,
  Category,
  Obligation,
  type Criticality,
  type ObligationDomain,
} from '@canopy/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { keyed, masterFromPlan } from './from-register.js';
import { checkMasterLibrary, MASTER_LIBRARY, type MasterLibrary } from './master.js';
import { SAMPLE_ACT_NAMES, SAMPLE_TITLES, sampleRegisterPlan } from './testing/register.js';

// Master library v2 (ADR M6-0002): the statutory part of the anonymised sample register.
const SERVER = {
  id: '01920000-0000-7000-8000-000000000001',
  firmId: '01920000-0000-7000-8000-000000000002',
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
  archivedAt: null,
  version: 1,
};
const REF = '01920000-0000-7000-8000-000000000003';

describe('master library v2', () => {
  let built: MasterLibrary;
  let people: string[];
  beforeAll(async () => {
    const plan = await sampleRegisterPlan();
    people = plan.people.map((p) => p.nameNormalized);
    built = masterFromPlan(plan, MASTER_LIBRARY.version, {
      actNames: SAMPLE_ACT_NAMES,
      titles: SAMPLE_TITLES,
    });
  }, 30_000);

  it('is the generated file, unchanged: rerun testing/write-master.ts after changing the register or import', () => {
    expect(MASTER_LIBRARY).toEqual(built);
  });

  it('holds the counts of the recommended import (docs/contracts/fixtures.md §3)', () => {
    expect(MASTER_LIBRARY.version).toBe(2);
    expect(MASTER_LIBRARY.categories).toHaveLength(10);
    expect(MASTER_LIBRARY.acts).toHaveLength(33);
    expect(MASTER_LIBRARY.obligations).toHaveLength(119);
    expect(new Set(MASTER_LIBRARY.obligations.map((o) => o.externalRef)).size).toBe(119);
    expect(() => checkMasterLibrary(MASTER_LIBRARY)).not.toThrow();
  });

  it('keeps each low-confidence rule TO_REVIEW, so nothing is generated from a guess', () => {
    const toReview = MASTER_LIBRARY.obligations.filter((o) => o.ruleStatus === 'TO_REVIEW');
    expect(toReview).toHaveLength(6);
    expect(MASTER_LIBRARY.obligations.every((o) => o.evidenceRequired === false)).toBe(true);
  });

  it('passes the contract schemas row by row', () => {
    // Bundle-only keys are dropped as the copy drops them.
    for (const c of MASTER_LIBRARY.categories) {
      const row = { ...SERVER, name: c.name, aliases: c.aliases };
      expect(Category.safeParse(row).error).toBeUndefined();
    }
    for (const a of MASTER_LIBRARY.acts) {
      const row: Record<string, unknown> = { ...SERVER, ...a };
      delete row.key;
      expect(Act.safeParse(row).error).toBeUndefined();
    }
    for (const o of MASTER_LIBRARY.obligations) {
      const row: Record<string, unknown> = { ...SERVER, ...o, actId: REF, categoryId: REF };
      delete row.act;
      delete row.category;
      row.libraryVersion = 2;
      expect(Obligation.safeParse(row).error).toBeUndefined();
    }
  });

  it('names no unit, company or person: only Acts, categories and obligations', () => {
    const text = JSON.stringify(MASTER_LIBRARY).toLowerCase();
    expect(people).toHaveLength(21);
    for (const name of [
      'kestrel',
      'riverbend',
      'kestrelganj',
      'osprey',
      'stonebridge',
      'highmoor',
      ...people,
    ])
      expect(text).not.toContain(name);
    expect(MASTER_LIBRARY.acts.map((a) => a.name)).toContain(
      'Water (Prevention and Control of Pollution) Act, 1974 and Air (Prevention and Control of Pollution) Act, 1981',
    );
  });

  it('carries no licence, consent or registration number', () => {
    // Numbers of published standards the statutory text cites (EN 13458, EN 13530, IEC 60079).
    const standards = new Set(['13458', '13530', '60079']);
    const texts = [
      ...MASTER_LIBRARY.acts.map((a) => a.name),
      ...MASTER_LIBRARY.obligations.flatMap((o) => [
        o.title,
        o.description,
        o.applicabilityText ?? '',
        ...[...o.forms, ...o.logSheets].map((t) => `${t.label} ${t.fileName ?? ''}`),
      ]),
    ];
    const found = texts.flatMap((t) => [
      ...(t.match(/[A-Z]+\/[A-Z]+\/[A-Z]{0,4}\/?[0-9]/g) ?? []),
      ...(t.match(/[0-9]{5,}/g) ?? []).filter((n) => !standards.has(n)),
    ]);
    expect(found).toEqual([]);
    expect(MASTER_LIBRARY.obligations.find((o) => o.externalRef === 'INT-H-056-0001')?.title).toBe(
      'Fire licence for storing or processing hazardous substances',
    );
  });

  it('spans the domains and criticalities of the register', () => {
    const domains = new Set<ObligationDomain>(MASTER_LIBRARY.obligations.map((o) => o.domain));
    expect([...domains].sort()).toEqual(['EHS', 'ENG', 'ENV', 'HRS', 'INT', 'IT', 'TAX']);
    const levels = new Set<Criticality>(MASTER_LIBRARY.obligations.map((o) => o.criticality));
    expect(levels.size).toBe(5);
  });
});

describe('keyed', () => {
  it('makes readable keys and numbers a clash', () => {
    const keys = keyed(['Factories Act, 1948', 'factories act 1948', '!!!']);
    expect(keys.get('Factories Act, 1948')).toBe('factories-act-1948');
    expect(keys.get('factories act 1948')).toBe('factories-act-1948-2');
    expect(keys.get('!!!')).toBe('item');
  });

  it('refuses a plan whose obligation names an Act the plan does not hold', () => {
    const plan = { acts: [], categories: [], obligations: [{ act: 'Mines Act', category: 'x' }] };
    expect(() =>
      masterFromPlan({ ...(plan as unknown as Parameters<typeof masterFromPlan>[0]) }, 1),
    ).toThrow();
  });
});

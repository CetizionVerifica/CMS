import { readFileSync } from 'node:fs';
import { IsoClause, IsoReviewInputDef, IsoReviewOutputDef, IsoStandard } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkIsoCatalogue,
  compareClauseNumbers,
  ISO_9001_EXCLUDABLE,
  ISO_CATALOGUE,
  type IsoCatalogue,
} from './iso-catalogue.js';
import { MASTER_LIBRARY } from './master.js';

const ID = '01920000-0000-7000-8000-000000000001';
const server = {
  id: ID,
  firmId: ID,
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T00:00:00.000Z',
  archivedAt: null,
};

/** The activity keys of docs/iso/catalogue.md §3, the brief's source of truth. */
function documentedActivities(): string[] {
  const doc = readFileSync(
    new URL('../../../../../docs/iso/catalogue.md', import.meta.url),
    'utf8',
  );
  const section = doc.slice(doc.indexOf('## 3.'), doc.indexOf('## 4.'));
  return [...section.matchAll(/^\| `([A-Z][A-Z-]+)`/gm)].map((m) => m[1]!);
}

describe('the ISO catalogue (ADR M6-0003)', () => {
  it('passes its own check', () => {
    expect(() => checkIsoCatalogue(ISO_CATALOGUE)).not.toThrow();
  });

  it('has each activity of catalogue §3 exactly once', () => {
    const documented = documentedActivities();
    expect(documented).toHaveLength(13);
    expect(ISO_CATALOGUE.activities.map((a) => a.key).sort()).toEqual([...documented].sort());
    for (const a of ISO_CATALOGUE.activities) expect(a.externalRef).toBe(`ISO-${a.key}`);
  });

  it('seeds the three editions, and every row fits its contract', () => {
    expect(ISO_CATALOGUE.standards.map((s) => `${s.code} ${s.edition}`)).toEqual([
      'ISO_9001 2015+A1:2024',
      'ISO_14001 2015+A1:2024',
      'ISO_45001 2018+A1:2024',
    ]);
    for (const { clauses, reviewInputs, reviewOutputs, ...standard } of ISO_CATALOGUE.standards) {
      IsoStandard.parse({ ...server, ...standard });
      for (const { parent, ...c } of clauses) {
        IsoClause.parse({ ...server, ...c, standardId: ID, parentId: parent === null ? null : ID });
      }
      for (const d of reviewInputs) IsoReviewInputDef.parse({ ...server, ...d, standardId: ID });
      for (const d of reviewOutputs) IsoReviewOutputDef.parse({ ...server, ...d, standardId: ID });
    }
  });

  it('allows exclusions on the confirmed ISO 9001 clauses only', () => {
    const [q, e, h] = ISO_CATALOGUE.standards;
    expect(q!.clauses.filter((c) => c.exclusionAllowed).map((c) => c.number)).toEqual(
      [...ISO_9001_EXCLUDABLE].sort(compareClauseNumbers),
    );
    expect([...e!.clauses, ...h!.clauses].some((c) => c.exclusionAllowed)).toBe(false);
    // 8.3 has sub-clauses, so it is not itself assessable; its sub-clauses are.
    expect(q!.clauses.find((c) => c.number === '8.3')).toMatchObject({
      assessable: false,
      exclusionAllowed: false,
    });
  });

  it('derives parents, assessable clauses and shared-structure keys from the numbers', () => {
    const q = ISO_CATALOGUE.standards[0]!.clauses;
    const at = (n: string) => q.find((c) => c.number === n)!;
    expect(at('1')).toMatchObject({ parent: null, assessable: false, hlsKey: null });
    expect(at('4')).toMatchObject({ parent: null, assessable: false, hlsKey: '4' });
    expect(at('4.1')).toMatchObject({ parent: '4', assessable: true, hlsKey: '4.1' });
    expect(at('7.1.5.2')).toMatchObject({ parent: '7.1.5', assessable: true, hlsKey: '7.1' });
    expect(at('8.5.1')).toMatchObject({ parent: '8.5', assessable: true, hlsKey: null });
    expect(at('9.3')).toMatchObject({ assessable: false, hlsKey: '9.3' });
    // Clause numbers read in order, 4.10 after 4.9 and 10 after 9.
    expect(['10', '4.10', '4.9', '9'].sort(compareClauseNumbers)).toEqual([
      '4.9',
      '4.10',
      '9',
      '10',
    ]);
    expect(compareClauseNumbers('8.3', '8.3')).toBe(0);
    for (const s of ISO_CATALOGUE.standards) {
      expect(s.clauses.map((c) => c.number)).toEqual(
        [...s.clauses.map((c) => c.number)].sort(compareClauseNumbers),
      );
    }
  });

  it('files every activity under a STANDARD act with clause references, never in the master library', () => {
    expect(ISO_CATALOGUE.acts.map((a) => a.key)).toEqual([
      'ISO_9001',
      'ISO_14001',
      'ISO_45001',
      'ISO_IMS',
    ]);
    for (const a of ISO_CATALOGUE.acts) {
      expect(a).toMatchObject({ jurisdiction: 'CENTRAL', stateCode: null });
    }
    for (const a of ISO_CATALOGUE.activities) expect(a.clauseRefs.length).toBeGreaterThan(0);
    const names = new Set(ISO_CATALOGUE.acts.map((a) => a.name));
    expect(MASTER_LIBRARY.acts.some((a) => names.has(a.name) || a.kind === 'STANDARD')).toBe(false);
    expect(MASTER_LIBRARY.categories.some((c) => c.name === ISO_CATALOGUE.category)).toBe(false);
  });
});

describe('checkIsoCatalogue refuses', () => {
  const base = ISO_CATALOGUE;
  const [q, e, h] = base.standards as [
    IsoCatalogue['standards'][number],
    IsoCatalogue['standards'][number],
    IsoCatalogue['standards'][number],
  ];
  const withQ = (patch: Partial<typeof q>): IsoCatalogue => ({
    ...base,
    standards: [{ ...q, ...patch }, e, h],
  });
  const first = base.activities[0]!;
  const withActivity = (patch: Partial<typeof first>): IsoCatalogue => ({
    ...base,
    activities: [{ ...first, ...patch }, ...base.activities.slice(1)],
  });
  const refuses = (catalogue: IsoCatalogue, message: RegExp) =>
    expect(() => checkIsoCatalogue(catalogue)).toThrow(message);

  it('a repeated edition, clause, review key, act or activity', () => {
    refuses({ ...base, standards: [q, q, e, h] }, /edition "ISO_9001 2015\+A1:2024" is repeated/);
    refuses(withQ({ clauses: [...q.clauses, q.clauses[0]!] }), /ISO_9001 clause "1" is repeated/);
    refuses(
      withQ({ reviewInputs: [...q.reviewInputs, q.reviewInputs[0]!] }),
      /review input .* is repeated/,
    );
    refuses(
      withQ({ reviewOutputs: [...q.reviewOutputs, q.reviewOutputs[0]!] }),
      /review output .* is repeated/,
    );
    refuses({ ...base, acts: [...base.acts, base.acts[0]!] }, /act "ISO_9001" is repeated/);
    refuses(
      { ...base, acts: [...base.acts.slice(0, 3), { ...base.acts[3]!, name: base.acts[0]!.name }] },
      /act name .* is repeated/,
    );
    refuses({ ...base, activities: [...base.activities, first] }, /activity .* is repeated/);
  });

  it('a clause without its parent, a wrong exclusion, or an over-long text', () => {
    const c = q.clauses.find((x) => x.number === '4.1')!;
    const swap = (patch: Partial<typeof c>) =>
      withQ({ clauses: q.clauses.map((x) => (x === c ? { ...x, ...patch } : x)) });
    refuses(swap({ parent: '99' }), /ISO_9001 4.1 has no parent/);
    refuses(swap({ summary: 'x'.repeat(1001) }), /ISO_9001 4.1 is too long/);
    refuses(swap({ title: 'x'.repeat(201) }), /ISO_9001 4.1 is too long/);
    refuses(
      withQ({
        clauses: q.clauses.map((x) => (x.number === '8.3' ? { ...x, exclusionAllowed: true } : x)),
      }),
      /ISO_9001 8.3 cannot allow an exclusion/,
    );
    const e41 = e.clauses.find((x) => x.number === '4.1')!;
    refuses(
      {
        ...base,
        standards: [
          q,
          {
            ...e,
            clauses: e.clauses.map((x) => (x === e41 ? { ...x, exclusionAllowed: true } : x)),
          },
          h,
        ],
      },
      /ISO_14001 4.1 cannot allow an exclusion/,
    );
  });

  it('a review definition on an unknown clause', () => {
    refuses(
      withQ({
        reviewInputs: [
          { ...q.reviewInputs[0]!, clauseNumber: '9.9.9' },
          ...q.reviewInputs.slice(1),
        ],
      }),
      /names clause 9.9.9/,
    );
  });

  it('an activity under an unknown act, without clauses, naming an unknown clause, or with a broken rule', () => {
    refuses(withActivity({ act: 'ISO_NOPE' as never }), /names unknown act ISO_NOPE/);
    refuses(withActivity({ clauseRefs: [] }), /names no clause/);
    refuses(withActivity({ externalRef: 'ISO-OTHER' }), /needs the source ID ISO-CONTEXT-REVIEW/);
    refuses(
      withActivity({ clauseRefs: [{ standard: 'ISO_14001', clauseNumber: '8.3.1' }] }),
      /names ISO_14001 8.3.1, which is not in the catalogue/,
    );
    refuses(
      withActivity({
        recurrenceRule: { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 120 },
      }),
      /has a rule that does not work/,
    );
  });
});

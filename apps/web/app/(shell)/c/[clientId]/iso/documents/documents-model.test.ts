import { describe, expect, it } from 'vitest';

import { ISO } from '../_test/fixture';
import {
  clauseOptions,
  documentFilterDefs,
  documentFilters,
  documentRows,
  documentsQuery,
  nextRevisionLabel,
} from './documents-model';

const SYS = ISO.system.id;

describe('document filters', () => {
  it('reads the URL into the API query', () => {
    const f = documentFilters(
      {
        type: 'POLICY,NOPE',
        status: 'OBSOLETE',
        ownerId: 'me',
        q: '  oven ',
        managementSystemId: SYS,
      },
      [SYS],
    );
    expect(f).toEqual({
      type: ['POLICY'],
      status: ['OBSOLETE'],
      ownerId: 'me',
      q: 'oven',
      managementSystemId: SYS,
      ids: [],
    });
    expect(documentsQuery(f)).toEqual({
      type: 'POLICY',
      status: 'OBSOLETE',
      ownerId: 'me',
      q: 'oven',
      managementSystemId: SYS,
    });
    expect(documentFilters({ managementSystemId: 'other', ownerId: 'x' }, [SYS])).toEqual({
      type: [],
      status: [],
      ids: [],
    });
  });

  it('sends an overview list of ids to the API and adds no status of its own', () => {
    const f = documentFilters({ ids: 'a,b' }, [SYS]);
    expect(documentsQuery(f)).toEqual({ ids: 'a,b' });
    expect(documentFilterDefs().map((d) => d.key)).toEqual(['type', 'status', 'ownerId']);
  });
});

describe('document rows', () => {
  it('words each document the API listed, filtering none itself', () => {
    const rows = documentRows(ISO.docs, ISO.people);
    expect(rows).toHaveLength(ISO.docs.length);
    const pr07 = rows.find((r) => r.code === 'NFG-PR-07')!;
    expect(pr07).toMatchObject({
      type: 'Procedure',
      ownerName: 'Rohan Joshi',
      approverName: 'Nisha Patil',
    });
    const fresh = documentRows([{ ...ISO.docs[0]!, currentRevision: null }], ISO.people);
    expect(fresh[0]!.revision).toBe('None approved yet');
  });

  it('lists the clauses of the given standards in order', () => {
    const options = clauseOptions(ISO.clauses, ISO.standards, ISO.system.standardIds);
    expect(options[0]!.label).toMatch(/^ISO 9001 1 /);
    expect(options.at(-1)!.label).toMatch(/^ISO 45001 10/);
    expect(clauseOptions(ISO.clauses, ISO.standards, [])).toEqual([]);
  });

  it('suggests the next revision label where it is plain', () => {
    expect(nextRevisionLabel(null)).toBe('A');
    expect(nextRevisionLabel('B')).toBe('C');
    expect(nextRevisionLabel('9')).toBe('10');
    expect(nextRevisionLabel('Z')).toBe('');
    expect(nextRevisionLabel('1.0')).toBe('');
  });
});

import { describe, expect, it } from 'vitest';

import { ISO } from '../_test/fixture';
import {
  checklistQuery,
  checklistRows,
  compareClauses,
  filterDefs,
  filtersFrom,
} from './checklist-model';

const ids = ISO.system.standardIds;

describe('checklist filters', () => {
  it('keeps only values the API knows, and owner only as "me"', () => {
    const f = filtersFrom(
      {
        standardId: `${ids[0]},not-a-standard`,
        status: 'PARTIAL,BOGUS',
        naState: ['REQUESTED,APPROVED'],
        ownerId: 'me',
      },
      ids,
    );
    expect(f).toEqual({
      standardId: [ids[0]],
      status: ['PARTIAL'],
      naState: ['REQUESTED', 'APPROVED'],
      ownerId: 'me',
    });
    expect(checklistQuery(f)).toEqual({
      standardId: ids[0],
      status: 'PARTIAL',
      naState: 'REQUESTED,APPROVED',
      ownerId: 'me',
    });
    expect(filtersFrom({ ownerId: 'someone' }, ids).ownerId).toBeUndefined();
    expect(checklistQuery(filtersFrom({}, ids))).toEqual({});
  });

  it('offers the system’s standards and every status in words', () => {
    const defs = filterDefs(ISO.standards, ids);
    expect(defs.map((d) => d.key)).toEqual(['standardId', 'status', 'naState', 'ownerId']);
    expect(defs[0]!.options!.map((o) => o.label)).toEqual(['ISO 9001', 'ISO 14001', 'ISO 45001']);
    expect(defs[2]!.options!.map((o) => o.label)).toContain('Not applicable refused');
  });
});

describe('checklist rows', () => {
  it('orders clauses naturally', () => {
    expect(['4.10', '4.2', '7.1.5.2', '7.1.5.1', '10.1', '7.1'].sort(compareClauses)).toEqual([
      '4.2',
      '4.10',
      '7.1',
      '7.1.5.1',
      '7.1.5.2',
      '10.1',
    ]);
  });

  it('orders by the system’s standards, then clause, and names the owner', () => {
    const shuffled = [...ISO.checklist].reverse();
    const rows = checklistRows(shuffled, ISO.standards, ISO.people, ids);
    expect(rows).toHaveLength(ISO.checklist.length);
    expect(rows[0]!.clause).toMatch(/^4\.1 /);
    expect(rows[0]!.standard).toBe('ISO 9001');
    expect(rows.at(-1)!.standard).toBe('ISO 45001');
    expect(rows.every((r) => !/^[0-9a-f-]{36}$/.test(r.ownerName))).toBe(true);
    const unowned = checklistRows(
      [{ ...ISO.checklist[0]!, ownerId: null }],
      ISO.standards,
      ISO.people,
      ids,
    );
    expect(unowned[0]!.ownerName).toBe('Nobody yet');
  });
});

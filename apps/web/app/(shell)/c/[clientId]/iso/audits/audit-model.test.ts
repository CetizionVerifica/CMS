// @vitest-environment node
// The audit list's URL state against the mock API: the overview's programme links read back as the API's own filters
// (the FY as its programmes), `ids` goes to the API, and the rows are what the API sent, with nothing filtered here.
import { describe, expect, it } from 'vitest';

import { ISO } from '../_test/fixture';
import { CLIENT, signedIn } from '../_test/iso-data';
import { MAX_LINK_IDS, programmeLinks } from '../overview/overview-model';
import {
  auditFilterDefs,
  auditFilters,
  auditFilterValue,
  auditRows,
  auditsQuery,
  auditUnits,
  clausesWithoutResult,
  programmeFys,
  programmeOptions,
  selfAuditorNames,
} from './audit-model';

const SYS = ISO.system.id;
const UNITS = ISO.units.map((u) => u.id);
const search = (href: string) => Object.fromEntries(new URL(href, 'http://x').searchParams);
const [PROGRAMME] = ISO.programmes;
const byTitle = (start: string) => ISO.internalAudits.find((a) => a.title.startsWith(start))!;

async function list(query: Record<string, string>) {
  const api = await signedIn('consultant@demo.test');
  return (
    await api.call('listIsoInternalAudits', {
      params: { clientId: CLIENT },
      query: { ...query, limit: '200' },
    })
  ).data.items;
}

describe('audit filters', () => {
  it('keeps known values only, and reads an FY as its programmes', () => {
    const f = auditFilters(
      {
        state: 'PLANNED,BOGUS',
        unitId: `${UNITS[0]},gone`,
        leadAuditorId: 'me',
        fy: '2024-25,next year',
        managementSystemId: SYS,
        q: '  oven ',
        ids: 'a,b',
      },
      [SYS],
      UNITS,
    );
    expect(auditsQuery(f, ISO.programmes)).toEqual({
      programmeId: PROGRAMME!.id,
      state: 'PLANNED',
      unitId: UNITS[0],
      leadAuditorId: 'me',
      managementSystemId: SYS,
      q: 'oven',
      ids: 'a,b',
    });
    expect(auditFilterValue(f)).toEqual({
      state: ['PLANNED'],
      fy: ['2024-25'],
      unitId: [UNITS[0]],
      leadAuditorId: ['me'],
    });
    // An FY with no programme matches nothing, so the page asks the API for nothing.
    expect(auditsQuery(auditFilters({ fy: '2019-20' }, [SYS], UNITS), ISO.programmes)).toBeNull();
    expect(auditsQuery(auditFilters({ managementSystemId: 'nope' }, [SYS], UNITS), [])).toEqual({});
    expect(
      auditFilterDefs(ISO.units, programmeFys(ISO.programmes, '2025-26')).map((d) => d.key),
    ).toEqual(['state', 'fy', 'unitId', 'leadAuditorId']);
    expect(programmeFys(ISO.programmes, '2025-26')).toEqual(['2025-26', '2024-25']);
  });

  it('opens each overview programme count on exactly its audits, by ids and past the ids limit', async () => {
    const view = ISO.overview.systems[0]!;
    const links = programmeLinks(CLIENT, view);
    expect(links.map((l) => l.label)).toEqual(['Planned', 'Reported', 'Cancelled']);
    for (const link of links) {
      const f = auditFilters(search(link.href), [SYS], UNITS);
      const sent = await list(auditsQuery(f, ISO.programmes)!);
      expect(sent.length, link.label).toBe(link.count);
    }
    // Past the limit, the FY and the states name the same audits.
    const programme = view.auditProgramme!;
    const many = Array.from({ length: MAX_LINK_IDS + 1 }, (_, i) => `a${i}`);
    const wide = programmeLinks(CLIENT, {
      ...view,
      auditProgramme: {
        ...programme,
        planned: { count: many.length, ids: many },
        reported: { count: many.length, ids: many },
        cancelled: { count: many.length, ids: many },
      },
    });
    const counts = [programme.planned.count, programme.reported.count, programme.cancelled.count];
    for (const [i, link] of wide.entries()) {
      expect(link.note).toBeUndefined();
      expect(search(link.href)).toMatchObject({ managementSystemId: SYS, fy: programme.fy });
      const f = auditFilters(search(link.href), [SYS], UNITS);
      expect((await list(auditsQuery(f, ISO.programmes)!)).length, link.label).toBe(counts[i]);
    }
    expect(programmeLinks(CLIENT, { ...view, auditProgramme: null })).toEqual([]);
  });
});

describe('audit rows and words', () => {
  it('names each audit by its FY and units, and its lead auditor', () => {
    const q1 = byTitle('Q1');
    const q4 = byTitle('Q4');
    const rows = auditRows([q1, q4], ISO.programmes, ISO.units, ISO.people);
    expect(rows[0]!.sub).toBe('FY 2024-25 · Pune Plant');
    expect(rows[0]!.leadName).toBe('Sameer Gowda');
    expect(rows[1]!.sub).toBe('FY 2024-25 · Pune Plant, Bengaluru Office');
    expect(auditRows([{ ...q1, programmeId: 'gone' }], [], [], [])[0]!.sub).toBe('Unknown unit');
    expect(auditUnits({ unitIds: [] }, ISO.units)).toBe('All units of the system');
    expect(selfAuditorNames(q4, ISO.people)).toBe('Divya Hegde');
    expect(selfAuditorNames(q1, ISO.people)).toBe('');
  });

  it('lists the clauses that still need a checklist result, and the programmes by FY', () => {
    const q3 = byTitle('Q3');
    const rows = ISO.auditChecklists[q3.id]!;
    const missing = clausesWithoutResult(q3, rows);
    expect(missing.length).toBe(q3.clauseIds.length - rows.filter((r) => r.result).length);
    expect(clausesWithoutResult(byTitle('Q1'), ISO.auditChecklists[byTitle('Q1').id]!)).toEqual([]);
    expect(programmeOptions(ISO.programmes, [ISO.system])).toEqual([
      { id: PROGRAMME!.id, managementSystemId: SYS, label: 'FY 2024-25' },
    ]);
    expect(
      programmeOptions(
        [{ ...PROGRAMME!, fy: '2023-24', id: 'old' }, PROGRAMME!],
        [ISO.system, { ...ISO.system, id: 'other' }],
      ).map((o) => o.label),
    ).toEqual([`${ISO.system.name}, FY 2024-25`, `${ISO.system.name}, FY 2023-24`]);
  });
});

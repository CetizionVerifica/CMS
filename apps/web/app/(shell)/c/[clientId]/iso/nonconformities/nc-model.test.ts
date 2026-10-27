// @vitest-environment node
// The nonconformity log's URL state against the mock API: the overview's links read back as the API's own filters, `ids`
// goes to the API, and the rows are what the API sent, with nothing filtered on the page.
import { describe, expect, it } from 'vitest';

import { ISO } from '../_test/fixture';
import { CLIENT, signedIn } from '../_test/iso-data';
import { countGroups, incidentLinks } from '../overview/overview-model';
import {
  ncExportQuery,
  ncFilterDefs,
  ncFilters,
  ncFilterValue,
  ncName,
  ncOpen,
  ncRows,
  ncsQuery,
  ncSummary,
  ncSystems,
  severityOpen,
} from './nc-model';

const SYS = ISO.system.id;
const search = (href: string) => Object.fromEntries(new URL(href, 'http://x').searchParams);

describe('nonconformity filters', () => {
  it("reads every overview link's filters exactly and sends them to the API", () => {
    const view = ISO.overview.systems[0]!;
    const links = [
      ...countGroups(CLIENT, view).find((g) => g.title === 'Nonconformities')!.items,
      ...incidentLinks(CLIENT, view),
    ];
    expect(links.length).toBeGreaterThan(4);
    for (const link of links) {
      const query = search(link.href);
      expect(ncsQuery(ncFilters(query, [SYS])), link.label).toEqual(query);
    }
  });

  it('keeps known values only, and the export drops ids', () => {
    const f = ncFilters(
      {
        state: 'OPEN,BOGUS,CLOSED',
        source: 'INCIDENT,NOPE',
        severity: 'MAJOR',
        ownerId: 'me',
        approverId: 'someone',
        incident: 'true',
        overdue: 'false',
        managementSystemId: 'not-a-system',
        q: '  oven tray ',
        ids: 'a,b',
      },
      [SYS],
    );
    expect(ncsQuery(f)).toEqual({
      state: 'OPEN,CLOSED',
      source: 'INCIDENT',
      severity: 'MAJOR',
      ownerId: 'me',
      incident: 'true',
      q: 'oven tray',
      ids: 'a,b',
    });
    expect(ncExportQuery(f)).not.toHaveProperty('ids');
    expect(ncFilterValue(f)).toEqual({
      state: ['OPEN', 'CLOSED'],
      source: ['INCIDENT'],
      severity: ['MAJOR'],
      overdue: [],
      incident: ['true'],
      ownerId: ['me'],
      approverId: [],
    });
    expect(ncFilterDefs().map((d) => d.key)).toEqual([
      'state',
      'source',
      'severity',
      'overdue',
      'incident',
      'ownerId',
      'approverId',
    ]);
    expect(ncsQuery(ncFilters({ approverId: 'me', overdue: 'true' }, [SYS]))).toEqual({
      approverId: 'me',
      overdue: 'true',
    });
  });

  it('asks the API for exactly the ids an overview count lists, and shows every row it sends', async () => {
    const api = await signedIn('consultant@demo.test');
    const picked = ISO.ncs.slice(0, 2).map((n) => n.id);
    const f = ncFilters({ ids: picked.join(','), managementSystemId: SYS }, [SYS]);
    const sent = (
      await api.call('listIsoNonconformities', {
        params: { clientId: CLIENT },
        query: { ...ncsQuery(f), limit: '200' },
      })
    ).data.items;
    expect(sent.map((n) => n.id).sort()).toEqual([...picked].sort());
    expect(ncRows(sent, ISO.units, ISO.people).map((r) => r.id)).toEqual(sent.map((n) => n.id));
  });
});

describe('nonconformity rows and words', () => {
  it('names each record and words its row', () => {
    const incident = ISO.ncs.find((n) => n.source === 'INCIDENT')!;
    const near = ISO.ncs.find((n) => n.source === 'NEAR_MISS')!;
    const complaint = ISO.ncs.find((n) => n.source === 'COMPLAINT')!;
    expect(ncName(incident)).toBe(`Incident ${incident.number}`);
    expect(ncName(near)).toBe(`Near miss ${near.number}`);
    expect(ncName(complaint)).toBe(`Nonconformity ${complaint.number}`);
    const [row] = ncRows([complaint], ISO.units, ISO.people);
    expect(row!.sub).toBe(`Nonconformity ${complaint.number} · Complaint · Major`);
    expect(row!.ownerName).toBe('Rohan Joshi');
    expect(row!.unit).toBe(ISO.units.find((u) => u.id === complaint.unitId)!.name);
    const [other] = ncRows(
      [
        { ...complaint, unitId: null },
        { ...complaint, unitId: 'gone' },
      ],
      [],
      [],
    );
    expect(other!.unit).toBe('All units');
    expect(ncRows([{ ...complaint, unitId: 'gone' }], [], [])[0]!.unit).toBe('Unknown unit');
    expect(ncSummary('First line\nsecond')).toBe('First line');
    expect(ncSummary('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('says when a record is still worked, and when its severity can change', () => {
    expect(ncOpen({ state: 'AWAITING_VERIFICATION' })).toBe(true);
    expect(ncOpen({ state: 'CLOSED' })).toBe(false);
    expect(ncOpen({ state: 'CANCELLED' })).toBe(false);
    expect(severityOpen({ state: 'OPEN' })).toBe(true);
    expect(severityOpen({ state: 'ROOT_CAUSE_FOUND' })).toBe(true);
    expect(severityOpen({ state: 'ACTIONS_PLANNED' })).toBe(false);
  });

  it("offers each system's standards, clauses, units and live risk items", () => {
    const [option] = ncSystems([ISO.system], ISO.standards, ISO.clauses, [
      ...ISO.risks,
      { ...ISO.risks[0]!, id: 'archived', archivedAt: '2024-01-01T00:00:00Z' },
    ]);
    expect(option!.standards.map((s) => s.code)).toEqual(
      ISO.system.standardIds.map((id) => ISO.standards.find((s) => s.id === id)!.code),
    );
    expect(option!.clauses.length).toBeGreaterThan(0);
    expect(option!.unitIds).toEqual(ISO.system.unitIds);
    expect(option!.risks.map((r) => r.id)).not.toContain('archived');
    expect(option!.risks[0]!.label).toMatch(/^(Risk|Opportunity|Aspect|Hazard): /);
  });
});

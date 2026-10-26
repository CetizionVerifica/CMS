import { describe, expect, it } from 'vitest';

import { ISO } from '../_test/fixture';
import {
  kindDetails,
  kindTabs,
  ratingText,
  riskExportQuery,
  riskFilterDefs,
  riskFilters,
  riskFilterValue,
  riskRows,
  risksQuery,
  secondAxis,
} from './risks-model';

const SYS = ISO.system.id;
const PATH = '/c/c1/iso/risks';
const risk = (activity: string) => ISO.risks.find((r) => r.activity === activity)!;

describe('risk filters', () => {
  it("reads the overview's exact filters and sends them, with ids, to the API", () => {
    const f = riskFilters(
      {
        managementSystemId: SYS,
        significant: 'true',
        climateRelated: 'false',
        kind: 'HAZARD',
        ownerId: 'me',
        includeArchived: 'true',
        q: '  oven ',
        ids: 'a,b',
      },
      [SYS],
    );
    expect(risksQuery(f)).toEqual({
      managementSystemId: SYS,
      significant: 'true',
      climateRelated: 'false',
      kind: 'HAZARD',
      ownerId: 'me',
      includeArchived: 'true',
      q: 'oven',
      ids: 'a,b',
    });
    expect(riskFilterValue(f)).toEqual({
      significant: ['true'],
      climateRelated: ['false'],
      ownerId: ['me'],
      includeArchived: ['true'],
    });
  });

  it('adds no filter the URL does not name, and drops unknown values', () => {
    const f = riskFilters(
      { kind: 'BOGUS', significant: 'maybe', managementSystemId: 'other', ownerId: 'x' },
      [SYS],
    );
    expect(f).toEqual({ ids: [] });
    expect(risksQuery(f)).toEqual({});
    expect(riskFilterDefs().map((d) => d.key)).toEqual([
      'significant',
      'climateRelated',
      'ownerId',
      'includeArchived',
    ]);
  });

  it('downloads the register with the filters but never the overview’s ids', () => {
    const f = riskFilters({ ids: 'a,b', significant: 'true' }, [SYS]);
    expect(riskExportQuery(f)).toEqual({ significant: 'true' });
  });

  it('tabs each kind, keeping the filters but not the ids', () => {
    const f = riskFilters({ kind: 'ASPECT', significant: 'true', ids: 'a' }, [SYS]);
    const tabs = kindTabs(PATH, f);
    expect(tabs.map((t) => [t.label, t.current])).toEqual([
      ['All', false],
      ['Risks', false],
      ['Opportunities', false],
      ['Aspects', true],
      ['Hazards', false],
    ]);
    expect(tabs[0]!.href).toBe(`${PATH}?significant=true`);
    expect(tabs[4]!.href).toBe(`${PATH}?kind=HAZARD&significant=true`);
  });
});

describe('risk rows and words', () => {
  it('words each item with its unit, ratings and owner', () => {
    const rows = riskRows(ISO.risks, ISO.units, ISO.people);
    expect(rows).toHaveLength(ISO.risks.length);
    const oven = rows.find((r) => r.risk.activity === 'Changing oven trays on line 2')!;
    expect(oven.sub).toBe('Hazard · Changing oven trays on line 2');
    expect(oven.ownerName).toBe('Rohan Joshi');
    expect(oven.ratingText).toBe(
      ratingText(oven.risk.rating, oven.risk.likelihood, oven.risk.severity),
    );
    const noUnit = riskRows([{ ...oven.risk, unitId: null }], ISO.units, ISO.people)[0]!;
    expect(noUnit.unit).toBe('All units');
    const lost = riskRows([{ ...oven.risk, unitId: 'gone' }], [], ISO.people)[0]!;
    expect(lost.unit).toBe('Unknown unit');
  });

  it('rates with both scores, or says it is not rated', () => {
    expect(ratingText(12, 3, 4)).toBe('12 (3 × 4)');
    expect(ratingText(null, null, null)).toBe('Not rated');
    expect(secondAxis('OPPORTUNITY')).toBe('Benefit');
    expect(secondAxis('HAZARD')).toBe('Severity');
  });

  it("words a hazard's and an aspect's own fields", () => {
    const hazard = risk('Changing oven trays on line 2');
    expect(kindDetails(hazard).map((d) => d.label)).toEqual(
      expect.arrayContaining(['Harm', 'Routine', 'Who is exposed']),
    );
    expect(
      kindDetails({ ...hazard, routine: false }).find((d) => d.label === 'Routine')!.value,
    ).toBe('Non-routine');
    const aspect = risk('Washing trays and mixers');
    expect(kindDetails(aspect).map((d) => d.label)).toEqual(
      expect.arrayContaining(['Environmental impact', 'Life-cycle stages', 'Control or influence']),
    );
    expect(kindDetails({ ...aspect, controlType: null, condition: 'ABNORMAL' })).toEqual(
      expect.arrayContaining([
        { label: 'Control or influence', value: '' },
        { label: 'Operating condition', value: 'Abnormal' },
      ]),
    );
    expect(kindDetails(risk('Buying flour'))).toEqual([]);
  });
});

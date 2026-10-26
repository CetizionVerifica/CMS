import {
  DEFAULT_FIRM_SETTINGS,
  ENDPOINTS,
  type DerivedStatus,
  type DueThisWeekFilter,
  type LocalDate,
  type RequestContext,
} from '@canopy/contracts';
import { engine } from '@canopy/engine';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryRow } from './memory-store.js';
import { sourceKinds, STATUTORY } from './scope.js';
import { createWorld } from './testing/world.js';

/**
 * ISO-11b (docs/iso/plan.md §4.4-4.6): statutory numbers count STATUTE-act instances only, with the ISO add-on on or
 * off; the calendar takes `source` while it is on and leaves ISO activities out while it is off; the portfolio's
 * due-this-week link says `source=LAW` while it is on.
 */

const w = createWorld();
const iso = w.addIsoRows();
afterAll(() => w.app.close());
beforeEach(() => w.setIso(false));

const base = `/api/v1/clients/${w.clientId}`;
const isoIds = Object.values(iso).map((r) => r.id);

async function get(url: string, headers = w.as('FIRM_ADMIN').headers) {
  const res = await w.app.inject({ url, headers });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** What a statutory endpoint answers in the base world, before any switch. */
const STATUTORY_URLS = [
  ['portfolio', '/api/v1/portfolio'],
  ['clientOverview', `${base}/overview`],
  ['breakdown', `${base}/breakdowns?by=act`],
  ['breakdown', `${base}/breakdowns?by=department`],
  ['actReport', `${base}/reports/act-wise`],
  ['departmentReport', `${base}/reports/department-wise`],
  ['overdueReport', `${base}/reports/overdue`],
] as const;

describe('statutory numbers leave ISO activities out', () => {
  /** What `url` answers with the ISO activities taken out of the store: the numbers the account must keep. */
  async function withoutIso(url: string) {
    const kept = w.store.rows.splice(0, w.store.rows.length);
    w.store.rows.push(...kept.filter((r) => !isoIds.includes(r.id)));
    try {
      return await get(url);
    } finally {
      w.store.rows.splice(0, w.store.rows.length, ...kept);
    }
  }

  for (const on of [false, true]) {
    for (const [id, url] of STATUTORY_URLS) {
      it(`${id} ${url.replace(base, '')} is unchanged by ISO activities with the add-on ${on ? 'on' : 'off'}`, async () => {
        w.setIso(on);
        const body = ENDPOINTS[id].response.parse(await get(url));
        const text = JSON.stringify(body);
        for (const isoId of isoIds) expect(text).not.toContain(isoId);
        expect(text).not.toContain(w.isoAct.actName);
        expect(body).toEqual(ENDPOINTS[id].response.parse(await withoutIso(url)));
      });
    }
  }

  it('the statutory filter reads STATUTE acts only', () => {
    expect(STATUTORY).toEqual({ actKinds: ['STATUTE'] });
  });
});

/** The register as M7 lists it with `filter` and `source=LAW`: the store's rows, then the dates and states. */
async function registerFor(
  filter: DueThisWeekFilter,
  clientId: string = w.clientId,
): Promise<string[]> {
  const ctx = { firmId: w.firmId } as RequestContext;
  const rows = await w.store.registerRows(ctx, clientId, {
    ...sourceKinds(true, filter.source),
    dueFrom: filter.dueFrom,
    dueTo: filter.dueTo,
    workflowState: filter.workflowState,
  });
  return rows.map((r) => r.id).sort();
}

describe('portfolio due-this-week link', () => {
  it('carries the dates and states the count is made of, with no source while the add-on is off', async () => {
    const { items } = ENDPOINTS.portfolio.response.parse(await get('/api/v1/portfolio'));
    const beta = items.find((i) => i.clientId === w.clientId)!;
    expect(beta.dueThisWeekFilter).toEqual({
      dueFrom: '2026-10-12',
      dueTo: '2026-10-19',
      workflowState: ['OPEN', 'SENT_BACK'],
    });
  });

  it('says source=LAW while the add-on is on, and the linked register lists exactly the items counted', async () => {
    w.setIso(true);
    const { items } = ENDPOINTS.portfolio.response.parse(await get('/api/v1/portfolio'));
    for (const row of items) {
      expect(row.dueThisWeekFilter?.source).toBe('LAW');
      const listed = await registerFor(row.dueThisWeekFilter!, row.clientId);
      expect(listed).toEqual([...row.result.instanceIds.DUE_SOON].sort());
      expect(listed).toHaveLength(row.dueThisWeek);
    }
    // The same dates and states with source=ISO list the ISO activity due this week, which the count leaves out.
    const beta = items.find((i) => i.clientId === w.clientId)!;
    expect(await registerFor({ ...beta.dueThisWeekFilter!, source: 'ISO' })).toEqual([
      iso.dueSoon.id,
    ]);
  });

  it('keeps the link inside the period, and gives none when the period has no due-soon day', async () => {
    const inside = ENDPOINTS.portfolio.response.parse(
      await get('/api/v1/portfolio?from=2026-04-01&to=2026-10-15'),
    );
    expect(inside.items[0]!.dueThisWeekFilter).toMatchObject({
      dueFrom: '2026-10-12',
      dueTo: '2026-10-15',
    });
    const later = ENDPOINTS.portfolio.response.parse(
      await get('/api/v1/portfolio?from=2026-10-14&to=2026-12-31'),
    );
    expect(later.items[0]!.dueThisWeekFilter).toMatchObject({
      dueFrom: '2026-10-14',
      dueTo: '2026-10-19',
    });
    const past = ENDPOINTS.portfolio.response.parse(await get('/api/v1/portfolio?fy=2025-26'));
    for (const row of past.items) {
      expect(row.dueThisWeekFilter).toBeUndefined();
      expect(row.dueThisWeek).toBe(0);
    }
  });

  it('gives no link for a unit filter, which the register link cannot carry', async () => {
    const { items } = ENDPOINTS.portfolio.response.parse(
      await get(`/api/v1/portfolio?unitId=${w.unit1}`),
    );
    for (const row of items) expect(row.dueThisWeekFilter).toBeUndefined();
  });
});

describe('each KPI equals its filtered register count, with ISO activities in the account', () => {
  const statuses: DerivedStatus[] = ['OVERDUE', 'DUE_SOON', 'UPCOMING', 'COMPLIED'];
  const asOf = '2026-10-12' as LocalDate;
  const status = (r: MemoryRow) => engine.deriveStatus(r, asOf, DEFAULT_FIRM_SETTINGS).status;

  for (const on of [false, true]) {
    it(`with the add-on ${on ? 'on (register source=LAW)' : 'off'}`, async () => {
      w.setIso(on);
      const { result } = ENDPOINTS.clientOverview.response.parse(await get(`${base}/overview`));
      const ctx = { firmId: w.firmId } as RequestContext;
      const register = await w.store.registerRows(ctx, w.clientId, {
        ...sourceKinds(on, on ? 'LAW' : undefined),
        dueFrom: '2026-04-01' as LocalDate,
        dueTo: '2027-03-31' as LocalDate,
      });
      for (const s of statuses) {
        const listed = register
          .filter((r) => status(r as MemoryRow) === s)
          .map((r) => r.id)
          .sort();
        expect([...result.instanceIds[s]].sort()).toEqual(listed);
        expect(result.counts[s]).toBe(listed.length);
      }
    });
  }
});

describe('calendar source', () => {
  const url = (source?: string) =>
    `${base}/calendar?from=2026-09-01&to=2026-10-31${source ? `&source=${source}` : ''}`;
  const listed = async (source?: string) => {
    const { items } = ENDPOINTS.calendar.response.parse(await get(url(source)));
    return items.flatMap((day) => day.items.map((i) => i.id)).sort();
  };
  const laws = [w.rows.overdue!.id, w.rows.sentBack!.id, w.rows.dueSoon!.id].sort();
  const activities = [iso.overdue.id, iso.dueSoon.id].sort();

  it('lists laws and ISO activities with no source while the add-on is on', async () => {
    w.setIso(true);
    expect(await listed()).toEqual([...laws, ...activities].sort());
  });

  it('lists laws for source=LAW and ISO activities for source=ISO while it is on', async () => {
    w.setIso(true);
    expect(await listed('LAW')).toEqual(laws);
    expect(await listed('ISO')).toEqual(activities);
  });

  it('leaves ISO activities out while it is off, whatever source says', async () => {
    expect(await listed()).toEqual(laws);
    expect(await listed('LAW')).toEqual(laws);
    expect(await listed('ISO')).toEqual(laws);
  });

  it('keeps unit scope with a source: an owner limited to Head Office sees no Plant activity', async () => {
    w.setIso(true);
    const headers = w.as('OWNER', { unitIds: [w.unit2] }).headers;
    const { items } = ENDPOINTS.calendar.response.parse(await get(url('ISO'), headers));
    expect(items).toEqual([]);
  });

  it('refuses an unknown source', async () => {
    const res = await w.app.inject({ url: url('BOTH'), headers: w.as('FIRM_ADMIN').headers });
    expect(res.statusCode).toBe(400);
  });
});

describe('sourceKinds', () => {
  it('reads STATUTE only while the add-on is off, whatever the source', () => {
    for (const source of [undefined, 'LAW', 'ISO'] as const) {
      expect(sourceKinds(false, source)).toEqual({ actKinds: ['STATUTE'] });
    }
  });

  it('reads both kinds, laws or ISO activities while it is on', () => {
    expect(sourceKinds(true, undefined)).toEqual({});
    expect(sourceKinds(true, 'LAW')).toEqual({ actKinds: ['STATUTE'] });
    expect(sourceKinds(true, 'ISO')).toEqual({ actKinds: ['STANDARD'] });
  });
});

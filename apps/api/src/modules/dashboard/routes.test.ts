import { ENDPOINTS, Role, type Breakdown, type ScoreResult } from '@canopy/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { createWorld } from './testing/world.js';

const w = createWorld();
afterAll(() => w.app.close());

const base = `/api/v1/clients/${w.clientId}`;

async function get(url: string, headers: Record<string, string>) {
  return w.app.inject({ url, headers });
}

function ids(result: ScoreResult, status: keyof ScoreResult['counts']): string[] {
  return [...result.instanceIds[status]].sort();
}

const sorted = (...values: string[]) => [...values].sort();

describe('role matrix (endpoints.md §6)', () => {
  const cases = [
    { id: 'portfolio', url: '/api/v1/portfolio' },
    { id: 'clientOverview', url: `${base}/overview` },
    { id: 'breakdown', url: `${base}/breakdowns?by=department` },
    { id: 'calendar', url: `${base}/calendar?from=2026-10-01&to=2026-10-31` },
  ] as const;

  for (const c of cases) {
    const endpoint = ENDPOINTS[c.id];
    for (const role of Role.options) {
      const allowed = endpoint.roles[role] !== undefined;
      it(`${c.id}: ${role} ${allowed ? 'gets 200 and a contract response' : 'gets 403'}`, async () => {
        const res = await get(c.url, w.as(role).headers);
        expect(res.statusCode).toBe(allowed ? 200 : 403);
        if (allowed) endpoint.response.parse(res.json());
        else expect(res.json().error.code).toBe('FORBIDDEN');
      });
    }
  }

  it('answers 401 without a session', async () => {
    const res = await w.app.inject({ url: `${base}/overview` });
    expect(res.statusCode).toBe(401);
  });

  it("answers 404 for another firm's client and for a client outside a consultant's list", async () => {
    const admin = w.as('FIRM_ADMIN').headers;
    expect((await get(`/api/v1/clients/${w.otherFirmClientId}/overview`, admin)).statusCode).toBe(
      404,
    );
    const consultant = w.as('CONSULTANT').headers;
    expect((await get(`/api/v1/clients/${w.secondClientId}/overview`, consultant)).statusCode).toBe(
      404,
    );
  });
});

describe('client overview', () => {
  it('counts every status in the current FY, with the instance ids behind each count', async () => {
    const res = await get(`${base}/overview`, w.as('CLIENT_ADMIN').headers);
    const { result } = ENDPOINTS.clientOverview.response.parse(res.json());
    const r = w.rows;
    expect(result.asOf).toBe('2026-10-12');
    expect(ids(result, 'OVERDUE')).toEqual(sorted(r.overdue!.id, r.sentBack!.id));
    expect(ids(result, 'DUE_SOON')).toEqual([r.dueSoon!.id]);
    expect(ids(result, 'UPCOMING')).toEqual([r.upcoming!.id]);
    expect(ids(result, 'SUBMITTED')).toEqual([r.submitted!.id]);
    expect(ids(result, 'COMPLIED')).toEqual([r.complied!.id]);
    expect(ids(result, 'COMPLIED_LATE')).toEqual([r.compliedLate!.id]);
    expect(ids(result, 'NOT_APPLICABLE')).toEqual([r.notApplicable!.id]);
    // The previous FY's row and other clients' rows are not counted.
    const all = Object.values(result.instanceIds).flat();
    expect(all).not.toContain(r.lastFy!.id);
    expect(all).not.toContain(r.secondClient!.id);
    expect(all).toHaveLength(8);
  });

  it('lists upcoming items by due date and the signed-in owner’s open items', async () => {
    const res = await get(`${base}/overview`, w.as('OWNER', {}, w.ownerId).headers);
    const body = ENDPOINTS.clientOverview.response.parse(res.json());
    expect(body.upcoming.map((row) => row.id)).toEqual([w.rows.dueSoon!.id, w.rows.upcoming!.id]);
    expect(body.myTasks.map((row) => row.id)).toEqual([
      w.rows.overdue!.id,
      w.rows.sentBack!.id,
      w.rows.dueSoon!.id,
      w.rows.upcoming!.id,
    ]);
    expect(body.upcoming[0]).toMatchObject({ status: 'DUE_SOON', overdueDays: null });
    expect(body.myTasks[0]).toMatchObject({ status: 'OVERDUE', overdueDays: 12 });
  });

  it('limits approvers and owners to their units', async () => {
    const headers = w.as('APPROVER', { unitIds: [w.unit2] }).headers;
    const { result } = (await get(`${base}/overview`, headers)).json();
    const all = Object.values(result.instanceIds as Record<string, string[]>).flat();
    expect(all.sort()).toEqual(
      sorted(
        w.rows.compliedLate!.id,
        w.rows.submitted!.id,
        w.rows.notApplicable!.id,
        w.rows.sentBack!.id,
      ),
    );
  });

  it('filters by unit, and an out-of-scope unit gives an empty result', async () => {
    const admin = w.as('FIRM_ADMIN').headers;
    const one = (await get(`${base}/overview?unitId=${w.unit2}`, admin)).json();
    expect(Object.values(one.result.counts as Record<string, number>).reduce((a, b) => a + b)).toBe(
      4,
    );
    const owner = w.as('OWNER', { unitIds: [w.unit2] }).headers;
    const none = (await get(`${base}/overview?unitId=${w.unit1}`, owner)).json();
    expect(none.result.score).toBeNull();
    expect(Object.values(none.result.counts as Record<string, number>).every((n) => n === 0)).toBe(
      true,
    );
  });

  it('takes fy and from/to periods', async () => {
    const admin = w.as('FIRM_ADMIN').headers;
    const last = (await get(`${base}/overview?fy=2025-26`, admin)).json();
    expect(last.result.instanceIds.OVERDUE).toEqual([w.rows.lastFy!.id]);
    const range = (await get(`${base}/overview?from=2026-09-01&to=2026-10-31`, admin)).json();
    expect(
      Object.values(range.result.instanceIds as Record<string, string[]>)
        .flat()
        .sort(),
    ).toEqual(sorted(w.rows.overdue!.id, w.rows.dueSoon!.id, w.rows.sentBack!.id));
    const open = (await get(`${base}/overview?from=2027-01-01`, admin)).json();
    expect(open.result.instanceIds.UPCOMING).toEqual([w.rows.upcoming!.id]);
    const until = (await get(`${base}/overview?to=2026-01-01`, admin)).json();
    expect(until.result.instanceIds.OVERDUE).toEqual([w.rows.lastFy!.id]);
  });

  it('rejects fy with from/to, and a bad query', async () => {
    const admin = w.as('FIRM_ADMIN').headers;
    const both = await get(`${base}/overview?fy=2026-27&from=2026-04-01`, admin);
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe('VALIDATION');
    expect((await get(`${base}/overview?nope=1`, admin)).statusCode).toBe(400);
  });

  it('lets firm staff and viewers set asOf, and refuses it for client admins, approvers and owners', async () => {
    const asOf = '2026-07-01';
    for (const role of ['FIRM_ADMIN', 'CONSULTANT', 'VIEWER'] as const) {
      const res = await get(`${base}/overview?asOf=${asOf}`, w.as(role).headers);
      expect(res.statusCode).toBe(200);
      const { result } = res.json();
      expect(result.asOf).toBe(asOf);
      // On 1 Jul 2026 the September item is not overdue yet.
      expect(result.instanceIds.OVERDUE).toEqual([]);
    }
    for (const role of ['CLIENT_ADMIN', 'APPROVER', 'OWNER'] as const) {
      const res = await get(`${base}/overview?asOf=${asOf}`, w.as(role).headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({
        code: 'FORBIDDEN',
        details: { action: 'dashboard.read' },
      });
    }
  });
});

describe('breakdowns', () => {
  async function breakdown(by: string, headers = w.as('FIRM_ADMIN').headers): Promise<Breakdown> {
    const res = await get(`${base}/breakdowns?by=${by}`, headers);
    expect(res.statusCode).toBe(200);
    return ENDPOINTS.breakdown.response.parse(res.json());
  }

  it('groups by department, Act, criticality, unit and owner', async () => {
    const dept = await breakdown('department');
    expect(dept.rows.map((r) => [r.key, r.label])).toEqual([
      [w.dept.safety, 'Safety'],
      [w.dept.tax, 'Tax'],
    ]);
    const act = await breakdown('act');
    expect(act.rows.map((r) => r.label)).toEqual(['Factories Act, 1948', 'Income Tax Act, 1961']);
    const crit = await breakdown('criticality');
    expect(crit.rows.map((r) => [r.key, r.label])).toEqual([
      ['HIGH', 'High'],
      ['LOW', 'Low'],
      ['SUPER_CRITICAL', 'Super critical'],
    ]);
    const unit = await breakdown('unit');
    expect(unit.rows.map((r) => r.key).sort()).toEqual(sorted(w.unit1, w.unit2));
    const owner = await breakdown('owner');
    expect(owner.rows.find((r) => r.key === w.ownerId)?.label).toBe('Person Owner');
  });

  it('adds up to the overview: every instance is in exactly one group', async () => {
    const overview = (await get(`${base}/overview`, w.as('FIRM_ADMIN').headers)).json();
    for (const by of ['department', 'act', 'criticality', 'unit', 'owner']) {
      const b = await breakdown(by);
      for (const [status, expected] of Object.entries(
        overview.result.instanceIds as Record<string, string[]>,
      )) {
        const fromGroups = b.rows.flatMap(
          (row) => row.result.instanceIds[status as keyof ScoreResult['counts']],
        );
        expect(fromGroups.sort()).toEqual([...expected].sort());
      }
    }
  });

  it('rejects an unknown grouping', async () => {
    const res = await get(`${base}/breakdowns?by=colour`, w.as('FIRM_ADMIN').headers);
    expect(res.statusCode).toBe(400);
  });
});

describe('portfolio', () => {
  it('gives one row per client the consultant sees, in name order, with due-this-week and activity', async () => {
    const res = await get('/api/v1/portfolio', w.as('FIRM_ADMIN').headers);
    const { items } = ENDPOINTS.portfolio.response.parse(res.json());
    expect(items.map((i) => i.clientName)).toEqual(['Alpha Group', 'Beta Group']);
    const beta = items[1]!;
    expect(beta.dueThisWeek).toBe(1);
    expect(beta.lastActivityAt).toBe('2026-10-11T10:00:00.000Z');
    expect(beta.result.counts.OVERDUE).toBe(2);
    const alpha = items[0]!;
    expect(alpha.dueThisWeek).toBe(1);
    expect(alpha.lastActivityAt).toBeNull();
  });

  it('shows a consultant only their clients', async () => {
    const res = await get('/api/v1/portfolio', w.as('CONSULTANT').headers);
    expect(res.json().items.map((i: { clientId: string }) => i.clientId)).toEqual([w.clientId]);
  });
});

describe('calendar', () => {
  it('lists dates with their instances in order, inside the range only', async () => {
    const res = await get(
      `${base}/calendar?from=2026-09-01&to=2026-10-31`,
      w.as('CLIENT_ADMIN').headers,
    );
    const { items } = ENDPOINTS.calendar.response.parse(res.json());
    expect(items.map((day) => [day.date, day.items.map((i) => i.id)])).toEqual([
      ['2026-09-30', [w.rows.overdue!.id]],
      ['2026-10-01', [w.rows.sentBack!.id]],
      ['2026-10-15', [w.rows.dueSoon!.id]],
    ]);
  });

  it('refuses a range longer than a year or running backwards', async () => {
    const admin = w.as('FIRM_ADMIN').headers;
    const long = await get(`${base}/calendar?from=2026-01-01&to=2027-01-02`, admin);
    expect(long.statusCode).toBe(400);
    expect(long.json().error.code).toBe('VALIDATION');
    const year = await get(`${base}/calendar?from=2026-01-01&to=2026-12-31`, admin);
    expect(year.statusCode).toBe(200);
    const back = await get(`${base}/calendar?from=2026-02-01&to=2026-01-01`, admin);
    expect(back.statusCode).toBe(400);
  });
});

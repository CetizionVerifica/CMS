import { Act, ApiErrorResponse, Obligation, type LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ids, testApp } from '../entities/testing/world.js';
import { SCENARIOS } from '../entities/testing/scenarios.js';
import { checkRule, ruleIssues } from './rules.js';

const error = (body: unknown) => ApiErrorResponse.parse(body).error;
const asOf = '2026-10-12' as LocalDate;
const obligationBody = () =>
  SCENARIOS.createObligation!('FIRM_ADMIN').body as Record<string, unknown>;

describe('rule checks (engine)', () => {
  it('accepts rules the engine can generate', () => {
    expect(ruleIssues({ kind: 'MONTHLY', day: 7, offsetMonths: 1 }, asOf)).toEqual([]);
    expect(ruleIssues({ kind: 'ONE_TIME', dueDate: '2020-01-01' as LocalDate }, asOf)).toEqual([]);
    expect(ruleIssues({ kind: 'EVENT_DRIVEN', trigger: 'Accident', withinDays: 2 }, asOf)).toEqual(
      [],
    );
    expect(ruleIssues({ kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 15 }, asOf)).toEqual(
      [],
    );
  });

  it('rejects a due date before its period starts', () => {
    const issues = ruleIssues({ kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 120 }, asOf);
    expect(issues[0]?.path).toEqual(['days']);
    expect(() => checkRule({ kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 120 }, asOf)).toThrow(
      /before its period starts/,
    );
  });
});

describe('library visibility', () => {
  it('shows client roles only what their clients use', async () => {
    const { call } = testApp();
    const titles = async (actor: Parameters<typeof call>[0]) =>
      (
        (await call(actor, 'GET', '/library/obligations')).body as { items: Obligation[] }
      ).items.map((o) => o.title);
    expect(await titles('consultant')).toEqual([
      'Annual return',
      'Display of abstract',
      'Half-yearly return',
    ]);
    expect(await titles('owner')).toEqual(['Annual return']);
    expect((await call('owner', 'GET', `/library/obligations/${ids.obligationB}`)).status).toBe(
      404,
    );
    const acts = await call('viewer', 'GET', '/library/acts');
    expect((acts.body as { items: Act[] }).items.map((a) => a.id)).toEqual([ids.act]);
    const categories = await call('approver', 'GET', '/library/categories');
    expect((categories.body as { items: { id: string }[] }).items.map((c) => c.id)).toEqual([
      ids.category,
    ]);
  });

  it('shows a client with no assignments an empty library', async () => {
    const { call } = testApp();
    await call('firmAdmin', 'POST', `/assignments/${ids.assignment}/archive`, {
      version: 1,
      reason: 'Gone',
    });
    expect((await call('owner', 'GET', '/library/acts')).body).toMatchObject({ items: [] });
    expect((await call('owner', 'GET', '/library/categories')).body).toMatchObject({ items: [] });
  });

  it('filters obligations like the register', async () => {
    const { call } = testApp();
    const count = async (q: string) =>
      ((await call('firmAdmin', 'GET', `/library/obligations${q}`)).body as { items: unknown[] })
        .items.length;
    expect(
      await count(`?actId=${ids.act}&categoryId=${ids.category}&domain=HRS,TAX&criticality=HIGH`),
    ).toBe(3);
    expect(await count('?jurisdiction=STATE&stateCode=WB&ruleStatus=TO_REVIEW')).toBe(0);
    expect(await count('?q=annual')).toBe(1);
    expect((await call('firmAdmin', 'GET', '/library/obligations?domain=NOPE')).status).toBe(400);
  });
});

describe('acts and categories', () => {
  it('checks jurisdiction against the merged record', async () => {
    const { call } = testApp();
    const res = await call('firmAdmin', 'PATCH', `/library/acts/${ids.act}`, {
      version: 1,
      jurisdiction: 'STATE',
    });
    expect(res.status).toBe(400);
    const ok = await call('firmAdmin', 'PATCH', `/library/acts/${ids.act}`, {
      version: 1,
      jurisdiction: 'STATE',
      stateCode: 'WB',
    });
    expect(Act.parse(ok.body).stateCode).toBe('WB');
  });

  it('merges Acts: obligations move to the target and the names become aliases', async () => {
    const { call, store } = testApp();
    await call('firmAdmin', 'PATCH', `/library/obligations/${ids.obligationB}`, {
      version: 1,
      actId: ids.actDup,
    });
    const res = await call('consultant', 'POST', `/library/acts/${ids.act}/merge`, {
      version: 1,
      sourceIds: [ids.actDup],
    });
    expect(Act.parse(res.body).aliases).toEqual(['The Factories Act 1948']);
    expect(store.raw('obligations', ids.obligationB)?.actId).toBe(ids.act);
  });

  it('merges categories and moves their obligations', async () => {
    const { call, store } = testApp();
    await call('firmAdmin', 'PATCH', `/library/obligations/${ids.obligationB}`, {
      version: 1,
      categoryId: ids.categoryDup,
    });
    await call('consultant', 'POST', `/library/categories/${ids.category}/merge`, {
      version: 1,
      sourceIds: [ids.categoryDup],
    });
    expect(store.raw('obligations', ids.obligationB)?.categoryId).toBe(ids.category);
  });

  it('refuses a duplicate Act name', async () => {
    const { call } = testApp();
    const res = await call('firmAdmin', 'POST', '/library/acts', {
      name: 'Factories Act, 1948',
      jurisdiction: 'CENTRAL',
    });
    expect(res.status).toBe(409);
  });
});

describe('obligations', () => {
  it('validates the recurrence rule with the engine (422 RULE_INVALID)', async () => {
    const { call } = testApp();
    const res = await call('firmAdmin', 'POST', '/library/obligations', {
      ...obligationBody(),
      recurrenceRule: { kind: 'HALF_YEARLY', anchor: 'PERIOD_END', days: 200 },
    });
    expect(res.status).toBe(422);
    expect(error(res.body)).toMatchObject({
      code: 'RULE_INVALID',
      details: { issues: [{ path: ['body', 'recurrenceRule', 'days'] }] },
    });
    const patch = await call('firmAdmin', 'PATCH', `/library/obligations/${ids.obligation}`, {
      version: 1,
      recurrenceRule: { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 95 },
    });
    expect(patch.status).toBe(422);
  });

  it('checks the Act, category and jurisdiction', async () => {
    const { call } = testApp();
    expect(
      (
        await call('firmAdmin', 'POST', '/library/obligations', {
          ...obligationBody(),
          actId: ids.category,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('firmAdmin', 'POST', '/library/obligations', {
          ...obligationBody(),
          categoryId: ids.act,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('firmAdmin', 'POST', '/library/obligations', {
          ...obligationBody(),
          jurisdiction: 'STATE',
        })
      ).status,
    ).toBe(400);
    const patch = await call('firmAdmin', 'PATCH', `/library/obligations/${ids.obligation}`, {
      version: 1,
      stateCode: 'WB',
    });
    expect(patch.status).toBe(400);
  });

  it('bumps the library version on every change and announces what changed', async () => {
    const { call, store } = testApp();
    const res = await call('consultant', 'PATCH', `/library/obligations/${ids.obligation}`, {
      version: 1,
      criticality: 'CRITICAL',
      evidenceRequired: true,
    });
    expect(Obligation.parse(res.body)).toMatchObject({ libraryVersion: 2, version: 2 });
    expect(store.events).toMatchObject([
      {
        type: 'obligation.updated',
        data: { libraryVersion: 2, changed: ['criticality', 'evidenceRequired'] },
      },
    ]);
    const same = await call('consultant', 'PATCH', `/library/obligations/${ids.obligation}`, {
      version: 2,
      criticality: 'CRITICAL',
    });
    expect(Obligation.parse(same.body).libraryVersion).toBe(2);
  });

  it('will not archive an obligation that is still assigned', async () => {
    const { call } = testApp();
    const res = await call('firmAdmin', 'POST', `/library/obligations/${ids.obligation}/archive`, {
      version: 1,
      reason: 'Repealed',
    });
    expect(res.status).toBe(400);
  });

  it('previews the periods a rule generates', async () => {
    const { call } = testApp();
    const res = await call('clientAdmin', 'POST', '/library/rules/preview', {
      rule: { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 15 },
      from: '2026-04-01',
      to: '2027-03-31',
      fyStartMonth: 4,
    });
    expect((res.body as { items: { dueDate: string }[] }).items.map((p) => p.dueDate)).toEqual([
      '2026-04-15',
      '2026-07-15',
      '2026-10-15',
      '2027-01-15',
    ]);
    const tooLong = await call('clientAdmin', 'POST', '/library/rules/preview', {
      rule: { kind: 'MONTHLY', day: 1, offsetMonths: 0 },
      from: '2000-04-01',
      to: '2027-03-31',
      fyStartMonth: 4,
    });
    expect(tooLong.status).toBe(400);
  });

  it('pushes the current version to clients for regeneration', async () => {
    const { call, store } = testApp();
    const res = await call('firmAdmin', 'POST', `/library/obligations/${ids.obligation}/push`, {
      clientIds: [ids.clientA, ids.clientB],
    });
    expect(res.body).toEqual({ libraryVersion: 1, assignmentsUpdated: 1, instancesUpdated: 0 });
    expect(store.events).toMatchObject([
      { type: 'obligation.pushed', data: { clientIds: [ids.clientA, ids.clientB] } },
    ]);
    const hidden = await call('consultant', 'POST', `/library/obligations/${ids.obligation}/push`, {
      clientIds: [ids.clientB],
    });
    expect(hidden.status).toBe(404);
  });
});

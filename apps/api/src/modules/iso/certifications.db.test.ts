import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attach, createHarness, type Harness, type Reply, type Who } from './testing/fixture.js';

/**
 * Certificates and external audit visits (model §3.8, §4.4): who writes them, the issuing rule, the order of the
 * certificate list, and the visit through RECORD_HELD and CANCEL (ISO-8a's arrows), with locks and audit events.
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let h: Harness;
let systemId: string;
let wholeId: string;

beforeAll(async () => {
  h = await createHarness('Cert', NOW);
  systemId = (
    await h.ok('clientAdmin', 'POST', '/systems', {
      name: 'Stonebridge system',
      standardIds: [h.f.std9001, h.f.std14001],
      unitIds: [h.f.unitA],
    })
  ).id as string;
  wholeId = (
    await h.ok('clientAdmin', 'POST', '/systems', {
      name: 'Group system',
      standardIds: [h.f.std9001],
      unitIds: [],
    })
  ).id as string;
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const details = (reply: Reply) => (reply.body.error as { details?: unknown } | undefined)?.details;

const audit = (entityId: string) =>
  h.testDb.query<{ action: string; after: Record<string, unknown> | null; reason: string | null }>(
    'SELECT action, after, reason FROM audit_event WHERE entity_id = $1 ORDER BY at, id',
    [entityId],
  );

const certificate = (fields: Record<string, unknown> = {}, who: Who = 'clientAdmin') =>
  h.send(who, 'POST', '/certifications', {
    managementSystemId: systemId,
    standardId: h.f.std9001,
    body: 'Northwind Certification',
    ...fields,
  });

const visit = (fields: Record<string, unknown> = {}, who: Who = 'clientAdmin') =>
  h.send(who, 'POST', '/external-audits', {
    managementSystemId: systemId,
    standardIds: [h.f.std9001],
    type: 'SURVEILLANCE_1',
    body: 'Northwind Certification',
    startOn: '2026-10-12',
    endOn: '2026-10-13',
    ...fields,
  });

describe('certificates', () => {
  it('lets managers write them; others read within their units', async () => {
    const pursued = await certificate();
    expect(pursued.status).toBe(201);
    expect(pursued.body).toMatchObject({
      certificateNumber: null,
      issuedOn: null,
      cycle: expect.anything(),
    });
    expect((await audit(pursued.body.id as string)).map((e) => e.action)).toEqual(['CREATE']);
    for (const who of ['firmAdmin', 'consultant'] as Who[]) {
      expect((await certificate({}, who)).status).toBe(201);
    }
    for (const who of ['approver', 'owner', 'viewer'] as Who[]) {
      expect((await certificate({}, who)).status).toBe(403);
    }
    expect((await certificate({}, 'otherOwner')).status).toBe(404);
    const owner = (await h.ok('owner', 'GET', '/certifications')).items as unknown[];
    expect(owner.length).toBeGreaterThanOrEqual(3);
    expect(((await h.ok('otherOwner', 'GET', '/certifications')).items as unknown[]).length).toBe(
      0,
    );
  });

  it('refuses a standard or unit outside the system and checks issuing on the merged certificate', async () => {
    const wholeOnly = await h.send('clientAdmin', 'POST', '/certifications', {
      managementSystemId: wholeId,
      standardId: h.f.std14001,
      body: 'Northwind Certification',
    });
    expect(details(wholeOnly)).toMatchObject({ issues: [{ path: ['standardId'] }] });
    const unit = await certificate({ unitIds: [h.f.unitB] });
    expect(details(unit)).toMatchObject({ issues: [{ path: ['unitIds'] }] });
    const half = await certificate({ issuedOn: '2026-01-10' });
    expect(half.status).toBe(400);

    const cert = (await certificate()).body;
    const path = `/certifications/${cert.id}`;
    const number = await h.send('clientAdmin', 'PATCH', path, {
      version: 1,
      certificateNumber: 'NW-1',
    });
    expect(details(number)).toMatchObject({ issues: [{ path: ['certificateNumber'] }] });
    const order = await h.send('clientAdmin', 'PATCH', path, {
      version: 1,
      certificateNumber: 'NW-1',
      issuedOn: '2026-01-10',
      expiresOn: '2026-01-10',
    });
    expect(details(order)).toMatchObject({ issues: [{ path: ['expiresOn'] }] });
    const issued = await h.ok('clientAdmin', 'PATCH', path, {
      version: 1,
      certificateNumber: 'NW-1',
      issuedOn: '2026-01-10',
      expiresOn: '2029-01-09',
    });
    expect(issued).toMatchObject({ version: 2, certificateNumber: 'NW-1' });
    expect((issued.cycle as { items?: unknown[] }).items ?? issued.cycle).toBeTruthy();
    expect((await h.send('clientAdmin', 'PATCH', path, { version: 1, body: 'Stale' })).status).toBe(
      409,
    );
    expect((await h.send('owner', 'PATCH', path, { version: 2, body: 'Mine' })).status).toBe(403);
    // Moving the units within the system is an edit; another unit is refused.
    const units = await h.send('clientAdmin', 'PATCH', path, { version: 2, unitIds: [h.f.unitB] });
    expect(details(units)).toMatchObject({ issues: [{ path: ['unitIds'] }] });
    expect(
      await h.ok('clientAdmin', 'PATCH', path, { version: 2, unitIds: [h.f.unitA] }),
    ).toMatchObject({
      unitIds: [h.f.unitA],
    });
    expect((await audit(cert.id as string)).map((e) => e.action)).toEqual([
      'CREATE',
      'UPDATE',
      'UPDATE',
    ]);
  });

  it('lists the soonest expiry first, unissued last, in pages', async () => {
    const late = (
      await certificate({
        certificateNumber: 'NW-L',
        issuedOn: '2026-02-01',
        expiresOn: '2030-01-31',
      })
    ).body;
    const soon = (
      await certificate({
        certificateNumber: 'NW-S',
        issuedOn: '2025-02-01',
        expiresOn: '2027-01-31',
      })
    ).body;
    const all = (
      await h.ok('viewer', 'GET', `/certifications?managementSystemId=${systemId}&limit=100`)
    ).items as { id: string; expiresOn: string | null }[];
    const dated = all.filter((c) => c.expiresOn !== null).map((c) => c.expiresOn!);
    expect(dated).toEqual([...dated].sort());
    expect(all.findIndex((c) => c.id === soon.id)).toBeLessThan(
      all.findIndex((c) => c.id === late.id),
    );
    expect(all.at(-1)!.expiresOn).toBeNull();

    const first = (await h.ok('viewer', 'GET', '/certifications?limit=1&count=true')) as {
      items: { id: string }[];
      nextCursor: string | null;
      total: number;
    };
    expect(first.items[0]!.id).toBe(soon.id);
    expect(first.total).toBeGreaterThan(1);
    const next = (await h.ok(
      'viewer',
      'GET',
      `/certifications?limit=1&cursor=${first.nextCursor}`,
    )) as {
      items: { id: string }[];
    };
    expect(next.items[0]!.id).not.toBe(soon.id);
    expect((await h.send('viewer', 'GET', '/certifications?cursor=bm9wZQ')).status).toBe(400);
  });
});

describe('external audit visits (model §4.4)', () => {
  it('plans a visit, edits it with a reason for the response deadline, and lists it by scope', async () => {
    const planned = await visit();
    expect(planned.status).toBe(201);
    expect(planned.body).toMatchObject({
      state: 'PLANNED',
      allowedActions: ['RECORD_HELD', 'CANCEL'],
    });
    const id = planned.body.id as string;
    expect((await visit({}, 'owner')).status).toBe(403);
    expect(
      details(await visit({ standardIds: [h.f.std14001], managementSystemId: wholeId })),
    ).toMatchObject({
      issues: [{ path: ['standardIds'] }],
    });
    expect(details(await visit({ responseDueOn: '2026-10-01' }))).toMatchObject({
      issues: [{ path: ['responseDueOn'] }],
    });

    const read = await h.ok('owner', 'GET', `/external-audits/${id}`);
    expect(read.allowedActions).toEqual([]);
    expect((await h.send('otherOwner', 'GET', `/external-audits/${id}`)).status).toBe(404);
    expect(((await h.ok('otherOwner', 'GET', '/external-audits')).items as unknown[]).length).toBe(
      0,
    );
    const listed = (await h.ok('owner', 'GET', '/external-audits?state=PLANNED&count=true')) as {
      total: number;
    };
    expect(listed.total).toBeGreaterThan(0);

    const path = `/external-audits/${id}`;
    expect(
      (await h.send('clientAdmin', 'PATCH', path, { version: 1, responseDueOn: '2026-11-30' }))
        .status,
    ).toBe(422);
    const early = await h.send('clientAdmin', 'PATCH', path, {
      version: 1,
      recommendation: 'RECOMMENDED',
    });
    expect(details(early)).toMatchObject({ issues: [{ path: ['recommendation'] }] });
    await h.ok('clientAdmin', 'PATCH', path, {
      version: 1,
      responseDueOn: '2026-11-30',
      leadAuditorName: 'R. Northwind',
      reason: 'Body asked for more time',
    });
    expect((await audit(id)).map((e) => [e.action, e.reason])).toEqual([
      ['CREATE', null],
      ['UPDATE', null],
      ['DUE_DATE_CHANGE', 'Body asked for more time'],
    ]);
  });

  it('RECORD_HELD needs the visit ended and the report on file; then the visit stays editable until closed', async () => {
    const id = (await visit({ startOn: '2026-10-19', endOn: '2026-10-21' })).body.id as string;
    const path = `/external-audits/${id}`;
    const notEnded = await h.send('clientAdmin', 'POST', `${path}/held`, {
      version: 1,
      startOn: '2026-10-19',
      endOn: '2026-10-21',
    });
    expect(details(notEnded)).toMatchObject({ issues: [{ path: ['endOn'] }] });
    const noReport = await h.send('clientAdmin', 'POST', `${path}/held`, {
      version: 1,
      startOn: '2026-10-19',
      endOn: '2026-10-20',
    });
    expect(details(noReport)).toMatchObject({ issues: [{ path: ['file'] }] });
    const report = await attach(h, 'clientAdmin', { type: 'external_audit', id }, 'report.pdf');
    await h.scan(report.id as string, 'INFECTED');
    expect(
      (
        await h.send('clientAdmin', 'POST', `${path}/held`, {
          version: 1,
          startOn: '2026-10-19',
          endOn: '2026-10-20',
        })
      ).status,
    ).toBe(400);
    await attach(h, 'clientAdmin', { type: 'external_audit', id }, 'report-2.pdf');
    expect(
      (
        await h.send('owner', 'POST', `${path}/held`, {
          version: 1,
          startOn: '2026-10-19',
          endOn: '2026-10-20',
        })
      ).status,
    ).toBe(403);
    const held = await h.ok('consultant', 'POST', `${path}/held`, {
      version: 1,
      startOn: '2026-10-19',
      endOn: '2026-10-20',
      recommendation: 'RECOMMENDED',
    });
    expect(held).toMatchObject({
      state: 'HELD',
      endOn: '2026-10-20',
      recommendation: 'RECOMMENDED',
      allowedActions: [],
    });
    expect((await audit(id)).at(-1)).toMatchObject({
      action: 'TRANSITION',
      after: expect.objectContaining({ action: 'RECORD_HELD', state: 'HELD', delegated: true }),
    });
    const future = await h.send('clientAdmin', 'PATCH', path, { version: 2, endOn: '2026-10-22' });
    expect(details(future)).toMatchObject({ issues: [{ path: ['endOn'] }] });
    expect(
      await h.ok('clientAdmin', 'PATCH', path, { version: 2, recommendation: 'NOT_RECOMMENDED' }),
    ).toMatchObject({
      recommendation: 'NOT_RECOMMENDED',
    });
    expect(
      (await h.send('clientAdmin', 'POST', `${path}/cancel`, { version: 3, reason: 'Too late' }))
        .status,
    ).toBe(409);
  });

  it('CANCEL needs a reason and locks the visit and its files', async () => {
    const id = (await visit()).body.id as string;
    const path = `/external-audits/${id}`;
    const file = await attach(h, 'clientAdmin', { type: 'external_audit', id }, 'plan.pdf');
    expect((await h.send('clientAdmin', 'POST', `${path}/cancel`, { version: 1 })).status).toBe(
      422,
    );
    const cancelled = await h.ok('clientAdmin', 'POST', `${path}/cancel`, {
      version: 1,
      reason: 'Moved to next year',
    });
    expect(cancelled).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'Moved to next year',
      allowedActions: [],
    });
    const last = (await audit(id)).at(-1)!;
    expect(last).toMatchObject({ reason: 'Moved to next year', after: { action: 'CANCEL' } });
    expect(last.after).not.toHaveProperty('delegated');
    const edit = await h.send('clientAdmin', 'PATCH', path, { version: 2, body: 'Other body' });
    expect(details(edit)).toEqual({
      entity: 'external_audit',
      from: 'CANCELLED',
      action: 'UPDATE',
    });
    const remove = await h.send('clientAdmin', 'POST', `/files/${file.id}/remove`, {
      reason: 'Wrong file',
    });
    expect(remove.status).toBe(409);
  });
});

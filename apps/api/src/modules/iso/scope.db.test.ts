import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerIsoRoutes } from './routes.js';
import { createFakeIsoFiles } from './testing/fake-files.js';
import { createHarness, type Harness, type Who } from './testing/fixture.js';

/**
 * Unit scope (plan §3.3, #281 audit Info): for each record kind, a unit-limited reader is allowed by `can()` exactly the
 * records the list SQL returns to them. The per-record answer is the record's own read (or, for kinds without one, the
 * file list of the record, which runs the same check). Also: every M16 route answers 409 FEATURE_NOT_READY until the
 * account's catalogue copy is recorded (plan §7 item 4).
 */

const NOW = new Date('2026-10-20T06:00:00Z');
const ROOT = '/api/v1/clients/:clientId/iso';
let h: Harness;

/** Records by kind, every one of the fixture client. */
const all = {
  systems: [] as string[],
  rows: [] as string[],
  documents: [] as string[],
  certifications: [] as string[],
  externalAudits: [] as string[],
  risks: [] as string[],
  objectives: [] as string[],
  actions: [] as string[],
  nonconformities: [] as string[],
};

let codes = 0;
async function seedSystem(units: string[], recordOwner: Who = 'clientAdmin') {
  const system = await h.ok('clientAdmin', 'POST', '/systems', {
    name: `Scope ${units.length === 0 ? 'group' : units.join(',').slice(0, 8)}`,
    standardIds: [h.f.std9001],
    unitIds: units,
  });
  const id = system.id as string;
  all.systems.push(id);
  const rows = (await h.ok('clientAdmin', 'GET', `/systems/${id}/checklist`)).items as {
    id: string;
  }[];
  all.rows.push(...rows.map((r) => r.id));
  codes += 1;
  const doc = await h.ok('clientAdmin', 'POST', '/documents', {
    managementSystemId: id,
    code: `SC-${codes}`,
    title: 'Scope document',
    type: 'PROCEDURE',
    ownerId: h.f.people[recordOwner],
    approverId: h.f.people.otherAdmin,
  });
  all.documents.push(doc.id as string);
  const cert = await h.ok('clientAdmin', 'POST', '/certifications', {
    managementSystemId: id,
    standardId: h.f.std9001,
    body: 'Northwind Certification',
  });
  all.certifications.push(cert.id as string);
  const visit = await h.ok('clientAdmin', 'POST', '/external-audits', {
    managementSystemId: id,
    standardIds: [h.f.std9001],
    type: 'STAGE_1',
    body: 'Northwind Certification',
    startOn: '2026-11-02',
    endOn: '2026-11-03',
  });
  all.externalAudits.push(visit.id as string);
  // A risk item on the system's units and one on its first unit, each with a treatment action; an objective.
  for (const unitId of [null, units[0] ?? null]) {
    const item = await h.ok('clientAdmin', 'POST', '/risks', {
      managementSystemId: id,
      kind: 'RISK',
      unitId,
      activity: 'Packaging supply',
      description: 'One supplier makes every carton',
      likelihood: 2,
      severity: 3,
      // An item on a unit is owned by someone of that unit.
      ownerId: h.f.people[unitId === null ? recordOwner : 'clientAdmin'],
    });
    all.risks.push(item.id as string);
    const action = await h.ok('clientAdmin', 'POST', '/actions', {
      subject: { type: 'RISK_ITEM', id: item.id },
      text: 'Qualify a second supplier',
      ownerId: h.f.people.clientAdmin,
      dueOn: '2026-11-30',
    });
    all.actions.push(action.id as string);
  }
  const objective = await h.ok('clientAdmin', 'POST', '/objectives', {
    managementSystemId: id,
    standards: ['ISO_9001'],
    text: 'On-time delivery',
    target: 98,
    unitOfMeasure: '%',
    direction: 'INCREASE',
    readingRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    ownerId: h.f.people[recordOwner],
    dueOn: '2027-03-31',
  });
  all.objectives.push(objective.id as string);
  // A unit-less nonconformity (the system's units) naming the record owner, and one on the system's first unit.
  for (const unitId of [null, units[0] ?? null]) {
    const nc = await h.ok('clientAdmin', 'POST', '/nonconformities', {
      managementSystemId: id,
      source: 'PROCESS',
      severity: 'MINOR',
      standards: ['ISO_9001'],
      unitId,
      description: 'Scope nonconformity',
      ownerId: h.f.people[unitId === null && recordOwner === 'owner' ? 'owner' : 'clientAdmin'],
      approverId: h.f.people.otherAdmin,
      dueOn: '2026-11-30',
    });
    all.nonconformities.push(nc.id as string);
  }
  return id;
}

beforeAll(async () => {
  h = await createHarness('Scope', NOW);
  await seedSystem([h.f.unitA]);
  // Unit B's system names the unit A owner on its document, a risk item and its objective: the named-person exception.
  await seedSystem([h.f.unitB], 'owner');
  const group = await seedSystem([]);
  // A certificate over unit A only, on the group system.
  const narrow = await h.ok('clientAdmin', 'POST', '/certifications', {
    managementSystemId: group,
    standardId: h.f.std9001,
    body: 'Osprey Assurance',
    unitIds: [h.f.unitA],
  });
  all.certifications.push(narrow.id as string);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

/** Every id a list returns, page by page (the checklist is one list, not paged). */
async function ids(who: Who, path: string): Promise<string[]> {
  const out: string[] = [];
  const paged = !path.endsWith('/checklist');
  let cursor: string | null = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const query = paged ? `${sep}limit=100${cursor ? `&cursor=${cursor}` : ''}` : '';
    const reply = await h.send(who, 'GET', `${path}${query}`);
    if (reply.status === 404) return out;
    expect(reply.status).toBe(200);
    out.push(...(reply.body.items ?? []).map((i) => i.id as string));
    cursor = (reply.body.nextCursor as string | null | undefined) ?? null;
  } while (cursor !== null);
  return out;
}

async function allowed(who: Who, kind: keyof typeof all, id: string): Promise<boolean> {
  const path = {
    systems: `/systems/${id}`,
    rows: `/files?subjectType=clause_assessment&subjectId=${id}`,
    documents: `/documents/${id}`,
    certifications: `/files?subjectType=certification&subjectId=${id}`,
    externalAudits: `/external-audits/${id}`,
    risks: `/risks/${id}`,
    objectives: `/objectives/${id}`,
    actions: `/actions/${id}`,
    nonconformities: `/nonconformities/${id}`,
  }[kind];
  const reply = await h.send(who, 'GET', path);
  expect([200, 404]).toContain(reply.status);
  return reply.status === 200;
}

async function listed(who: Who, kind: keyof typeof all): Promise<string[]> {
  switch (kind) {
    case 'systems':
      return ids(who, '/systems');
    case 'rows': {
      const out: string[] = [];
      for (const system of all.systems)
        out.push(...(await ids(who, `/systems/${system}/checklist`)));
      return out;
    }
    case 'documents':
      return ids(who, '/documents');
    case 'certifications':
      return ids(who, '/certifications');
    case 'externalAudits':
      return ids(who, '/external-audits');
    case 'risks':
      return ids(who, '/risks');
    case 'objectives':
      return ids(who, '/objectives');
    case 'actions':
      return ids(who, '/actions');
    case 'nonconformities':
      return ids(who, '/nonconformities');
  }
}

describe('can() allows exactly what the lists return (plan §3.3)', () => {
  const readers: Who[] = ['owner', 'otherOwner', 'approverB', 'approver', 'viewer'];
  for (const kind of Object.keys(all) as (keyof typeof all)[]) {
    it.each(readers)(`${kind} for %s`, async (who) => {
      const permitted: string[] = [];
      for (const id of all[kind]) if (await allowed(who, kind, id)) permitted.push(id);
      expect((await listed(who, kind)).sort()).toEqual(permitted.sort());
    });
  }

  it('limits unit readers to their units, with the named-person exception and group systems', async () => {
    const [systemA, systemB, group] = all.systems;
    expect((await ids('owner', '/systems')).sort()).toEqual([systemA, group].sort());
    expect((await ids('approverB', '/systems')).sort()).toEqual([systemB, group].sort());
    expect((await ids('viewer', '/systems')).length).toBe(3);
    // The unit A owner is named on unit B's document; the unit B owner sees no unit A document.
    expect(await ids('owner', '/documents')).toContain(all.documents[1]);
    expect(await ids('otherOwner', '/documents')).not.toContain(all.documents[0]);
    // The certificate over unit A on the group system is out of unit B's sight.
    expect(await ids('approverB', '/certifications')).not.toContain(all.certifications.at(-1));
    expect(await ids('owner', '/certifications')).toContain(all.certifications.at(-1));
    // Unit B's system-wide risk item and objective name the unit A owner; actions take their items' units.
    const [, , bGroup, bUnit] = all.risks;
    expect(await ids('owner', '/risks')).toContain(bGroup);
    expect(await ids('owner', '/risks')).not.toContain(bUnit);
    expect(await ids('owner', '/objectives')).toContain(all.objectives[1]);
    expect(await ids('owner', '/actions')).toContain(all.actions[2]);
    expect(await ids('owner', '/actions')).not.toContain(all.actions[3]);
    expect(await ids('otherOwner', '/actions')).toEqual(
      expect.arrayContaining([all.actions[2], all.actions[3]]),
    );
    // Unit B's unit-less NC names the unit A owner; its unit B NC and unit A's NCs stay apart.
    const [aNone, aUnit, bNone, bUnit2] = all.nonconformities;
    expect(await ids('owner', '/nonconformities')).toEqual(
      expect.arrayContaining([aNone, aUnit, bNone]),
    );
    expect(await ids('owner', '/nonconformities')).not.toContain(bUnit2);
    expect(await ids('otherOwner', '/nonconformities')).not.toContain(aNone);
  });
});

describe('the catalogue copy not yet recorded', () => {
  it('answers 409 FEATURE_NOT_READY on every M16 route', async () => {
    const routes: { method: string; url: string }[] = [];
    const probe = Fastify();
    probe.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (method !== 'HEAD') routes.push({ method, url: route.url.replace(ROOT, '') });
      }
    });
    probe.register(
      async (api) => {
        registerIsoRoutes(api, { db: h.testDb.db, files: createFakeIsoFiles(h.f.clientId) });
      },
      { prefix: '/api/v1' },
    );
    await probe.ready();
    await probe.close();
    expect(routes.length).toBe(84);

    h.auth.store.isoCataloguePending.add(h.f.firmId);
    try {
      for (const route of routes) {
        const path = route.url.replace(/:\w+/g, all.systems[0]!);
        const reply = await h.send(
          'clientAdmin',
          route.method as 'GET' | 'POST' | 'PATCH' | 'PUT',
          path,
          route.method === 'GET' ? undefined : {},
        );
        expect([route.method, route.url, reply.status]).toEqual([route.method, route.url, 409]);
        expect((reply.body.error as { code: string }).code).toBe('FEATURE_NOT_READY');
      }
    } finally {
      h.auth.store.isoCataloguePending.delete(h.f.firmId);
    }
    expect((await h.send('clientAdmin', 'GET', '/systems')).status).toBe(200);
  });
});

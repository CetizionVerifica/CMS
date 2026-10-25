// The ISO add-on's switch in the mock (docs/iso/plan.md §4.3, §4.4): the gate in front of every /iso route, the
// X-Mock-Features override, the catalogue copy the console switch runs, and a check that every ISO route has a
// handler and a suite that calls it.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../src/api/endpoints.js';
import { ISO_ENDPOINTS } from '../src/api/iso-endpoints.js';
import { fixtureId } from '../src/fixtures/index.js';
import { HANDLERS } from '../src/mock/index.js';
import { type App, call, fails, firmB, isoApp, ok, PERSON, setFeatures } from './iso-harness.js';

const FIRM_A = fixtureId('firm-a');
const FIRM_A_ADMIN = 'admin@demo-advisory.example';
const FIRM_A_CLIENT = fixtureId('firm-a:client');
const ISO_IDS = Object.keys(ISO_ENDPOINTS) as (keyof typeof ISO_ENDPOINTS)[];

let app: App;
beforeAll(async () => {
  app = await isoApp();
});
afterAll(async () => {
  await app.close();
});

const firmA = () => app.store.firm(FIRM_A);

async function setFirmAFeatures(features: string[], isoCatalogueCopied?: boolean) {
  const response = await app.inject({
    method: 'PUT',
    url: `/__mock/firms/${FIRM_A}/features`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      features,
      ...(isoCatalogueCopied === undefined ? {} : { isoCatalogueCopied }),
    }),
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as { features: string[]; isoCatalogueCopiedAt: string | null };
}

describe('the ISO routes', () => {
  it('are M16 routes behind the isoManagement switch, none of them public', () => {
    expect(ISO_IDS.length).toBe(119);
    for (const id of ISO_IDS) {
      const ep = ENDPOINTS[id];
      expect(ep, id).toBe(ISO_ENDPOINTS[id]);
      expect(ep.module, id).toBe('M16');
      expect(ep.feature, id).toBe('isoManagement');
      expect(ep.auth === 'public', id).toBe(false);
      expect(ep.path.startsWith('/clients/{clientId}/iso/'), id).toBe(true);
      expect(typeof HANDLERS[id], id).toBe('function');
    }
  });

  it('each name exactly one can() action, so the stub never unions two actions over one route', () => {
    const many = ISO_IDS.filter((id) => ENDPOINTS[id].actions.length !== 1);
    expect(many).toEqual([]);
    // ISO-1a split the two routes that named two actions: the NC's work and its reassignment, the review's minutes and
    // its plan.
    const split = {
      updateIsoNonconformity: ['PATCH', '/clients/{clientId}/iso/nonconformities/{id}'],
      reassignIsoNonconformity: ['POST', '/clients/{clientId}/iso/nonconformities/{id}/reassign'],
      updateIsoManagementReview: ['PATCH', '/clients/{clientId}/iso/management-reviews/{id}'],
      replanIsoManagementReview: ['POST', '/clients/{clientId}/iso/management-reviews/{id}/replan'],
    } as const;
    for (const [id, [method, path]] of Object.entries(split)) {
      const ep = ENDPOINTS[id as keyof typeof split];
      expect([ep.method, ep.path], id).toEqual([method, path]);
    }
    expect(ENDPOINTS['updateIsoNonconformity'].actions).toEqual(['isoNc.work']);
    expect(ENDPOINTS['updateIsoNonconformity'].roles).toEqual({
      CLIENT_ADMIN: 'all',
      OWNER: 'own',
    });
    expect(ENDPOINTS['reassignIsoNonconformity'].actions).toEqual(['isoNc.reassign']);
    expect(ENDPOINTS['reassignIsoNonconformity'].roles).toEqual({
      FIRM_ADMIN: 'all',
      CONSULTANT: 'all',
      CLIENT_ADMIN: 'all',
    });
    expect(ENDPOINTS['updateIsoManagementReview'].actions).toEqual(['isoReview.write']);
    expect(ENDPOINTS['updateIsoManagementReview'].roles).toEqual({
      FIRM_ADMIN: 'all',
      CONSULTANT: 'all',
      CLIENT_ADMIN: 'all',
      APPROVER: 'own',
      OWNER: 'own',
    });
    expect(ENDPOINTS['replanIsoManagementReview'].actions).toEqual(['isoReview.plan']);
    expect(ENDPOINTS['replanIsoManagementReview'].roles).toEqual({
      FIRM_ADMIN: 'all',
      CONSULTANT: 'all',
      CLIENT_ADMIN: 'all',
    });
  });

  it('are each called by an ISO suite', () => {
    // This file names route ids in its table checks without calling them, so it does not count.
    const sources = readdirSync(new URL('.', import.meta.url))
      .filter(
        (name) =>
          name.startsWith('iso-') && name.endsWith('.test.ts') && name !== 'iso-mock.test.ts',
      )
      .map((name) => readFileSync(new URL(name, import.meta.url), 'utf8'))
      .join('\n');
    const missing = ISO_IDS.filter((id) => !new RegExp(`['"\`]${id}['"\`]`).test(sources));
    expect(missing).toEqual([]);
  });
});

describe('the switch', () => {
  it('answers 403 FEATURE_NOT_ENABLED on every ISO route, reads included, while off', async () => {
    await setFeatures(app, []);
    try {
      for (const id of ['getIsoOverview', 'listIsoSystems', 'listIsoStandards'] as const) {
        const error = await fails(app, id, {}, 'FEATURE_NOT_ENABLED', 403);
        expect(error.error.details).toEqual({ feature: 'isoManagement' });
      }
      // A write is refused before its body is read.
      await fails(app, 'createIsoSystem', { body: {} }, 'FEATURE_NOT_ENABLED', 403);
    } finally {
      await setFeatures(app, ['isoManagement']);
    }
    await ok(app, 'listIsoSystems');
  });

  it('takes X-Mock-Features as the account features for one request', async () => {
    await fails(
      app,
      'listIsoSystems',
      { headers: { 'x-mock-features': '' } },
      'FEATURE_NOT_ENABLED',
      403,
    );
    await ok(app, 'listIsoSystems', { headers: { 'x-mock-features': 'isoManagement' } });
    expect(firmB(app).features).toContain('isoManagement');
    await fails(
      app,
      'listIsoSystems',
      { headers: { 'x-mock-features': 'Not A Flag' } },
      'VALIDATION',
      400,
    );
  });

  it('still checks the session first: no person is 401, not a feature error', async () => {
    await setFeatures(app, []);
    try {
      const anonymous = await call(app, 'listIsoSystems', { as: null });
      expect(anonymous.status).toBe(401);
    } finally {
      await setFeatures(app, ['isoManagement']);
    }
  });

  it('answers 409 FEATURE_NOT_READY until the catalogue copy is recorded', async () => {
    expect(firmA().isoCatalogueCopiedAt).toBeNull();
    const pending = await setFirmAFeatures(['isoManagement'], false);
    expect(pending).toEqual({ features: ['isoManagement'], isoCatalogueCopiedAt: null });
    const error = await fails(
      app,
      'listIsoSystems',
      { as: FIRM_A_ADMIN, params: { clientId: FIRM_A_CLIENT } },
      'FEATURE_NOT_READY',
      409,
    );
    expect(error.error.details).toEqual({ feature: 'isoManagement' });
    // The register keeps working meanwhile.
    expect(
      (await call(app, 'listInstances', { as: FIRM_A_ADMIN, params: { clientId: FIRM_A_CLIENT } }))
        .status,
    ).toBe(200);
  });
});

describe('the catalogue copy', () => {
  it('adds the STANDARD acts, the ISO category and the activities to the library once, audited', async () => {
    const before = {
      acts: firmA().data.acts.length,
      obligations: firmA().data.obligations.length,
      categories: firmA().data.categories.length,
      events: firmA().data.auditEvents.length,
    };
    const copied = await setFirmAFeatures(['isoManagement']);
    expect(copied.isoCatalogueCopiedAt).not.toBeNull();
    const data = firmA().data;
    const standardActs = data.acts.filter((a) => a.kind === 'STANDARD');
    // One act per standard and one for the integrated system (catalogue.md §2).
    expect(standardActs).toHaveLength(4);
    expect(standardActs.every((a) => a.jurisdiction === 'CENTRAL')).toBe(true);
    expect(data.categories.length).toBe(before.categories + 1);
    const activities = data.obligations.filter((o) => standardActs.some((a) => a.id === o.actId));
    expect(activities).toHaveLength(13);
    expect(data.obligations.length).toBe(before.obligations + 13);
    const created = data.auditEvents.slice(before.events);
    expect(created).toHaveLength(4 + 1 + 13);
    expect(created.every((e) => e.actorKind === 'SYSTEM' && e.action === 'CREATE')).toBe(true);

    // The account's own copy of the clauses, readable now.
    const as = { as: FIRM_A_ADMIN, params: { clientId: FIRM_A_CLIENT } };
    const standards = await ok<{ items: { code: string }[] }>(app, 'listIsoStandards', as);
    expect(standards.items.map((s) => s.code)).toEqual(['ISO_9001', 'ISO_14001', 'ISO_45001']);
    const clauses = await ok<{ items: { id: string }[] }>(app, 'listIsoClauses', as);
    expect(clauses.items.length).toBeGreaterThan(0);
    expect(
      clauses.items.every((c) => firmA().isoCatalogue.clauses.some((own) => own.id === c.id)),
    ).toBe(true);

    // Off and on again copies nothing more.
    await setFirmAFeatures([]);
    const again = await setFirmAFeatures(['isoManagement']);
    expect(again.isoCatalogueCopiedAt).toBe(copied.isoCatalogueCopiedAt);
    expect(firmA().data.obligations.length).toBe(before.obligations + 13);
    expect(firmA().data.acts.length).toBe(before.acts + 4);
  });

  it('gives each account its own catalogue ids', () => {
    const a = firmA().isoCatalogue.clauses.map((c) => c.id);
    const b = new Set(firmB(app).isoCatalogue.clauses.map((c) => c.id));
    expect(a.length).toBe(b.size);
    expect(a.some((id) => b.has(id))).toBe(false);
  });

  it('keeps firm B on, with its copy recorded, from the start', () => {
    expect(firmB(app).isoCatalogueCopiedAt).not.toBeNull();
    expect(PERSON.meera).toBeTruthy();
  });
});

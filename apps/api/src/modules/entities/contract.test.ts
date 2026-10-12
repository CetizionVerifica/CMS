import { ApiErrorResponse, ENDPOINTS, Role, type Endpoint } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { M6_ENDPOINT_IDS, SCENARIOS } from './testing/scenarios.js';
import { ACTOR_FOR_ROLE, testApp, type ActorName } from './testing/world.js';

/**
 * M6 acceptance (MODULES.md): endpoints match the contracts (paths, methods, statuses, response schemas), every
 * write is audited, and every endpoint is tested for each role it allows and each it forbids.
 */

const endpoints = M6_ENDPOINT_IDS.map((id) => [id, ENDPOINTS[id] as Endpoint] as const);
const READ_ONLY_POSTS = new Set(['previewRule']);

function firstAllowedRole(endpoint: Endpoint): Role {
  return Role.options.find((r) => endpoint.roles[r] !== undefined)!;
}

/** Runs an endpoint's scenario as `actor` (scenario bodies may depend on the role) on a fresh world. */
async function run(
  id: string,
  endpoint: Endpoint,
  role: Role,
  actor: ActorName | null = ACTOR_FOR_ROLE[role],
) {
  const t = testApp();
  const scenario = SCENARIOS[id]!(role);
  scenario.setup?.(t.store);
  const res = await t.call(actor, endpoint.method, scenario.url, scenario.body);
  return { ...t, res };
}

describe('M6 contract', () => {
  it('has a scenario for every M6 endpoint in the contracts', () => {
    expect(M6_ENDPOINT_IDS.length).toBeGreaterThan(40);
    expect(M6_ENDPOINT_IDS.filter((id) => !SCENARIOS[id])).toEqual([]);
  });

  it('registers every M6 endpoint at its contract path and method', async () => {
    const { app } = testApp();
    await app.ready();
    for (const [, endpoint] of endpoints) {
      const url = `/api/v1${endpoint.path.replace(/\{(\w+)\}/g, ':$1')}`;
      expect(app.hasRoute({ method: endpoint.method, url }), `${endpoint.method} ${url}`).toBe(
        true,
      );
    }
  });

  describe.each(endpoints)('%s', (id, endpoint) => {
    it(`answers ${endpoint.status} with the contract response`, async () => {
      const { res } = await run(id, endpoint, firstAllowedRole(endpoint));
      expect(res.status, JSON.stringify(res.body)).toBe(endpoint.status);
      const parsed = endpoint.response.safeParse(res.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(res.headers['x-request-id']).toBeTruthy();
    });

    it.each(Role.options)('as %s', async (role) => {
      const { res } = await run(id, endpoint, role);
      if (endpoint.roles[role] === undefined) {
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(ApiErrorResponse.parse(res.body).error.code).toBe('FORBIDDEN');
      } else {
        expect(res.status, JSON.stringify(res.body)).toBe(endpoint.status);
      }
    });

    if (endpoint.method !== 'GET' && !READ_ONLY_POSTS.has(id)) {
      it('writes an audit event for the change in the same request', async () => {
        const { res, store } = await run(id, endpoint, firstAllowedRole(endpoint));
        expect(res.status).toBe(endpoint.status);
        expect(store.audits.length).toBeGreaterThan(0);
        for (const audit of store.audits) {
          expect(audit.requestId).toBe('req-test');
          expect(audit.firmId).toBeTruthy();
          expect(audit.after ?? audit.before).not.toBeNull();
        }
      });
    } else {
      it('writes nothing', async () => {
        const { store } = await run(id, endpoint, firstAllowedRole(endpoint));
        expect(store.audits).toEqual([]);
        expect(store.events).toEqual([]);
      });
    }

    it('is 401 without a session', async () => {
      const { res } = await run(id, endpoint, 'FIRM_ADMIN', null);
      expect(res.status).toBe(401);
      expect(ApiErrorResponse.parse(res.body).error.code).toBe('UNAUTHENTICATED');
    });

    if (endpoint.path.includes('{')) {
      it("is 404 to another firm's admin", async () => {
        const { res } = await run(id, endpoint, 'FIRM_ADMIN', 'otherFirmAdmin');
        expect(res.status, JSON.stringify(res.body)).toBe(404);
        expect(ApiErrorResponse.parse(res.body).error.code).toBe('NOT_FOUND');
      });
    }
  });
});

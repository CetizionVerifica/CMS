import { ENDPOINTS } from '@canopy/contracts';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerIsoRoutes } from './routes.js';
import { ISO_SERVED_ENDPOINTS } from './served.js';
import { createFakeIsoFiles } from './testing/fake-files.js';

describe('ISO_SERVED_ENDPOINTS', () => {
  it('names exactly the contract endpoints registerIsoRoutes mounts', async () => {
    const mounted: string[] = [];
    const probe = Fastify();
    probe.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (method !== 'HEAD') mounted.push(`${method} ${route.url}`);
      }
    });
    // Registration only: no handler runs, so no database is needed.
    registerIsoRoutes(probe, { db: {} as never, files: createFakeIsoFiles('client') });
    await probe.ready();
    await probe.close();
    const byRoute = new Map(
      Object.entries(ENDPOINTS).map(([id, e]) => [
        `${e.method} ${e.path.replace(/\{(\w+)\}/g, ':$1')}`,
        id,
      ]),
    );
    const ids = mounted.map((r) => byRoute.get(r) ?? r);
    expect([...ids].sort()).toEqual([...ISO_SERVED_ENDPOINTS].sort());
    expect(ISO_SERVED_ENDPOINTS.every((id) => ENDPOINTS[id].module === 'M16')).toBe(true);
  });
});

import { ENDPOINTS } from '@canopy/contracts';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerIsoRoutes } from './routes.js';
import { ISO_FILE_ENDPOINTS, ISO_SERVED_ENDPOINTS } from './served.js';
import { createFakeIsoFiles } from './testing/fake-files.js';
import type { IsoRouteOptions } from './types.js';

const byRoute = new Map(
  Object.entries(ENDPOINTS).map(([id, e]) => [
    `${e.method} ${e.path.replace(/\{(\w+)\}/g, ':$1')}`,
    id,
  ]),
);

/** The contract ids of the routes `registerIsoRoutes` mounts with these options (registration only, no database). */
async function mounted(options: Partial<IsoRouteOptions>): Promise<string[]> {
  const ids: string[] = [];
  const probe = Fastify();
  probe.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD')
        ids.push(byRoute.get(`${method} ${route.url}`) ?? `${method} ${route.url}`);
    }
  });
  registerIsoRoutes(probe, { db: {} as never, ...options });
  await probe.ready();
  await probe.close();
  return ids.sort();
}

describe('the served ISO endpoint lists', () => {
  it('name exactly the contract endpoints mounted, the file routes only with an IsoFiles', async () => {
    expect(await mounted({})).toEqual([...ISO_SERVED_ENDPOINTS].sort());
    expect(await mounted({ files: createFakeIsoFiles('client') })).toEqual(
      [...ISO_SERVED_ENDPOINTS, ...ISO_FILE_ENDPOINTS].sort(),
    );
    expect(
      [...ISO_SERVED_ENDPOINTS, ...ISO_FILE_ENDPOINTS].every(
        (id) => ENDPOINTS[id].module === 'M16',
      ),
    ).toBe(true);
  });
});

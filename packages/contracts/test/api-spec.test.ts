import { readFileSync } from 'node:fs';
import { validate } from '@readme/openapi-parser';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Action,
  buildOpenApi,
  CONTRACTS_VERSION,
  ENDPOINTS,
  type Endpoint,
  Role,
} from '../src/index.js';

const endpoints = Object.entries(ENDPOINTS) as [string, Endpoint][];
const committed = JSON.parse(
  readFileSync(new URL('../../../docs/contracts/openapi.json', import.meta.url), 'utf8'),
) as unknown;
const [endpointsMd = ''] = readFileSync(
  new URL('../../../docs/contracts/endpoints.md', import.meta.url),
  'utf8',
).split(/^## 9\. /m);

/** The paths in the table rows of a slice of endpoints.md. */
function documentedPaths(markdown: string): Set<string> {
  const rows = markdown.split('\n').filter((line) => /^\| (GET|POST|PUT|PATCH)\b/.test(line));
  return new Set(
    rows.flatMap((row) =>
      [...row.matchAll(/`(\/[a-z][\w\-/{}]*)`/g)].map((match) => match[1] as string),
    ),
  );
}

describe('OpenAPI document', () => {
  const doc = buildOpenApi();

  it('matches the committed docs/contracts/openapi.json (run `pnpm --filter @canopy/contracts openapi`)', () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it('is valid OpenAPI 3.1 ("spec lints clean")', async () => {
    const result = await validate(structuredClone(doc) as never);
    expect(result).toMatchObject({ valid: true, warnings: [] });
  });

  it('is versioned with the contracts package', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(CONTRACTS_VERSION);
  });

  it('has one operation per endpoint, named by its id', () => {
    const operationIds = Object.values(doc.paths).flatMap((ops) =>
      Object.values(ops).map((op) => op.operationId),
    );
    expect(operationIds.sort()).toEqual(endpoints.map(([id]) => id).sort());
  });

  it('asks for the CSRF token on every signed-in write and Idempotency-Key where honoured', () => {
    for (const [, ep] of endpoints) {
      const op = doc.paths[ep.path]?.[ep.method.toLowerCase()] as { parameters?: unknown[] };
      const refs = (op.parameters ?? []).map((p) => (p as { $ref?: string }).$ref);
      expect(refs.includes('#/components/parameters/CsrfToken')).toBe(
        ep.method !== 'GET' && ep.auth !== 'public',
      );
      expect(refs.includes('#/components/parameters/IdempotencyKey')).toBe(ep.idempotent);
    }
  });

  it('marks public endpoints as needing no session', () => {
    const login = doc.paths['/auth/login']?.post as { security: unknown[] };
    const me = doc.paths['/me']?.get as { security: unknown[] };
    expect(login.security).toEqual([]);
    expect(me.security).toEqual([{ session: [] }]);
  });

  it('names shared shapes once and references them', () => {
    const json = JSON.stringify(doc.components.schemas.InstanceDetail);
    expect(json).toContain('"$ref":"#/components/schemas/Id"');
    expect(json).toContain('"$ref":"#/components/schemas/LocalDate"');
    expect(doc.components.schemas.LocalDate).toEqual({
      type: 'string',
      format: 'date',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    });
  });
});

describe('endpoint table', () => {
  it('has one endpoint per method and path', () => {
    const keys = endpoints.map(([, ep]) => `${ep.method} ${ep.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists the same paths as endpoints.md', () => {
    const documented = documentedPaths(endpointsMd);
    const coded = new Set(endpoints.map(([, ep]) => ep.path));
    expect([...coded].filter((path) => !documented.has(path))).toEqual([]);
    expect([...documented].filter((path) => !coded.has(path))).toEqual([]);
  });

  it('gives every signed-in endpoint roles, and every action endpoint can() action names', () => {
    for (const [id, ep] of endpoints) {
      if (ep.auth === 'public') {
        expect(ep.roles, id).toEqual({});
        expect(ep.actions, id).toEqual([]);
        continue;
      }
      expect(Object.keys(ep.roles).length, id).toBeGreaterThan(0);
      for (const role of Object.keys(ep.roles)) expect(Role.options).toContain(role);
      if (ep.auth === 'action') {
        expect(ep.actions.length, id).toBeGreaterThan(0);
        for (const action of ep.actions)
          expect(Action.safeParse(action).success, action).toBe(true);
      }
      if (Object.values(ep.roles).includes('limited')) expect(ep.notes, id).toBeDefined();
    }
  });

  it('declares a path param for every {name} in the path', () => {
    for (const [id, ep] of endpoints) {
      const names = [...ep.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(Object.keys(ep.params?.shape ?? {}), id).toEqual(names);
    }
  });

  it('sends no body on GET', () => {
    for (const [id, ep] of endpoints) {
      if (ep.method === 'GET') expect(ep.body, id).toBeNull();
    }
  });

  it('honours Idempotency-Key on transitions, bulk approve, import commit, export creation and support grants', () => {
    const idempotent = endpoints.filter(([, ep]) => ep.idempotent).map(([id]) => id);
    expect(idempotent.sort()).toEqual(
      [
        'approveInstance',
        'bulkApprove',
        'commitImport',
        'createExport',
        'createSupportGrant',
        'reopenInstance',
        'requestNa',
        'sendBackInstance',
        'submitInstance',
      ].sort(),
    );
  });

  it('only returns lists inside an object, so fields can be added later', () => {
    for (const [id, ep] of endpoints) {
      expect(ep.response instanceof z.ZodArray, id).toBe(false);
    }
  });

  it('has responses with no transforms, so the spec shows what the wire carries', () => {
    for (const [id, ep] of endpoints) {
      const input = z.toJSONSchema(ep.response, { io: 'input', unrepresentable: 'any' });
      const output = z.toJSONSchema(ep.response, { io: 'output', unrepresentable: 'any' });
      expect(input, id).toEqual(output);
    }
  });
});

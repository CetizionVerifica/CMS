import { ApiErrorResponse, ENDPOINTS, type Endpoint } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { DuplicateError, type Repo, type Tx } from '../store.js';
import { contextOf, ids } from '../testing/world.js';
import { auditedUpdate } from '../write.js';
import { can } from '../../../auth/index.js';
import { authorize, rolesFor, unitScope } from './access.js';
import { decodeCursor, encodeCursor } from './page.js';
import { errorEnvelope } from './route.js';

type Row = { id: string; version: number; name: string; secret?: string };

function fakeRepo(
  update: Repo<Row>['update'],
  get: Repo<Row>['get'] = async () => null,
): Repo<Row> {
  return {
    get,
    update,
    list: async () => ({ items: [] }),
    findAll: async () => [],
    insert: async () => {
      throw new Error('unused');
    },
  };
}

function fakeTx(audits: unknown[]): Tx {
  return { audit: async (a: unknown) => void audits.push(a) } as unknown as Tx;
}

describe('errorEnvelope', () => {
  it('hides unexpected errors behind INTERNAL', () => {
    const { status, body } = errorEnvelope(new Error('database password is hunter2'), 'r1');
    expect(status).toBe(500);
    expect(ApiErrorResponse.parse(body).error).toEqual({
      code: 'INTERNAL',
      message: 'Something went wrong.',
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('maps a broken unique rule to DUPLICATE', () => {
    const { status, body } = errorEnvelope(new DuplicateError('name', ids.companyA), 'r1');
    expect(status).toBe(409);
    expect(ApiErrorResponse.parse(body).error.details).toEqual({
      field: 'name',
      existingId: ids.companyA,
    });
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    expect(decodeCursor(encodeCursor('Plant', ids.unit1))).toEqual({ key: 'Plant', id: ids.unit1 });
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor(Buffer.from('{"k":1}').toString('base64url'))).toThrow(
      /Unknown cursor/,
    );
  });
});

describe('auditedUpdate', () => {
  const row: Row = { id: ids.unit1, version: 1, name: 'Plant', secret: 'a' };

  it('reports the current version when the row moved under it', async () => {
    const repo = fakeRepo(
      async () => 'STALE',
      async () => ({ ...row, version: 4 }),
    );
    await expect(
      auditedUpdate({
        tx: fakeTx([]),
        repo,
        entityType: 'unit',
        row,
        version: 1,
        patch: { name: 'X' },
        clientId: null,
      }),
    ).rejects.toMatchObject({ code: 'STALE_VERSION', details: { currentVersion: 4 } });
  });

  it('is 404 when the policy refuses the write', async () => {
    const repo = fakeRepo(async () => null);
    await expect(
      auditedUpdate({
        tx: fakeTx([]),
        repo,
        entityType: 'unit',
        row,
        version: 1,
        patch: { name: 'X' },
        clientId: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('audits the value the store kept, not the one asked for', async () => {
    const audits: { before: unknown; after: unknown }[] = [];
    const repo = fakeRepo(async () => ({ ...row, name: 'Plant 2', version: 2 }));
    await auditedUpdate({
      tx: fakeTx(audits),
      repo,
      entityType: 'unit',
      row,
      version: 1,
      patch: { name: 'Plant 2 ' },
      clientId: null,
    });
    expect(audits[0]).toMatchObject({ before: { name: 'Plant' }, after: { name: 'Plant 2' } });
  });

  it('can keep a value out of the audit row', async () => {
    const audits: { before: unknown; after: unknown }[] = [];
    const repo = fakeRepo(async (_id, _v, patch) => ({ ...row, ...patch, version: 2 }));
    await auditedUpdate({
      tx: fakeTx(audits),
      repo,
      entityType: 'unit',
      row,
      version: 1,
      patch: { name: 'X', secret: 'b' },
      clientId: null,
      redact: ['secret'],
    });
    expect(audits[0]).toMatchObject({
      before: { name: 'Plant', secret: '[redacted]' },
      after: { name: 'X', secret: '[redacted]' },
    });
  });
});

describe('access', () => {
  it('scopes owners and approvers to their units and others to every unit', () => {
    expect(unitScope(contextOf('owner'), ids.clientA)).toEqual([ids.unit1]);
    expect(unitScope(contextOf('clientAdmin'), ids.clientA)).toBeNull();
    expect(rolesFor(contextOf('owner'), ids.clientA, ids.unit2)).toEqual([]);
    expect(rolesFor(contextOf('consultant'), ids.clientB)).toEqual([]);
  });

  it('checks the policy as well as the role table', () => {
    const endpoint = ENDPOINTS.listClients as Endpoint;
    expect(() =>
      authorize(contextOf('firmAdmin'), endpoint, { type: 'client', clientId: null }, () => false),
    ).toThrow(/Not allowed: client.read/);
    expect(() =>
      authorize(contextOf('owner'), endpoint, { type: 'client', clientId: ids.clientB }, can),
    ).toThrow(/Not found/);
  });
});

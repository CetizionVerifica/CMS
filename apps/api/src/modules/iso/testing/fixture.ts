import { randomBytes, randomUUID } from 'node:crypto';
import {
  DEFAULT_CLIENT_SETTINGS,
  type IsoFileSubject,
  type Role,
  type ScanStatus,
} from '@canopy/contracts';
import {
  clients,
  companies,
  createAdminDatabase,
  createDatabase,
  isoCatalogue,
  isoFiles,
  locations,
  memberships,
  people,
  systemContext,
  units,
  type Database,
  type TenantTx,
} from '@canopy/db';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { accountView, createTestAuth } from '../../../auth/testing.js';
import { buildServer, type ServerOptions } from '../../../server.js';
import { createFakeIsoFiles, type FakeIsoFiles } from './fake-files.js';

/**
 * Postgres fixtures for M16's db tests (no import from M7's): a throwaway database per test file (DATABASE_URL, as in
 * the CI `db` job), one firm with one client of two units, the account's ISO catalogue copy (9001 and 14001, our own
 * clause titles), and the cast signed in against a server with `isoManagement` on and a fake `IsoFiles`.
 */

export interface TestDb {
  db: Database;
  createFirm(name: string): Promise<string>;
  /** Ids and kinds of a firm's audit and outbox rows, read as the database owner (no RLS), for assertions. */
  written(firmId: string): Promise<{ audit: Map<string, string>; outbox: Map<string, string> }>;
  /** Rows of a query run as the database owner. */
  query<T extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; db tests need Postgres 16.');
  const base = new URL(url);
  const name = `canopy_iso_${randomBytes(6).toString('hex')}`;
  const server = new pg.Client({ connectionString: base.toString() });
  await server.connect();
  await server.query(`CREATE DATABASE ${name}`);
  await server.end();
  const target = new URL(base);
  target.pathname = `/${name}`;
  const admin = createAdminDatabase({ connectionString: target.toString() });
  await admin.migrate();
  const db = createDatabase({ connectionString: target.toString(), max: 4 });
  const owner = new pg.Client({ connectionString: target.toString() });
  await owner.connect();
  const rows = async (sql: string, firmId: string) => {
    const result = await owner.query<{ id: string; kind: string }>(sql, [firmId]);
    return new Map(result.rows.map((r) => [r.id, r.kind]));
  };
  return {
    db,
    createFirm: (firmName) => admin.createFirm({ name: firmName }),
    async written(firmId) {
      return {
        audit: await rows('SELECT id, action AS kind FROM audit_event WHERE firm_id = $1', firmId),
        outbox: await rows('SELECT id, type AS kind FROM domain_event WHERE firm_id = $1', firmId),
      };
    },
    async query(sql, params = []) {
      return (await owner.query(sql, params)).rows;
    },
    async drop() {
      await owner.end();
      await Promise.all([db.close(), admin.close()]);
      const cleanup = new pg.Client({ connectionString: base.toString() });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** People of the fixture firm, by the role they hold. */
export interface Cast {
  firmAdmin: string;
  consultant: string;
  clientAdmin: string;
  /** A second client admin, to approve what the first prepared. */
  otherAdmin: string;
  /** APPROVER of every unit. */
  approver: string;
  /** APPROVER of unit B only. */
  approverB: string;
  /** OWNER of unit A only. */
  owner: string;
  /** OWNER of unit B only. */
  otherOwner: string;
  viewer: string;
}

export type Who = keyof Cast;

type MembershipSpec = {
  role: Role;
  clientId?: string | null;
  consultantClientIds?: string[] | null;
  unitIds?: string[] | null;
};

export interface Fixture {
  firmId: string;
  clientId: string;
  unitA: string;
  unitB: string;
  people: Cast;
  memberships: Record<Who, MembershipSpec[]>;
  std9001: string;
  std14001: string;
  /** Clause ids by `<standard>:<number>`, e.g. `9001:4.1`. */
  clauses: Record<string, string>;
}

async function person(tx: TenantTx, name: string): Promise<string> {
  const created = await people.create(tx, {
    displayName: name,
    nameNormalized: name.toLowerCase(),
    email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.test`,
    status: 'ACTIVE',
  });
  return created.id;
}

const CLAUSES: {
  std: '9001' | '14001';
  number: string;
  assessable?: boolean;
  exclusion?: boolean;
}[] = [
  { std: '9001', number: '4', assessable: false },
  { std: '9001', number: '4.1' },
  { std: '9001', number: '8.3', exclusion: true },
  { std: '9001', number: '10.1' },
  { std: '14001', number: '4.1' },
  { std: '14001', number: '6.1.2' },
];

/** Writes the fixture firm and its catalogue copy. `firmId` comes from `TestDb.createFirm`. */
export async function seedFixture(db: Database, firmId: string, label: string): Promise<Fixture> {
  return db.withTenant(systemContext(firmId, `iso-fixture-${label}`), async (tx) => {
    const location = await locations.create(tx, {
      country: 'India',
      countryCode: 'IN',
      state: 'West Bengal',
      stateCode: 'WB',
      city: 'Riverbend',
    });
    const client = await clients.create(tx, {
      name: `${label} Kestrel Metals Group`,
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    const company = await companies.create(tx, { clientId: client.id, name: 'Kestrel Fibres' });
    const unit = (name: string) =>
      units.create(tx, {
        clientId: client.id,
        companyId: company.id,
        name,
        locationId: location.id,
      });
    const unitA = await unit('Stonebridge plant');
    const unitB = await unit('Highmoor plant');
    const cast: Cast = {
      firmAdmin: await person(tx, `${label} Firm Admin`),
      consultant: await person(tx, `${label} Consultant`),
      clientAdmin: await person(tx, `${label} Client Admin`),
      otherAdmin: await person(tx, `${label} Other Admin`),
      approver: await person(tx, `${label} Approver`),
      approverB: await person(tx, `${label} Approver B`),
      owner: await person(tx, `${label} Owner`),
      otherOwner: await person(tx, `${label} Other Owner`),
      viewer: await person(tx, `${label} Viewer`),
    };
    const roles: Fixture['memberships'] = {
      firmAdmin: [{ role: 'FIRM_ADMIN', clientId: null }],
      consultant: [{ role: 'CONSULTANT', clientId: null, consultantClientIds: [client.id] }],
      clientAdmin: [{ role: 'CLIENT_ADMIN', clientId: client.id }],
      otherAdmin: [{ role: 'CLIENT_ADMIN', clientId: client.id }],
      approver: [{ role: 'APPROVER', clientId: client.id, unitIds: null }],
      approverB: [{ role: 'APPROVER', clientId: client.id, unitIds: [unitB.id] }],
      owner: [{ role: 'OWNER', clientId: client.id, unitIds: [unitA.id] }],
      otherOwner: [{ role: 'OWNER', clientId: client.id, unitIds: [unitB.id] }],
      viewer: [{ role: 'VIEWER', clientId: client.id }],
    };
    for (const key of Object.keys(cast) as Who[]) {
      for (const m of roles[key]) {
        await memberships.create(tx, {
          personId: cast[key],
          role: m.role,
          clientId: m.clientId ?? null,
          consultantClientIds: m.consultantClientIds ?? null,
          unitIds: m.unitIds ?? null,
          expiresAt: m.role === 'VIEWER' ? '2099-01-01T00:00:00Z' : null,
        });
      }
    }

    const std9001 = await isoCatalogue.createStandard(tx, {
      code: 'ISO_9001',
      edition: '2015+A1:2024',
      title: 'ISO 9001',
      topic: 'Quality management',
    });
    const std14001 = await isoCatalogue.createStandard(tx, {
      code: 'ISO_14001',
      edition: '2015+A1:2024',
      title: 'ISO 14001',
      topic: 'Environmental management',
    });
    const created = await isoCatalogue.createClauses(
      tx,
      CLAUSES.map((c) => ({
        standardId: c.std === '9001' ? std9001.id : std14001.id,
        number: c.number,
        title: `Clause ${c.number}`,
        summary: 'Our own summary.',
        parentId: null,
        hlsKey: null,
        assessable: c.assessable ?? true,
        exclusionAllowed: c.exclusion ?? false,
      })),
    );
    const clauses: Record<string, string> = {};
    for (const c of created) {
      clauses[`${c.standardId === std9001.id ? '9001' : '14001'}:${c.number}`] = c.id;
    }
    await isoCatalogue.createReviewInputDefs(tx, [
      {
        standardId: std14001.id,
        key: 'PREVIOUS_ACTIONS',
        clauseNumber: '9.3.2',
        item: 'a',
        title: 'Actions from previous reviews',
        source: 'PREVIOUS_ACTIONS',
      },
      {
        standardId: std9001.id,
        key: 'CUSTOMER_SATISFACTION',
        clauseNumber: '9.3.2',
        item: 'c1',
        title: 'Customer satisfaction',
        source: 'MANUAL',
      },
    ]);
    await isoCatalogue.createReviewOutputDefs(tx, [
      {
        standardId: std9001.id,
        key: 'SUITABILITY',
        clauseNumber: '9.3',
        item: null,
        title: 'Suitability of the system',
      },
    ]);
    return {
      firmId,
      clientId: client.id,
      unitA: unitA.id,
      unitB: unitB.id,
      people: cast,
      memberships: roles,
      std9001: std9001.id,
      std14001: std14001.id,
      clauses,
    };
  });
}

export interface Reply {
  status: number;
  body: Record<string, unknown> & { items?: Record<string, unknown>[] };
}

export interface Harness {
  testDb: TestDb;
  f: Fixture;
  app: FastifyInstance;
  /** The fake `IsoFiles` the server uses, unless `createHarness` was given another `files` option. */
  files: FakeIsoFiles;
  auth: ReturnType<typeof createTestAuth>;
  headers: Record<Who, Record<string, string>>;
  /** A request as `who` under `/api/v1/clients/<clientId>/iso`. */
  send(
    who: Who,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    payload?: object,
    extra?: Record<string, string>,
  ): Promise<Reply>;
  /** Like `send`, but fails the test unless the answer is 2xx; returns the body. */
  ok(
    who: Who,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    payload?: object,
  ): Promise<Record<string, unknown>>;
  /** Runs as the firm's system context (fixture writes the routes do not offer). */
  asSystem<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Sets a file's scan result, as M9's scan job would. */
  scan(fileId: string, status: ScanStatus): Promise<void>;
  close(): Promise<void>;
}

/**
 * How the harness serves ISO files: the fake port (the default), M7's real service over the given evidence storage,
 * as the integrated app is wired, or no file routes at all.
 */
export type HarnessFiles =
  'fake' | 'none' | { storage: NonNullable<ServerOptions['evidenceStorage']> };

/** The fixture, a server over it with the add-on on, and the cast signed in. */
export async function createHarness(
  label: string,
  now: Date,
  options: { files?: HarnessFiles } = {},
): Promise<Harness> {
  const served = options.files ?? 'fake';
  const testDb = await createTestDb();
  const firmId = await testDb.createFirm(`${label} firm`);
  const f = await seedFixture(testDb.db, firmId, label);
  const auth = createTestAuth();
  auth.store.accounts.set(
    firmId,
    accountView(firmId, {
      entitlements: {
        planCode: 'CONSULTANCY',
        limits: { companies: null, units: null, users: null, storageBytes: null },
        features: ['isoManagement'],
      },
    }),
  );
  const headers = {} as Record<Who, Record<string, string>>;
  for (const key of Object.keys(f.people) as Who[]) {
    headers[key] = auth.signIn({
      firmId,
      personId: f.people[key],
      memberships: f.memberships[key],
      principal: { firmClientIds: [f.clientId] },
    }).headers;
  }
  const files = createFakeIsoFiles(f.clientId);
  const app = buildServer({
    authStore: auth.store,
    database: testDb.db,
    ...(served === 'fake' ? { isoFiles: files } : {}),
    ...(typeof served === 'object' ? { evidenceStorage: served.storage } : {}),
    clock: () => now,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
  });
  await app.ready();
  const asSystem = <T>(fn: (tx: TenantTx) => Promise<T>) =>
    testDb.db.withTenant(systemContext(firmId, `iso-test-${randomUUID()}`), fn);

  const send: Harness['send'] = async (who, method, path, payload, extra = {}) => {
    const res = await app.inject({
      method,
      url: `/api/v1/clients/${f.clientId}/iso${path}`,
      headers: { ...headers[who], ...extra },
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: res.statusCode, body: res.json() as Reply['body'] };
  };
  return {
    testDb,
    f,
    app,
    files,
    auth,
    headers,
    send,
    async ok(who, method, path, payload) {
      const reply = await send(who, method, path, payload);
      if (reply.status >= 300) {
        throw new Error(
          `${method} ${path} as ${who}: ${reply.status} ${JSON.stringify(reply.body)}`,
        );
      }
      return reply.body;
    },
    asSystem,
    async scan(fileId, status) {
      await asSystem((tx) => isoFiles.setScanStatus(tx, fileId, status));
    },
    async close() {
      await app.close();
      await testDb.drop();
    },
  };
}

/** A file on a subject as the client sends it: upload ticket, then confirm (the fake stores the row). */
export async function attach(
  h: Harness,
  who: Who,
  subject: IsoFileSubject,
  fileName = 'procedure.pdf',
): Promise<Record<string, unknown>> {
  const ticket = await h.ok(who, 'POST', '/files/upload-url', {
    subject,
    fileName,
    mimeType: 'application/pdf',
    sizeBytes: 2048,
  });
  return h.ok(who, 'POST', '/files', {
    subject,
    uploadId: ticket.uploadId,
    fileName,
    sha256: 'a'.repeat(64),
  });
}

import { DEFAULT_CLIENT_SETTINGS, DEFAULT_FIRM_SETTINGS, type Id } from '@canopy/contracts';
import * as r from '@canopy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../entities/testing/postgres.js';
import { copyMasterLibrary } from './db-library-copy.js';
import { SAMPLE_MASTER } from './testing/sample-master.js';

// The master library copy on account.created (ADR M15-0001 decision 8, ADR M6-0001) against Postgres under RLS (CI
// `db` job). Skipped when DATABASE_URL is not set.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('copying the master library into a new account', () => {
  let t: TestDatabase;
  let op: r.OperatorDatabase;

  const newAccount = (name: string, email: string): r.NewAccount => ({
    name,
    kind: 'ENTERPRISE',
    planCode: 'BUSINESS',
    trialEndsOn: '2026-11-23',
    settings: DEFAULT_FIRM_SETTINGS,
    profile: {
      legalName: `${name} Private Limited`,
      gstin: null,
      timeZone: 'Asia/Kolkata',
      fyStartMonth: 4,
    },
    client: { name, settings: DEFAULT_CLIENT_SETTINGS },
    owner: { displayName: 'Asha Rao', email },
    inviteExpiresAt: '2099-01-01T00:00:00.000Z',
    operatorId: '01920000-0000-7000-8000-0000000000aa',
    requestId: 'library-copy-test',
  });
  const create = (name: string, email: string) =>
    op.withOperator('library-copy-test', (tx) =>
      r.platformAccounts.create(tx, newAccount(name, email)),
    );
  const inAccount = <T>(id: Id, fn: (tx: r.TenantTx) => Promise<T>) =>
    t.db.withTenant(r.systemContext(id, 'library-copy-test'), fn);
  const libraryOf = (id: Id) =>
    inAccount(id, async (tx) => ({
      categories: await r.categories.findAll(tx, {}),
      acts: await r.acts.findAll(tx, {}),
      obligations: await r.obligations.findAll(tx, {}),
      audit: (await r.auditEvents.query(tx, {})).items,
      copied: await r.account.libraryCopied(tx),
    }));

  beforeAll(async () => {
    t = await createTestDatabase(url!);
    op = r.createOperatorDatabase({ connectionString: t.url, max: 2 });
  });

  afterAll(async () => {
    await op?.close();
    await t?.drop();
  });

  it('copies every row with its references, audits each, and records the copy', async () => {
    const account = await create('Kestrel Metals Group', 'asha.rao@kestrel-metals.example');
    expect(await libraryOf(account.accountId)).toMatchObject({ obligations: [], copied: false });

    expect(await copyMasterLibrary(t.db, account.accountId, 'evt-1', SAMPLE_MASTER)).toEqual({
      copied: true,
      categories: 1,
      acts: 1,
      obligations: 2,
    });

    const copy = await libraryOf(account.accountId);
    expect(copy.copied).toBe(true);
    expect(copy.categories).toMatchObject([
      { name: 'Returns', aliases: ['Return'], firmId: account.accountId },
    ]);
    expect(copy.acts).toMatchObject([{ name: 'Factories Act, 1948', jurisdiction: 'CENTRAL' }]);
    expect(copy.obligations).toHaveLength(2);
    for (const o of copy.obligations) {
      expect(o).toMatchObject({
        actId: copy.acts[0]!.id,
        categoryId: copy.categories[0]!.id,
        libraryVersion: 3,
      });
    }
    expect(copy.obligations.map((o) => o.externalRef).sort()).toEqual([
      'EHS-MASTER-0001',
      'EHS-MASTER-0002',
    ]);
    const created = copy.audit.filter((e) => e.action === 'CREATE');
    expect(created).toHaveLength(4);
    for (const e of created) {
      expect(e).toMatchObject({
        actorKind: 'SYSTEM',
        actorId: null,
        clientId: null,
        requestId: 'evt-1',
        reason: 'Master library version 3',
        before: null,
      });
    }
    expect(created.map((e) => e.entityType).sort()).toEqual([
      'act',
      'category',
      'obligation',
      'obligation',
    ]);
  });

  it('copies once when the event is delivered twice, one after the other', async () => {
    const account = await create('Osprey Textiles Group', 'owner@osprey-textiles.example');
    await copyMasterLibrary(t.db, account.accountId, 'evt-2', SAMPLE_MASTER);
    expect(await copyMasterLibrary(t.db, account.accountId, 'evt-2', SAMPLE_MASTER)).toEqual({
      copied: false,
      categories: 0,
      acts: 0,
      obligations: 0,
    });
    const copy = await libraryOf(account.accountId);
    expect(copy.obligations).toHaveLength(2);
    expect(copy.audit.filter((e) => e.action === 'CREATE')).toHaveLength(4);
  });

  it('copies once when two deliveries run at the same time', async () => {
    const account = await create('Riverbend Works', 'owner@riverbend.example');
    const runs = await Promise.all([
      copyMasterLibrary(t.db, account.accountId, 'evt-3', SAMPLE_MASTER),
      copyMasterLibrary(t.db, account.accountId, 'evt-3', SAMPLE_MASTER),
    ]);
    expect(runs.map((x) => x.copied).sort()).toEqual([false, true]);
    expect((await libraryOf(account.accountId)).obligations).toHaveLength(2);
  });

  it('rolls the record back with a failed copy, so the retried event copies again', async () => {
    const account = await create('Stonebridge Mills', 'owner@stonebridge.example');
    const broken = {
      ...SAMPLE_MASTER,
      obligations: [{ ...SAMPLE_MASTER.obligations[0]!, title: '' }],
    };
    await expect(copyMasterLibrary(t.db, account.accountId, 'evt-4', broken)).rejects.toThrow();
    expect(await libraryOf(account.accountId)).toMatchObject({
      categories: [],
      acts: [],
      obligations: [],
      copied: false,
    });
    expect(await copyMasterLibrary(t.db, account.accountId, 'evt-4', SAMPLE_MASTER)).toMatchObject({
      copied: true,
    });
  });

  it('copies nothing into an account that is not being set up', async () => {
    const firm: Id = await t.admin.createFirm({ name: 'Highmoor Advisory' });
    expect(await copyMasterLibrary(t.db, firm, 'evt-5', SAMPLE_MASTER)).toMatchObject({
      copied: false,
    });
    expect((await libraryOf(firm)).acts).toEqual([]);
  });

  it('refuses a broken library before it touches the account', async () => {
    const account = await create('Kestrel Fibres', 'owner@kestrel-fibres.example');
    const broken = { ...SAMPLE_MASTER, acts: [] };
    await expect(copyMasterLibrary(t.db, account.accountId, 'evt-6', broken)).rejects.toThrow(
      'names unknown Act',
    );
    expect((await libraryOf(account.accountId)).copied).toBe(false);
  });
});

import { DEFAULT_CLIENT_SETTINGS, DEFAULT_FIRM_SETTINGS, type Id } from '@canopy/contracts';
import * as r from '@canopy/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../entities/testing/postgres.js';
import { copyIsoCatalogue } from './db-iso-catalogue-copy.js';
import { copyMasterLibrary } from './db-library-copy.js';
import { ISO_CATALOGUE } from './iso-catalogue.js';

// The ISO catalogue copy (docs/iso/plan.md §4.3, ADR M6-0003) against Postgres under RLS (CI `db` job). Skipped when
// DATABASE_URL is not set.
const url = process.env.DATABASE_URL;

const clauseCount = ISO_CATALOGUE.standards.reduce((n, s) => n + s.clauses.length, 0);
const defCount = ISO_CATALOGUE.standards.reduce(
  (n, s) => n + s.reviewInputs.length + s.reviewOutputs.length,
  0,
);

describe.skipIf(!url)('copying the ISO catalogue into an account', () => {
  let t: TestDatabase;
  let op: r.OperatorDatabase;
  let owner: pg.Client;

  const create = (name: string, email: string) =>
    op.withOperator('iso-copy-test', (tx) =>
      r.platformAccounts.create(tx, {
        name,
        kind: 'ENTERPRISE',
        planCode: 'BUSINESS',
        trialEndsOn: '2099-01-01',
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
        requestId: 'iso-copy-test',
      }),
    );
  const setStatus = (id: Id, status: string) =>
    owner.query('UPDATE firm SET status = $2 WHERE id = $1', [id, status]);
  const setIso = (id: Id, on: boolean) =>
    op.withOperator('iso-copy-test', (tx) =>
      r.accountOverrides.put(tx, id, {
        limits: {},
        features: on ? ['isoManagement'] : [],
        removedFeatures: on ? [] : ['isoManagement'],
        note: null,
      }),
    );
  /** A TRIAL account with the add-on on and, as a real one would, the master library. */
  const isoAccount = async (name: string, email: string) => {
    const { accountId } = await create(name, email);
    await copyMasterLibrary(t.db, accountId, 'evt-master');
    await setStatus(accountId, 'TRIAL');
    await setIso(accountId, true);
    return accountId;
  };
  const inAccount = <T>(id: Id, fn: (tx: r.TenantTx) => Promise<T>) =>
    t.db.withTenant(r.systemContext(id, 'iso-copy-test'), fn);
  const contentOf = (id: Id) =>
    inAccount(id, async (tx) => ({
      standards: await r.isoCatalogue.standards(tx),
      clauses: await r.isoCatalogue.clauses(tx),
      defs: await r.isoCatalogue.reviewDefs(tx),
      acts: await r.acts.findAll(tx, {}),
      categories: await r.categories.findAll(tx, {}),
      obligations: await r.obligations.findAll(tx, {}),
      audit: (await r.auditEvents.query(tx, { limit: 200 })).items,
      copiedAt: await r.account.isoCatalogueCopiedAt(tx),
    }));

  beforeAll(async () => {
    t = await createTestDatabase(url!);
    op = r.createOperatorDatabase({ connectionString: t.url, max: 2 });
    owner = new pg.Client({ connectionString: t.url });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await op?.close();
    await t?.drop();
  });

  it('copies beside the master library and a same-name statutory Act, audits each row, and records the copy', async () => {
    const id = await isoAccount('Kestrel Metals Group', 'asha.rao@kestrel-metals.example');
    // A law that happens to share the STANDARD act's name stays a law; the copy never reuses it.
    const statute = await inAccount(id, (tx) =>
      r.acts.create(tx, {
        name: ISO_CATALOGUE.acts[0]!.name,
        shortName: null,
        jurisdiction: 'CENTRAL',
        stateCode: null,
        aliases: [],
      }),
    );
    const before = await contentOf(id);
    expect(before.copiedAt).toBeNull();

    expect(await copyIsoCatalogue(t.db, id, 'evt-iso')).toEqual({
      copied: true,
      standards: 3,
      clauses: clauseCount,
      reviewDefs: defCount,
      acts: 4,
      categories: 1,
      obligations: 13,
    });

    const after = await contentOf(id);
    expect(after.copiedAt).not.toBeNull();
    expect(after.standards.map((s) => `${s.code} ${s.edition}`)).toEqual([
      'ISO_9001 2015+A1:2024',
      'ISO_14001 2015+A1:2024',
      'ISO_45001 2018+A1:2024',
    ]);
    expect(after.clauses).toHaveLength(clauseCount);
    // Each parent is the clause one level up in the same standard.
    const byId = new Map(after.clauses.map((c) => [c.id, c]));
    for (const c of after.clauses) {
      const parent = c.parentId ? byId.get(c.parentId) : null;
      expect(parent?.number ?? null).toBe(
        c.number.includes('.') ? c.number.slice(0, c.number.lastIndexOf('.')) : null,
      );
      if (parent) expect(parent.standardId).toBe(c.standardId);
    }
    expect(after.clauses.filter((c) => c.exclusionAllowed).map((c) => c.number)).toEqual([
      '7.1.5.2',
      '8.3.1',
      '8.3.2',
      '8.3.3',
      '8.3.4',
      '8.3.5',
      '8.3.6',
      '8.5.3',
      '8.5.5',
    ]);
    expect(after.defs.inputs.length + after.defs.outputs.length).toBe(defCount);

    const standardActs = after.acts.filter((a) => a.kind === 'STANDARD');
    expect(standardActs.map((a) => a.name).sort()).toEqual(
      ISO_CATALOGUE.acts.map((a) => a.name).sort(),
    );
    expect(after.acts.find((a) => a.id === statute.id)).toMatchObject({ kind: 'STATUTE' });
    expect(after.acts).toHaveLength(before.acts.length + 4);
    const category = after.categories.find((c) => c.name === ISO_CATALOGUE.category)!;
    const activities = after.obligations.filter((o) => o.externalRef?.startsWith('ISO-'));
    expect(activities).toHaveLength(13);
    for (const o of activities) {
      expect(standardActs.some((a) => a.id === o.actId)).toBe(true);
      expect(o).toMatchObject({ categoryId: category.id, libraryVersion: ISO_CATALOGUE.version });
      expect((o.clauseRefs ?? []).length).toBeGreaterThan(0);
    }
    // The master library is untouched and its obligations still name statutory acts only.
    expect(after.obligations).toHaveLength(before.obligations.length + 13);

    const audit = after.audit.filter((e) => e.requestId === 'evt-iso');
    expect(audit).toHaveLength(4 + 1 + 13);
    for (const e of audit) {
      expect(e).toMatchObject({
        action: 'CREATE',
        actorKind: 'SYSTEM',
        actorId: null,
        clientId: null,
        before: null,
        reason: 'ISO catalogue version 1',
      });
    }
  });

  it('copies nothing the second time', async () => {
    const id = await isoAccount('Osprey Textiles Group', 'asha.rao@osprey-textiles.example');
    expect((await copyIsoCatalogue(t.db, id, 'evt-1')).copied).toBe(true);
    const once = await contentOf(id);
    expect(await copyIsoCatalogue(t.db, id, 'evt-2')).toEqual({
      copied: false,
      standards: 0,
      clauses: 0,
      reviewDefs: 0,
      acts: 0,
      categories: 0,
      obligations: 0,
    });
    const twice = await contentOf(id);
    expect(twice.clauses).toHaveLength(once.clauses.length);
    expect(twice.obligations).toHaveLength(once.obligations.length);
    expect(twice.audit.filter((e) => e.requestId === 'evt-2')).toEqual([]);
  });

  it('two deliveries at once copy it once', async () => {
    const id = await isoAccount('Kestrel Fibres', 'asha.rao@kestrel-fibres.example');
    const results = await Promise.all([
      copyIsoCatalogue(t.db, id, 'evt-a'),
      copyIsoCatalogue(t.db, id, 'evt-b'),
    ]);
    expect(results.map((x) => x.copied).sort()).toEqual([false, true]);
    expect((await contentOf(id)).standards).toHaveLength(3);
  });

  it('copies nothing without the add-on, or while the account is not TRIAL or ACTIVE', async () => {
    const off = await isoAccount('Kestrel Aluminium', 'asha.rao@kestrel-aluminium.example');
    await setIso(off, false);
    expect((await copyIsoCatalogue(t.db, off, 'evt-off')).copied).toBe(false);
    expect(await contentOf(off)).toMatchObject({ standards: [], copiedAt: null });

    const { accountId: provisioning } = await create('Highmoor Works', 'asha.rao@highmoor.example');
    await setIso(provisioning, true);
    expect((await copyIsoCatalogue(t.db, provisioning, 'evt-prov')).copied).toBe(false);
    expect(await contentOf(provisioning)).toMatchObject({ standards: [], copiedAt: null });

    const suspended = await isoAccount('Stonebridge Mills', 'asha.rao@stonebridge.example');
    await setStatus(suspended, 'SUSPENDED');
    expect((await copyIsoCatalogue(t.db, suspended, 'evt-susp')).copied).toBe(false);
    expect(await contentOf(suspended)).toMatchObject({ standards: [], copiedAt: null });
  });

  it('a failed copy rolls back its mark, so the retry copies', async () => {
    const id = await isoAccount('Riverbend Plant', 'asha.rao@riverbend.example');
    const broken = {
      ...ISO_CATALOGUE,
      // Passes the catalogue check, but the last activity's over-long title fails on write, after the rest.
      activities: ISO_CATALOGUE.activities.map((a, i) =>
        i === 12 ? { ...a, title: 'x'.repeat(1001) } : a,
      ),
    };
    await expect(copyIsoCatalogue(t.db, id, 'evt-fail', broken)).rejects.toThrow();
    expect(await contentOf(id)).toMatchObject({ standards: [], copiedAt: null });
    expect((await copyIsoCatalogue(t.db, id, 'evt-retry')).copied).toBe(true);
  });

  it('reuses a same-name STANDARD act, the category, a standard and an activity already there', async () => {
    const id = await isoAccount('Riverbend Mills', 'asha.rao@riverbend-mills.example');
    const [q] = ISO_CATALOGUE.standards;
    const [act] = ISO_CATALOGUE.acts;
    const activity = ISO_CATALOGUE.activities.find((a) => a.act === act!.key)!;
    const pre = await inAccount(id, async (tx) => {
      await r.isoCatalogue.createStandard(tx, {
        code: q!.code,
        edition: q!.edition,
        title: q!.title,
        topic: q!.topic,
      });
      const standardAct = await r.acts.create(tx, {
        name: act!.name,
        shortName: act!.shortName,
        jurisdiction: 'CENTRAL',
        stateCode: null,
        aliases: [],
        kind: 'STANDARD',
      });
      const category = await r.categories.create(tx, { name: ISO_CATALOGUE.category, aliases: [] });
      const values = Object.fromEntries(
        Object.entries(activity).filter(([k]) => k !== 'key' && k !== 'act'),
      ) as Omit<typeof activity, 'key' | 'act'>;
      await r.obligations.create(tx, {
        ...values,
        actId: standardAct.id,
        categoryId: category.id,
        libraryVersion: 1,
      });
      return { standardAct, category };
    });

    expect(await copyIsoCatalogue(t.db, id, 'evt-reuse')).toMatchObject({
      copied: true,
      standards: 2,
      acts: 3,
      categories: 0,
      obligations: 12,
    });
    const after = await contentOf(id);
    expect(after.standards).toHaveLength(3);
    expect(after.acts.filter((a) => a.kind === 'STANDARD')).toHaveLength(4);
    expect(after.categories.filter((c) => c.name === ISO_CATALOGUE.category)).toEqual([
      expect.objectContaining({ id: pre.category.id }),
    ]);
    expect(after.obligations.filter((o) => o.externalRef === activity.externalRef)).toEqual([
      expect.objectContaining({ actId: pre.standardAct.id }),
    ]);
  });

  it('the master library copy writes no STANDARD row', async () => {
    const { accountId } = await create('Kestrelganj Unit', 'asha.rao@kestrelganj.example');
    await copyMasterLibrary(t.db, accountId, 'evt-master');
    const copy = await contentOf(accountId);
    expect(copy.acts.length).toBeGreaterThan(0);
    expect(copy.acts.filter((a) => a.kind === 'STANDARD')).toEqual([]);
    expect(copy.standards).toEqual([]);
    expect(copy.obligations.filter((o) => (o.clauseRefs ?? []).length > 0)).toEqual([]);
  });
});

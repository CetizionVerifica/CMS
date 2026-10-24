import { randomBytes, randomUUID } from 'node:crypto';
import {
  Account,
  AccountPage,
  ApiErrorResponse,
  OperatorAuditEventPage,
  Plan,
  Renewal,
  Subscription,
  SupportSession,
  UsageSnapshot,
  OperatorSupportGrant,
  type AccountCreateBody,
} from '@canopy/contracts';
import * as r from '@canopy/db';
import { addDays } from '@canopy/engine';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbAccountStore, SecretBox } from '../auth/index.js';
import { buildServer } from '../server.js';
import { operatorToday } from './accounts.js';
import { addOperator } from './db-operators.js';
import { createPlatformTestDatabase, totpAt, type PlatformTestDatabase } from './db-testing.js';

// The operator's account routes on Postgres 16, as canopy_operator (CI `db` job), on the real clock: the database
// checks invite and token expiry against its own. Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;

const KEY = Buffer.alloc(32, 5).toString('base64');
const APP_URL = 'https://app.planetpulse.example';
const PREFIX = '/api/platform/v1';

const error = (res: LightMyRequestResponse) => ApiErrorResponse.parse(res.json()).error;
const z = <T>(schema: { parse(v: unknown): T }, res: LightMyRequestResponse): T => {
  if (res.statusCode >= 300) throw new Error(`${res.statusCode}: ${res.body}`);
  return schema.parse(res.json());
};

describe.skipIf(!url)('the operator account routes', () => {
  let t: PlatformTestDatabase;
  let app: FastifyInstance;
  let cookie: string;
  let csrf: string;
  let operatorId: string;

  const get = (path: string) => app.inject({ url: `${PREFIX}${path}`, headers: { cookie } });
  const send = (
    method: 'POST' | 'PUT' | 'PATCH',
    path: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: `${PREFIX}${path}`,
      headers: { cookie, 'x-csrf-token': csrf, ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const body = (over: Partial<AccountCreateBody> = {}): AccountCreateBody => ({
    name: 'Kestrel Metals Group',
    kind: 'ENTERPRISE',
    planCode: 'BUSINESS',
    legalName: 'Kestrel Metals Group Private Limited',
    owner: {
      displayName: 'Asha Rao',
      email: `asha.${randomBytes(3).toString('hex')}@kestrel.example`,
    },
    ...over,
  });
  const create = async (over: Partial<AccountCreateBody> = {}) =>
    z(Account, await send('POST', '/accounts', body(over)));

  const inAccount = <T>(id: string, fn: (tx: r.TenantTx) => Promise<T>) =>
    t.db.withTenant(r.systemContext(id, 'platform-test'), fn);
  const asOperator = <T>(fn: (tx: r.OperatorTx) => Promise<T>) =>
    t.operatorDb.withOperator('platform-test', fn);

  /** The owner accepts their invite, as M5 does once M6 has copied the library. Returns the owner's id. */
  async function ownerAccepts(accountId: string): Promise<string> {
    return inAccount(accountId, async (tx) => {
      await r.accountJobs.markLibraryCopied(tx);
      const [owner] = await r.people.findAll(tx, {});
      const now = new Date().toISOString();
      const [invite] = await r.invites.openForPerson(tx, owner!.id, now);
      const tokenId = await r.loginTokens.create(tx, {
        personId: owner!.id,
        kind: 'INVITE',
        inviteId: invite!.id,
        tokenHash: randomBytes(32).toString('hex'),
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await r.invites.accept(tx, {
        inviteId: invite!.id,
        tokenId,
        passwordHash: 'scrypt$32768$8$1$salt$owner',
        now,
      });
      return owner!.id;
    });
  }
  // The account's own entries carry no client, so the customer audit routes (always by client) never list them.
  const accountTrail = (id: string) =>
    t.ownerQuery<{
      actorKind: string;
      action: string;
      entityType: string;
      reason: string | null;
      after: unknown;
    }>(
      id,
      `SELECT actor_kind AS "actorKind", action, entity_type AS "entityType", reason, after
         FROM audit_event WHERE firm_id = '${id}' AND entity_type = 'account' ORDER BY at, id`,
    );
  const operatorTrail = (accountId: string) =>
    asOperator(async (tx) => (await r.operatorAudit.query(tx, { accountId })).items);
  const outbox = (id: string) =>
    t.ownerQuery<{ type: string; data: Record<string, unknown> }>(
      id,
      `SELECT type, data FROM domain_event WHERE firm_id = '${id}' ORDER BY occurred_at, id`,
    );

  beforeAll(async () => {
    t = await createPlatformTestDatabase(url!);
    const secrets = new SecretBox(KEY);
    const added = await addOperator(t.operatorDb, secrets, {
      email: 'shyam.ops@planetpulse.example',
      displayName: 'Shyam',
      password: 'operator password, long enough',
    });
    operatorId = added.operator.id;
    app = buildServer({
      accountStore: createDbAccountStore(t.db, {}),
      authSecretKey: KEY,
      platform: { db: t.operatorDb, secrets, appUrl: APP_URL },
    });
    const login = await app.inject({
      method: 'POST',
      url: `${PREFIX}/auth/login`,
      payload: {
        email: 'shyam.ops@planetpulse.example',
        password: 'operator password, long enough',
        code: totpAt(added.otpauthUri, new Date()),
      },
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = `op_sid=${login.cookies.find((c) => c.name === 'op_sid')!.value}`;
    csrf = (login.json() as { csrfToken: string }).csrfToken;
  });

  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  describe('plans', () => {
    it('lists every plan and creates, changes and retires one, in the operator audit', async () => {
      const res = await get('/plans');
      expect(res.statusCode).toBe(200);
      const listed = (res.json() as { items: unknown[] }).items.map((p) => Plan.parse(p));
      expect(listed.map((p) => p.code)).toEqual(
        expect.arrayContaining(['STARTER', 'BUSINESS', 'ENTERPRISE', 'CONSULTANCY']),
      );
      const limits = { companies: 2, units: 10, users: 40, storageBytes: null };
      const created = z(
        Plan,
        await send('PUT', '/plans/GROWTH', {
          name: 'Growth',
          limits,
          features: ['importer'],
          retired: false,
        }),
      );
      expect(created).toEqual({
        code: 'GROWTH',
        name: 'Growth',
        limits,
        features: ['importer'],
        retiredAt: null,
      });
      const retired = z(
        Plan,
        await send('PUT', '/plans/GROWTH', { name: 'Growth', limits, features: [], retired: true }),
      );
      expect(retired.retiredAt).not.toBeNull();
      const entries = await asOperator(
        async (tx) => (await r.operatorAudit.query(tx, { action: 'PLAN_CHANGE' })).items,
      );
      expect(entries).toHaveLength(2);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operatorId,
            accountId: null,
            before: null,
            after: { plan: created },
          }),
          expect.objectContaining({ operatorId, accountId: null, before: { plan: created } }),
        ]),
      );
    });
  });

  describe('provisioning', () => {
    it('creates a PROVISIONING account with a 30-day trial, its client, and the owner invited', async () => {
      const account = await create();
      expect(account).toMatchObject({
        name: 'Kestrel Metals Group',
        kind: 'ENTERPRISE',
        status: 'PROVISIONING',
        planCode: 'BUSINESS',
        trialEndsOn: addDays(operatorToday(new Date()), 30),
        profile: {
          legalName: 'Kestrel Metals Group Private Limited',
          gstin: null,
          timeZone: 'Asia/Kolkata',
          fyStartMonth: 4,
        },
        entitlements: { planCode: 'BUSINESS', limits: { companies: 5, units: 25, users: 150 } },
        onboardedAt: null,
        deletionRequestedAt: null,
        purgeAfter: null,
        version: 1,
      });
      expect(account.libraryCopiedAt).toBeNull();
      const clients = await inAccount(account.id, (tx) => r.clients.findAll(tx, {}));
      expect(clients.map((c) => c.name)).toEqual(['Kestrel Metals Group']);
      expect((await outbox(account.id)).map((e) => e.type)).toEqual(
        expect.arrayContaining(['account.created', 'person.invited']),
      );
      const trail = await operatorTrail(account.id);
      expect(trail.map((e) => e.action).sort()).toEqual(['ACCOUNT_CREATE', 'OWNER_INVITE_SEND']);
      // Account fields only: the owner's name and email never reach the operator's trail.
      expect(JSON.stringify(trail)).not.toMatch(/Asha|kestrel\.example/);
      expect(await accountTrail(account.id)).toEqual([
        expect.objectContaining({ actorKind: 'OPERATOR', action: 'CREATE', entityType: 'account' }),
      ]);
    });

    it('opens ACTIVE at once with activeNow, names the client, and takes a consultancy without one', async () => {
      const active = await create({ activeNow: true, clientName: 'Kestrel Aluminium' });
      expect(active.trialEndsOn).toBeNull();
      const clients = await inAccount(active.id, (tx) => r.clients.findAll(tx, {}));
      expect(clients.map((c) => c.name)).toEqual(['Kestrel Aluminium']);
      const firm = await create({
        name: 'Osprey Advisory',
        kind: 'CONSULTANCY',
        planCode: 'CONSULTANCY',
      });
      expect(await inAccount(firm.id, (tx) => r.clients.findAll(tx, {}))).toEqual([]);
    });

    it('refuses an unknown or retired plan, and a consultancy with a client name', async () => {
      expect(error(await send('POST', '/accounts', body({ planCode: 'NOPE' }))).code).toBe(
        'VALIDATION',
      );
      expect(error(await send('POST', '/accounts', body({ planCode: 'GROWTH' })))).toMatchObject({
        code: 'VALIDATION',
        details: { issues: [{ path: ['body', 'planCode'], message: 'This plan is retired' }] },
      });
      expect(
        error(await send('POST', '/accounts', body({ kind: 'CONSULTANCY', clientName: 'X Group' })))
          .code,
      ).toBe('VALIDATION');
    });

    it('provisions once per Idempotency-Key', async () => {
      const key = randomUUID();
      const payload = body({ name: 'Riverbend Works' });
      const first = z(
        Account,
        await send('POST', '/accounts', payload, { 'idempotency-key': key }),
      );
      const again = z(
        Account,
        await send('POST', '/accounts', payload, { 'idempotency-key': key }),
      );
      expect(again.id).toBe(first.id);
      const named = await asOperator((tx) => r.platformAccounts.list(tx));
      expect(named.filter((a) => a.name === 'Riverbend Works')).toHaveLength(1);
      expect(
        error(
          await send(
            'POST',
            '/accounts',
            { ...payload, name: 'Other' },
            { 'idempotency-key': key },
          ),
        ).code,
      ).toBe('VALIDATION');
    });
    it('provisions once for two concurrent posts with the same Idempotency-Key (a double click)', async () => {
      const key = randomUUID();
      const payload = body({ name: 'Stonebridge Works' });
      const [one, two] = await Promise.all([
        send('POST', '/accounts', payload, { 'idempotency-key': key }),
        send('POST', '/accounts', payload, { 'idempotency-key': key }),
      ]);
      expect(z(Account, two).id).toBe(z(Account, one).id);
      const named = await asOperator((tx) => r.platformAccounts.list(tx));
      expect(named.filter((a) => a.name === 'Stonebridge Works')).toHaveLength(1);
    });
  });

  describe('reading and editing', () => {
    it('lists newest first, filters, searches and pages', async () => {
      const page = z(AccountPage, await get('/accounts?limit=2&count=true'));
      expect(page.items).toHaveLength(2);
      expect(page.total).toBeGreaterThanOrEqual(4);
      expect(Date.parse(page.items[0]!.createdAt)).toBeGreaterThanOrEqual(
        Date.parse(page.items[1]!.createdAt),
      );
      const next = z(AccountPage, await get(`/accounts?limit=2&cursor=${page.nextCursor}`));
      expect(next.items.map((a) => a.id)).not.toContain(page.items[0]!.id);
      const consultancies = z(AccountPage, await get('/accounts?kind=CONSULTANCY'));
      expect(consultancies.items.every((a) => a.kind === 'CONSULTANCY')).toBe(true);
      const found = z(AccountPage, await get('/accounts?q=riverbend'));
      expect(found.items.map((a) => a.name)).toEqual(['Riverbend Works']);
      const provisioning = z(AccountPage, await get('/accounts?status=PROVISIONING'));
      expect(provisioning.items.every((a) => a.status === 'PROVISIONING')).toBe(true);
    });

    it('reads one account, and 404 for an unknown one', async () => {
      const account = await create({ name: 'Stonebridge Mills' });
      expect(z(Account, await get(`/accounts/${account.id}`))).toEqual(account);
      expect(error(await get(`/accounts/${randomUUID()}`)).code).toBe('NOT_FOUND');
    });

    it('changes the name and profile at the right version, in both trails', async () => {
      const account = await create({ name: 'Highmoor Textiles' });
      const stale = await send('PATCH', `/accounts/${account.id}`, {
        version: 9,
        name: 'Highmoor',
      });
      expect(error(stale)).toMatchObject({ code: 'STALE_VERSION', details: { currentVersion: 1 } });
      const changed = z(
        Account,
        await send('PATCH', `/accounts/${account.id}`, {
          version: 1,
          name: 'Highmoor Textiles Group',
          profile: { gstin: '27AAPFU0939F1ZV' },
        }),
      );
      expect(changed).toMatchObject({
        name: 'Highmoor Textiles Group',
        version: 2,
        profile: { legalName: 'Kestrel Metals Group Private Limited', gstin: '27AAPFU0939F1ZV' },
      });
      expect((await operatorTrail(account.id)).map((e) => e.action)).toContain('ACCOUNT_UPDATE');
      expect((await accountTrail(account.id)).map((e) => e.action)).toContain('UPDATE');
    });
  });

  describe('the account lifecycle', () => {
    it('moves a trial through conversion, suspension and resumption, with reasons and events', async () => {
      const account = await create({ name: 'Kestrel Fibres' });
      const early = await send('POST', `/accounts/${account.id}/status`, {
        version: 1,
        to: 'SUSPENDED',
        reason: 'Unpaid invoice',
      });
      expect(error(early)).toMatchObject({
        code: 'INVALID_TRANSITION',
        details: { from: 'PROVISIONING', to: 'SUSPENDED' },
      });
      await ownerAccepts(account.id);
      let current = z(Account, await get(`/accounts/${account.id}`));
      expect(current.status).toBe('TRIAL');
      expect(current.libraryCopiedAt).not.toBeNull();

      const blank = await send('POST', `/accounts/${account.id}/status`, {
        version: current.version,
        to: 'ACTIVE',
        reason: '   ',
      });
      expect([blank.statusCode, error(blank).code]).toEqual([400, 'VALIDATION']);
      current = z(
        Account,
        await send('POST', `/accounts/${account.id}/status`, {
          version: current.version,
          to: 'ACTIVE',
          reason: 'Paid for a year',
        }),
      );
      expect(current).toMatchObject({ status: 'ACTIVE', trialEndsOn: null });
      current = z(
        Account,
        await send('POST', `/accounts/${account.id}/status`, {
          version: current.version,
          to: 'SUSPENDED',
          reason: 'Unpaid invoice',
        }),
      );
      expect(current.status).toBe('SUSPENDED');
      current = z(
        Account,
        await send('POST', `/accounts/${account.id}/status`, {
          version: current.version,
          to: 'ACTIVE',
          reason: 'Invoice paid',
        }),
      );
      expect(current.status).toBe('ACTIVE');

      const actions = (await operatorTrail(account.id)).map((e) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining(['TRIAL_CONVERT', 'ACCOUNT_SUSPEND', 'ACCOUNT_RESUME']),
      );
      const suspended = (await accountTrail(account.id)).find(
        (e) => e.action === 'TRANSITION' && e.reason === 'Unpaid invoice',
      );
      expect(suspended).toMatchObject({ actorKind: 'OPERATOR', after: { status: 'SUSPENDED' } });
      const moves = (await outbox(account.id))
        .filter((e) => e.type === 'account.status_changed')
        .map((e) => `${e.data.from}>${e.data.to}`);
      expect(moves).toEqual([
        'PROVISIONING>TRIAL',
        'TRIAL>ACTIVE',
        'ACTIVE>SUSPENDED',
        'SUSPENDED>ACTIVE',
      ]);
    });

    it('extends a trial only while it is a trial, never into the past', async () => {
      const account = await create({ name: 'Riverbend Mills' });
      await ownerAccepts(account.id);
      const trial = z(Account, await get(`/accounts/${account.id}`));
      const later = addDays(operatorToday(new Date()), 45);
      const extended = z(
        Account,
        await send('POST', `/accounts/${account.id}/trial`, {
          version: trial.version,
          trialEndsOn: later,
          reason: 'Board meets next month',
        }),
      );
      expect(extended).toMatchObject({ status: 'TRIAL', trialEndsOn: later });
      const past = await send('POST', `/accounts/${account.id}/trial`, {
        version: extended.version,
        trialEndsOn: addDays(operatorToday(new Date()), -1),
      });
      expect(error(past).code).toBe('VALIDATION');
      const active = z(
        Account,
        await send('POST', `/accounts/${account.id}/status`, {
          version: extended.version,
          to: 'ACTIVE',
          reason: 'Paid',
        }),
      );
      const refused = await send('POST', `/accounts/${account.id}/trial`, {
        version: active.version,
        trialEndsOn: later,
      });
      expect(error(refused)).toMatchObject({
        code: 'INVALID_TRANSITION',
        details: { from: 'ACTIVE' },
      });
      expect((await operatorTrail(account.id)).map((e) => e.action)).toContain('TRIAL_EXTEND');
    });

    it('changes the plan with a reason, and overrides limits, each bumping the version', async () => {
      const account = await create({ name: 'Osprey Textiles Group' });
      const same = await send('POST', `/accounts/${account.id}/plan`, {
        version: 1,
        planCode: 'BUSINESS',
        reason: 'No change',
      });
      expect(error(same).code).toBe('VALIDATION');
      const moved = z(
        Account,
        await send('POST', `/accounts/${account.id}/plan`, {
          version: 1,
          planCode: 'ENTERPRISE',
          reason: 'Signed the enterprise order',
        }),
      );
      expect(moved).toMatchObject({
        planCode: 'ENTERPRISE',
        version: 2,
        entitlements: { limits: { companies: null, users: null } },
      });
      const event = (await outbox(account.id)).find((e) => e.type === 'account.plan_changed');
      expect(event?.data).toEqual({ accountId: account.id, from: 'BUSINESS', to: 'ENTERPRISE' });

      const overridden = z(
        Account,
        await send('PUT', `/accounts/${account.id}/override`, {
          version: 2,
          override: { limits: { users: 300 }, features: ['earlyAccess'], note: 'Pilot' },
          reason: 'Pilot for the group',
        }),
      );
      expect(overridden).toMatchObject({
        version: 3,
        entitlements: { limits: { users: 300 }, features: ['earlyAccess'] },
      });
      const blank = await send('PUT', `/accounts/${account.id}/override`, {
        version: 3,
        override: { limits: {}, features: [], note: null },
        reason: '',
      });
      expect([blank.statusCode, error(blank).code]).toEqual([400, 'VALIDATION']);
      const actions = (await operatorTrail(account.id)).map((e) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['PLAN_CHANGE', 'OVERRIDE_CHANGE']));
    });

    it("resends the owner's invite while PROVISIONING only", async () => {
      const account = await create({ name: 'Kestrelganj Foundry' });
      const res = await send('POST', `/accounts/${account.id}/owner-invite`);
      expect(res.statusCode).toBe(202);
      const invites = (await outbox(account.id)).filter((e) => e.type === 'person.invited');
      expect(invites).toHaveLength(2);
      expect(
        (await operatorTrail(account.id)).filter((e) => e.action === 'OWNER_INVITE_SEND'),
      ).toHaveLength(2);
      await ownerAccepts(account.id);
      const late = await send('POST', `/accounts/${account.id}/owner-invite`);
      expect([late.statusCode, error(late)]).toEqual([
        409,
        expect.objectContaining({
          code: 'INVALID_TRANSITION',
          details: { from: 'TRIAL', to: 'PROVISIONING' },
        }),
      ]);
    });

    it('records onboarding once', async () => {
      const account = await create({ name: 'Stonebridge Advisory' });
      const done = z(
        Account,
        await send('POST', `/accounts/${account.id}/onboarded`, { version: 1 }),
      );
      expect(done.onboardedAt).not.toBeNull();
      const again = z(
        Account,
        await send('POST', `/accounts/${account.id}/onboarded`, { version: 2 }),
      );
      expect(again).toEqual(done);
      expect(
        error(await send('POST', `/accounts/${account.id}/onboarded`, { version: 1 })).code,
      ).toBe('STALE_VERSION');
    });

    it('starts and cancels a deletion with the typed name, and shows when it would purge', async () => {
      const account = await create({ name: 'Highmoor Works', activeNow: true });
      await ownerAccepts(account.id);
      const active = z(Account, await get(`/accounts/${account.id}`));
      expect(active.status).toBe('ACTIVE');
      const wrong = await send('POST', `/accounts/${account.id}/deletion`, {
        version: active.version,
        reason: 'Contract ended',
        confirmName: 'highmoor works',
      });
      expect(error(wrong).code).toBe('VALIDATION');
      const pending = z(
        Account,
        await send('POST', `/accounts/${account.id}/deletion`, {
          version: active.version,
          reason: 'Contract ended',
          confirmName: 'Highmoor Works',
        }),
      );
      expect(pending.status).toBe('PENDING_DELETION');
      expect(Date.parse(pending.purgeAfter!) - Date.parse(pending.deletionRequestedAt!)).toBe(
        30 * 86_400_000,
      );
      const twice = await send('POST', `/accounts/${account.id}/deletion`, {
        version: pending.version,
        reason: 'Again',
        confirmName: 'Highmoor Works',
      });
      expect(error(twice).code).toBe('INVALID_TRANSITION');
      const back = z(
        Account,
        await send('POST', `/accounts/${account.id}/deletion/cancel`, {
          version: pending.version,
          reason: 'Renewed after all',
        }),
      );
      expect(back).toMatchObject({ status: 'ACTIVE', deletionRequestedAt: null, purgeAfter: null });
      const notPending = await send('POST', `/accounts/${account.id}/deletion/cancel`, {
        version: back.version,
        reason: 'Again',
      });
      expect(error(notPending).code).toBe('INVALID_TRANSITION');
      const actions = (await operatorTrail(account.id)).map((e) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining(['ACCOUNT_DELETE_REQUEST', 'ACCOUNT_DELETE_CANCEL']),
      );
    });

    it('refuses to delete a trial', async () => {
      const account = await create({ name: 'Riverbend Advisory' });
      await ownerAccepts(account.id);
      const trial = z(Account, await get(`/accounts/${account.id}`));
      const res = await send('POST', `/accounts/${account.id}/deletion`, {
        version: trial.version,
        reason: 'Did not convert',
        confirmName: 'Riverbend Advisory',
      });
      expect(error(res)).toMatchObject({
        code: 'INVALID_TRANSITION',
        details: { from: 'TRIAL', to: 'PENDING_DELETION' },
      });
    });
  });

  describe('billing, usage and renewals', () => {
    let accountId: string;

    beforeAll(async () => {
      accountId = (await create({ name: 'Kestrel Billing Test', activeNow: true })).id;
    });

    it('records billing periods once per key, newest first, in the operator audit', async () => {
      const today = operatorToday(new Date());
      const period = {
        planCode: 'BUSINESS',
        startsOn: addDays(today, -365),
        endsOn: addDays(today, 10),
        amountPaise: 12_000_000,
        invoiceNumber: 'PP-2026-001',
        paidOn: addDays(today, -360),
      };
      const key = randomUUID();
      const first = z(
        Subscription,
        await send('POST', `/accounts/${accountId}/subscriptions`, period, {
          'idempotency-key': key,
        }),
      );
      const again = z(
        Subscription,
        await send('POST', `/accounts/${accountId}/subscriptions`, period, {
          'idempotency-key': key,
        }),
      );
      expect(again.id).toBe(first.id);
      expect(first).toMatchObject({ accountId, recordedById: operatorId, amountPaise: 12_000_000 });
      const older = z(
        Subscription,
        await send('POST', `/accounts/${accountId}/subscriptions`, {
          ...period,
          startsOn: addDays(today, -730),
          endsOn: addDays(today, -366),
          invoiceNumber: null,
          paidOn: null,
        }),
      );
      const listed = (await get(`/accounts/${accountId}/subscriptions`)).json() as {
        items: unknown[];
      };
      expect(listed.items.map((s) => Subscription.parse(s).id)).toEqual([first.id, older.id]);
      expect(
        error(
          await send('POST', `/accounts/${accountId}/subscriptions`, {
            ...period,
            planCode: 'NOPE',
          }),
        ).code,
      ).toBe('VALIDATION');
      expect(
        (await operatorTrail(accountId)).filter((e) => e.action === 'SUBSCRIPTION_RECORD'),
      ).toHaveLength(2);
      expect(error(await get(`/accounts/${randomUUID()}/subscriptions`)).code).toBe('NOT_FOUND');
    });

    it('lists usage snapshots between two dates', async () => {
      const today = operatorToday(new Date());
      await inAccount(accountId, (tx) => r.accountJobs.takeUsageSnapshot(tx, today));
      const res = await get(`/accounts/${accountId}/usage?from=${addDays(today, -7)}&to=${today}`);
      const items = (res.json() as { items: unknown[] }).items.map((s) => UsageSnapshot.parse(s));
      expect(items).toEqual([expect.objectContaining({ accountId, takenOn: today })]);
      expect(
        error(await get(`/accounts/${accountId}/usage?from=${today}&to=${addDays(today, -1)}`))
          .code,
      ).toBe('VALIDATION');
    });

    it('lists subscriptions and trials ending within the window', async () => {
      const trial = await create({
        name: 'Osprey Renewal Test',
        trialEndsOn: addDays(operatorToday(new Date()), 5),
      });
      await ownerAccepts(trial.id);
      const res = await get('/renewals?withinDays=12');
      const items = (res.json() as { items: unknown[] }).items.map((x) => Renewal.parse(x));
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ accountId: trial.id, kind: 'TRIAL' }),
          expect.objectContaining({ accountId, kind: 'SUBSCRIPTION' }),
        ]),
      );
      const near = (await get('/renewals?withinDays=7')).json() as {
        items: { accountId: string }[];
      };
      expect(near.items.map((x) => x.accountId)).toContain(trial.id);
      expect(near.items.map((x) => x.accountId)).not.toContain(accountId);
    });
  });

  describe('support access', () => {
    it("lists an account's grants and opens the customer app for a live one only", async () => {
      const account = await create({ name: 'Kestrel Support Test', activeNow: true });
      const ownerId = await ownerAccepts(account.id);
      const { grant } = await inAccount(account.id, (tx) =>
        r.supportGrants.create(tx, {
          level: 'ADMIN',
          days: 7,
          grantedById: ownerId,
          now: new Date().toISOString(),
        }),
      );
      const grants = (
        (await get(`/accounts/${account.id}/support-grants`)).json() as {
          items: unknown[];
        }
      ).items.map((g) => OperatorSupportGrant.parse(g));
      expect(grants).toEqual([
        expect.objectContaining({ id: grant.id, status: 'ACTIVE', level: 'ADMIN' }),
      ]);

      const opened = z(SupportSession, await send('POST', `/support-grants/${grant.id}/sessions`));
      expect(opened.url).toMatch(
        /^https:\/\/app\.planetpulse\.example\/support\/start#token=[\w-]{40,}$/,
      );
      expect(Date.parse(opened.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
      const token = opened.url.split('#token=')[1]!;
      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/support/verify',
        payload: { token },
      });
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json()).toMatchObject({ person: { support: true } });
      // One-time: the same token opens nothing twice.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/support/verify',
            payload: { token },
          })
        ).statusCode,
      ).toBe(401);
      expect((await operatorTrail(account.id)).map((e) => e.action)).toContain(
        'SUPPORT_ACCESS_START',
      );
      // The customer's own trail shows the support person signing in (M5 writes it with the session).
      const logins = await t.ownerQuery<{ actorId: string; after: unknown }>(
        account.id,
        `SELECT actor_id AS "actorId", after FROM audit_event
           WHERE firm_id = '${account.id}' AND action = 'LOGIN' AND actor_kind = 'PERSON'`,
      );
      expect(logins).toContainEqual({
        actorId: grant.supportPersonId,
        after: { method: 'SUPPORT' },
      });

      await inAccount(account.id, (tx) =>
        r.supportGrants.revoke(tx, grant.id, ownerId, new Date().toISOString()),
      );
      const ended = await send('POST', `/support-grants/${grant.id}/sessions`);
      expect(error(ended)).toMatchObject({
        code: 'ACCESS_EXPIRED',
        details: { expiredAt: expect.any(String) },
      });
      expect(error(await send('POST', `/support-grants/${randomUUID()}/sessions`)).code).toBe(
        'NOT_FOUND',
      );
      expect(error(await get(`/accounts/${randomUUID()}/support-grants`)).code).toBe('NOT_FOUND');
    });

    it('answers ACCOUNT_SUSPENDED, not a bare 400, for a live grant on a paused account', async () => {
      const account = await create({ name: 'Osprey Paused Test', activeNow: true });
      const ownerId = await ownerAccepts(account.id);
      const { grant } = await inAccount(account.id, (tx) =>
        r.supportGrants.create(tx, {
          level: 'READ_ONLY',
          days: 2,
          grantedById: ownerId,
          now: new Date().toISOString(),
        }),
      );
      const current = z(Account, await get(`/accounts/${account.id}`));
      z(
        Account,
        await send('POST', `/accounts/${account.id}/status`, {
          version: current.version,
          to: 'SUSPENDED',
          reason: 'Unpaid invoice',
        }),
      );
      const paused = await send('POST', `/support-grants/${grant.id}/sessions`);
      expect([paused.statusCode, error(paused)]).toEqual([
        403,
        expect.objectContaining({ code: 'ACCOUNT_SUSPENDED', details: { status: 'SUSPENDED' } }),
      ]);
      const starts = (await operatorTrail(account.id)).filter(
        (e) => e.action === 'SUPPORT_ACCESS_START' && e.operatorId !== null,
      );
      expect(starts).toEqual([]);
    });
  });

  describe('the operator audit', () => {
    it('lists newest first, by account and action, a page at a time', async () => {
      const account = await create({ name: 'Highmoor Audit Test' });
      const forAccount = z(OperatorAuditEventPage, await get(`/audit?accountId=${account.id}`));
      expect(forAccount.items.map((e) => e.action).sort()).toEqual([
        'ACCOUNT_CREATE',
        'OWNER_INVITE_SEND',
      ]);
      const logins = z(OperatorAuditEventPage, await get('/audit?action=OPERATOR_LOGIN'));
      expect(logins.items).toHaveLength(1);
      const first = z(OperatorAuditEventPage, await get('/audit?limit=2'));
      const second = z(
        OperatorAuditEventPage,
        await get(`/audit?limit=2&cursor=${first.nextCursor}`),
      );
      expect(second.items[0]!.id < first.items[1]!.id).toBe(true);
    });

    it('needs the operator session for every route but sign-in', async () => {
      for (const path of ['/plans', '/accounts', '/renewals', '/audit']) {
        expect((await app.inject({ url: `${PREFIX}${path}` })).statusCode).toBe(401);
      }
      const noCsrf = await app.inject({
        method: 'POST',
        url: `${PREFIX}/accounts`,
        headers: { cookie },
        payload: body(),
      });
      expect(error(noCsrf).code).toBe('FORBIDDEN');
    });
  });
});

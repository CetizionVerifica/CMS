import { randomBytes, randomUUID } from 'node:crypto';
import {
  Account,
  AccountView,
  ApiErrorResponse,
  SupportGrant,
  type AccountCreateBody,
} from '@canopy/contracts';
import * as r from '@canopy/db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbAccountStore, hashToken, SecretBox } from '../auth/index.js';
import { buildServer } from '../server.js';
import { addOperator } from './db-operators.js';
import { createPlatformTestDatabase, totpAt, type PlatformTestDatabase } from './db-testing.js';

// The customer's own account routes on Postgres 16 as canopy_app (CI `db` job): GET /account and support access, for
// account admins only, never for a support session. Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;

const KEY = Buffer.alloc(32, 7).toString('base64');
const OPS = '/api/platform/v1';

const error = (res: LightMyRequestResponse) => ApiErrorResponse.parse(res.json()).error;
const z = <T>(schema: { parse(v: unknown): T }, res: LightMyRequestResponse): T => {
  if (res.statusCode >= 300) throw new Error(`${res.statusCode}: ${res.body}`);
  return schema.parse(res.json());
};

interface Caller {
  cookie: string;
  csrf: string;
}

describe.skipIf(!url)('the customer account routes', () => {
  let t: PlatformTestDatabase;
  let app: FastifyInstance;
  let op: Caller;
  let accountId: string;
  let ownerId: string;
  let owner: Caller;
  let consultant: Caller;
  let otherOwner: Caller;
  let otherAccountId: string;

  const inAccount = <T>(id: string, fn: (tx: r.TenantTx) => Promise<T>) =>
    t.db.withTenant(r.systemContext(id, 'customer-test'), fn);

  const get = (who: Caller, path: string) =>
    app.inject({ url: `/api/v1${path}`, headers: { cookie: who.cookie } });
  const post = (
    who: Caller,
    path: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/v1${path}`,
      headers: { cookie: who.cookie, 'x-csrf-token': who.csrf, ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  /** A signed-in session for `personId`, MFA done, as M5 stores it. */
  async function sessionFor(firmId: string, personId: string, grantId?: string): Promise<Caller> {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    await inAccount(firmId, (tx) =>
      r.sessions.create(tx, {
        personId,
        tokenHash: hashToken(token),
        csrfToken: csrf,
        mfaSatisfied: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
        method: grantId ? 'SUPPORT' : 'PASSWORD',
        ...(grantId ? { supportGrantId: grantId } : {}),
      }),
    );
    return { cookie: `sid=${token}`, csrf };
  }

  /** The operator provisions an account and its owner accepts. Returns the account and owner ids. */
  async function provision(name: string): Promise<{ accountId: string; ownerId: string }> {
    const body: AccountCreateBody = {
      name,
      kind: 'ENTERPRISE',
      planCode: 'BUSINESS',
      legalName: `${name} Private Limited`,
      activeNow: true,
      owner: {
        displayName: 'Asha Rao',
        email: `asha.${randomBytes(3).toString('hex')}@kestrel.example`,
      },
    };
    const created = z(
      Account,
      await app.inject({
        method: 'POST',
        url: `${OPS}/accounts`,
        headers: { cookie: op.cookie, 'x-csrf-token': op.csrf },
        payload: body,
      }),
    );
    const id = await inAccount(created.id, async (tx) => {
      await r.accountJobs.markLibraryCopied(tx);
      const [person] = await r.people.findAll(tx, {});
      const now = new Date().toISOString();
      const [invite] = await r.invites.openForPerson(tx, person!.id, now);
      const tokenId = await r.loginTokens.create(tx, {
        personId: person!.id,
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
      return person!.id;
    });
    return { accountId: created.id, ownerId: id };
  }

  /** The support-access entries in the account's trail, oldest first, read as the whole firm. */
  const auditOf = async (id: string) => {
    const { items } = await inAccount(id, (tx) =>
      r.auditEvents.query(tx, {
        entityType: 'membership',
        action: ['MEMBERSHIP_CHANGE'],
        limit: 200,
      }),
    );
    return items
      .filter((e) => e.reason?.startsWith('Support access') || e.reason?.startsWith('Replaced'))
      .reverse()
      .map((e) => ({
        actorId: e.actorId,
        clientId: e.clientId,
        before: e.before,
        after: e.after,
        reason: e.reason,
      }));
  };
  const eventsOf = (id: string) =>
    t.ownerQuery<{ type: string; actor: unknown; data: Record<string, unknown> }>(
      id,
      `SELECT type, actor, data FROM domain_event
         WHERE firm_id = '${id}' AND type LIKE 'support_access.%' ORDER BY occurred_at, id`,
    );

  beforeAll(async () => {
    t = await createPlatformTestDatabase(url!);
    const secrets = new SecretBox(KEY);
    const added = await addOperator(t.operatorDb, secrets, {
      email: 'ops@planetpulse.example',
      displayName: 'Operator',
      password: 'operator password, long enough',
    });
    app = buildServer({
      accountStore: createDbAccountStore(t.db, {}),
      authSecretKey: KEY,
      database: t.db,
      platform: { db: t.operatorDb, secrets, appUrl: 'https://app.planetpulse.example' },
    });
    const login = await app.inject({
      method: 'POST',
      url: `${OPS}/auth/login`,
      payload: {
        email: 'ops@planetpulse.example',
        password: 'operator password, long enough',
        code: totpAt(added.otpauthUri, new Date()),
      },
    });
    expect(login.statusCode, login.body).toBe(200);
    op = {
      cookie: `op_sid=${login.cookies.find((c) => c.name === 'op_sid')!.value}`,
      csrf: (login.json() as { csrfToken: string }).csrfToken,
    };

    ({ accountId, ownerId } = await provision('Kestrel Metals Group'));
    owner = await sessionFor(accountId, ownerId);
    const consultantId = await inAccount(accountId, async (tx) => {
      const person = await r.people.create(tx, {
        displayName: 'Ravi Menon',
        nameNormalized: 'ravi menon',
        email: 'ravi@kestrel.example',
        status: 'ACTIVE',
      });
      await r.memberships.create(tx, {
        personId: person.id,
        role: 'CONSULTANT',
        clientId: null,
        consultantClientIds: [],
        unitIds: null,
        expiresAt: null,
      });
      return person.id;
    });
    consultant = await sessionFor(accountId, consultantId);
    const other = await provision('Osprey Textiles Group');
    otherAccountId = other.accountId;
    otherOwner = await sessionFor(other.accountId, other.ownerId);
  });

  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it("shows the account admin the account's plan, limits and usage, and no one else", async () => {
    const view = z(AccountView, await get(owner, '/account'));
    expect(view).toMatchObject({ id: accountId, name: 'Kestrel Metals Group', status: 'ACTIVE' });
    expect(view.usage.users).toBeGreaterThanOrEqual(2);
    expect(error(await get(consultant, '/account')).code).toBe('FORBIDDEN');
    expect((await app.inject({ url: '/api/v1/account' })).statusCode).toBe(401);
    // Each admin sees their own account only.
    expect(z(AccountView, await get(otherOwner, '/account')).id).toBe(otherAccountId);
  });

  it('grants support access for 7 days by default, ending the live grant, with audit and events', async () => {
    const first = await post(owner, '/account/support-grants', { level: 'READ_ONLY', days: 2 });
    expect(first.statusCode, first.body).toBe(201);
    const a = SupportGrant.parse(first.json());
    expect(a).toMatchObject({ level: 'READ_ONLY', status: 'ACTIVE', grantedById: ownerId });
    expect(Date.parse(a.endsAt) - Date.parse(a.startsAt)).toBe(2 * 86_400_000);

    const b = z(SupportGrant, await post(owner, '/account/support-grants', { level: 'ADMIN' }));
    expect(Date.parse(b.endsAt) - Date.parse(b.startsAt)).toBe(7 * 86_400_000);
    const listed = (
      (await get(owner, '/account/support-grants')).json() as { items: unknown[] }
    ).items.map((g) => SupportGrant.parse(g));
    expect(listed.slice(0, 2).map((g) => [g.id, g.status])).toEqual([
      [b.id, 'ACTIVE'],
      [a.id, 'REVOKED'],
    ]);

    // One entry per membership, in its client: READ_ONLY is a VIEWER per client, ADMIN one firm-wide FIRM_ADMIN.
    const clientIds = await inAccount(accountId, async (tx) =>
      (await r.clients.list(tx)).items.map((c) => c.id),
    );
    const trail = await auditOf(accountId);
    expect(trail).toEqual([
      ...clientIds.map((clientId) => ({
        actorId: ownerId,
        clientId,
        before: null,
        after: { role: 'VIEWER', expiresAt: a.endsAt, supportGrantId: a.id, level: 'READ_ONLY' },
        reason: 'Support access granted',
      })),
      ...clientIds.map((clientId) => ({
        actorId: ownerId,
        clientId,
        before: { expiresAt: a.endsAt },
        after: { expiresAt: expect.any(String), supportGrantId: a.id },
        reason: 'Replaced by a new support grant',
      })),
      {
        actorId: ownerId,
        clientId: null,
        before: null,
        after: { role: 'FIRM_ADMIN', expiresAt: b.endsAt, supportGrantId: b.id, level: 'ADMIN' },
        reason: 'Support access granted',
      },
    ]);
    expect(clientIds.length).toBeGreaterThan(0);
    expect((await eventsOf(accountId)).map((e) => [e.type, e.data.grantId])).toEqual([
      ['support_access.granted', a.id],
      ['support_access.revoked', a.id],
      ['support_access.granted', b.id],
    ]);
    expect((await eventsOf(accountId))[0]!.actor).toEqual({ kind: 'PERSON', personId: ownerId });
    // Nothing of this reaches the other account.
    expect(await auditOf(otherAccountId)).toEqual([]);
    expect(
      ((await get(otherOwner, '/account/support-grants')).json() as { items: unknown[] }).items,
    ).toEqual([]);
  });

  it('refuses days outside 1 to 30, people who are not account admins, and the support person', async () => {
    for (const days of [0, 31]) {
      expect(
        error(await post(owner, '/account/support-grants', { level: 'ADMIN', days })).code,
      ).toBe('VALIDATION');
    }
    expect(error(await post(consultant, '/account/support-grants', { level: 'ADMIN' })).code).toBe(
      'FORBIDDEN',
    );
    expect(error(await get(consultant, '/account/support-grants')).code).toBe('FORBIDDEN');

    // An ADMIN support session holds FIRM_ADMIN, yet cannot see, extend or end support access.
    const live = (await inAccount(accountId, (tx) =>
      r.supportGrants.live(tx, new Date().toISOString()),
    ))!;
    expect(live.level).toBe('ADMIN');
    const support = await sessionFor(accountId, live.supportPersonId, live.id);
    expect(z(AccountView, await get(support, '/account')).id).toBe(accountId);
    expect(error(await get(support, '/account/support-grants')).code).toBe('FORBIDDEN');
    expect(
      error(await post(support, '/account/support-grants', { level: 'ADMIN', days: 30 })).code,
    ).toBe('FORBIDDEN');
    expect(error(await post(support, `/account/support-grants/${live.id}/revoke`)).code).toBe(
      'FORBIDDEN',
    );
    expect(
      (await inAccount(accountId, (tx) => r.supportGrants.live(tx, new Date().toISOString())))!.id,
    ).toBe(live.id);
  });

  it('refuses every role but the account admin', async () => {
    const [clientId] = await inAccount(accountId, async (tx) =>
      (await r.clients.list(tx)).items.map((c) => c.id),
    );
    for (const role of ['CLIENT_ADMIN', 'APPROVER', 'OWNER', 'VIEWER'] as const) {
      const personId = await inAccount(accountId, async (tx) => {
        const person = await r.people.create(tx, {
          displayName: `Kestrel ${role.toLowerCase()}`,
          nameNormalized: `kestrel ${role.toLowerCase()}`,
          email: `${role.toLowerCase()}@kestrel.example`,
          status: 'ACTIVE',
        });
        await r.memberships.create(tx, {
          personId: person.id,
          role,
          clientId: clientId!,
          consultantClientIds: null,
          unitIds: null,
          // A viewer's access always ends.
          expiresAt: role === 'VIEWER' ? '2099-01-01T00:00:00.000Z' : null,
        });
        return person.id;
      });
      const caller = await sessionFor(accountId, personId);
      expect(error(await get(caller, '/account')).code, role).toBe('FORBIDDEN');
      expect(error(await get(caller, '/account/support-grants')).code, role).toBe('FORBIDDEN');
      expect(
        error(await post(caller, '/account/support-grants', { level: 'ADMIN' })).code,
        role,
      ).toBe('FORBIDDEN');
      expect(
        error(await post(caller, `/account/support-grants/${randomUUID()}/revoke`)).code,
        role,
      ).toBe('FORBIDDEN');
    }
  });

  it('revokes a live grant now, ending its sessions; an ended one is 409 and an unknown one 404', async () => {
    const live = (await inAccount(accountId, (tx) =>
      r.supportGrants.live(tx, new Date().toISOString()),
    ))!;
    const support = await sessionFor(accountId, live.supportPersonId, live.id);
    const ended = z(SupportGrant, await post(owner, `/account/support-grants/${live.id}/revoke`));
    expect(ended).toMatchObject({ id: live.id, status: 'REVOKED', revokedById: ownerId });
    expect((await get(support, '/account')).statusCode).toBe(401);
    expect((await auditOf(accountId)).at(-1)).toEqual({
      actorId: ownerId,
      clientId: null,
      before: { expiresAt: live.endsAt },
      after: { expiresAt: ended.revokedAt, supportGrantId: live.id },
      reason: 'Support access revoked',
    });
    const again = await post(owner, `/account/support-grants/${live.id}/revoke`);
    expect([again.statusCode, error(again).code]).toEqual([409, 'INVALID_TRANSITION']);
    expect(error(await post(owner, `/account/support-grants/${randomUUID()}/revoke`)).code).toBe(
      'NOT_FOUND',
    );
    // Another account's admin cannot reach this grant.
    const fresh = z(
      SupportGrant,
      await post(owner, '/account/support-grants', { level: 'READ_ONLY' }),
    );
    expect(error(await post(otherOwner, `/account/support-grants/${fresh.id}/revoke`)).code).toBe(
      'NOT_FOUND',
    );
    expect(
      (await eventsOf(accountId)).filter((e) => e.type === 'support_access.revoked'),
    ).toHaveLength(2);
  });

  it('creates one grant per Idempotency-Key, even for two posts at once', async () => {
    const key = randomUUID();
    const send = () =>
      post(
        owner,
        '/account/support-grants',
        { level: 'ADMIN', days: 3 },
        { 'idempotency-key': key },
      );
    const [one, two] = await Promise.all([send(), send()]);
    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    expect(SupportGrant.parse(two.json()).id).toBe(SupportGrant.parse(one.json()).id);
    expect(z(SupportGrant, await send()).id).toBe(SupportGrant.parse(one.json()).id);
    const granted = (await eventsOf(accountId)).filter(
      (e) =>
        e.type === 'support_access.granted' && e.data.grantId === SupportGrant.parse(one.json()).id,
    );
    expect(granted).toHaveLength(1);
    expect(
      error(
        await post(
          owner,
          '/account/support-grants',
          { level: 'READ_ONLY' },
          { 'idempotency-key': key },
        ),
      ).code,
    ).toBe('VALIDATION');
    expect(
      error(
        await post(
          owner,
          '/account/support-grants',
          { level: 'ADMIN' },
          { 'idempotency-key': 'x' },
        ),
      ).code,
    ).toBe('VALIDATION');
  });
  it('keeps one live grant when grants arrive at once, with or without different keys', async () => {
    const send = (key?: string) =>
      post(
        owner,
        '/account/support-grants',
        { level: 'READ_ONLY', days: 1 },
        key ? { 'idempotency-key': key } : {},
      );
    const made = await Promise.all([send(randomUUID()), send(randomUUID()), send(), send()]);
    expect(made.map((res) => res.statusCode)).toEqual([201, 201, 201, 201]);
    const ids = made.map((res) => SupportGrant.parse(res.json()).id);
    const listed = (
      (await get(owner, '/account/support-grants')).json() as { items: unknown[] }
    ).items.map((g) => SupportGrant.parse(g));
    const active = listed.filter((g) => g.status === 'ACTIVE');
    expect(active).toHaveLength(1);
    expect(ids).toContain(active[0]!.id);
    // Each grant the next one replaced is ended, in the database as in the list.
    expect(listed.filter((g) => ids.includes(g.id) && g.status === 'REVOKED')).toHaveLength(3);
    // The operator trail shows each start and end, from M3's trigger.
    const trail = await t.operatorDb.withOperator(
      'customer-test',
      async (tx) => (await r.operatorAudit.query(tx, { accountId })).items,
    );
    for (const id of ids) {
      expect(
        trail.filter((e) => e.action === 'SUPPORT_ACCESS_START' && e.after?.grantId === id),
        id,
      ).toHaveLength(1);
    }
    expect(
      trail.filter(
        (e) => e.action === 'SUPPORT_ACCESS_END' && ids.includes(String(e.after?.grantId)),
      ),
    ).toHaveLength(3);
    expect(
      trail.find((e) => e.action === 'SUPPORT_ACCESS_START' && e.after?.grantId === ids[0])?.after,
    ).toEqual({
      grantId: ids[0],
      level: 'READ_ONLY',
      startsAt: expect.any(String),
      endsAt: expect.any(String),
      source: 'grant',
    });
  });
});

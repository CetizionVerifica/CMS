import { createHmac, randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { ApiErrorResponse, OperatorMe } from '@canopy/contracts';
import {
  createAdminDatabase,
  createOperatorDatabase,
  operatorAudit,
  operators,
  type AdminDatabase,
  type OperatorDatabase,
} from '@canopy/db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../auth/index.js';
import { buildServer } from '../server.js';
import { ipAllowlistFromEnv } from './allowlist.js';
import { addOperator, runAddOperator } from './db-operators.js';

// The operator sign-in on Postgres 16, as canopy_operator (CI `db` job). Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;

const KEY = Buffer.alloc(32, 9).toString('base64');
const APP_URL = 'https://app.planetpulse.example';
const PASSWORD = 'operator password, long enough';
let now = new Date('2026-10-24T03:30:00.000Z');

/** RFC 6238 from the otpauth URI, written out here so the test does not reuse the code under test. */
function codeAt(uri: string, at: Date, stepOffset = 0): string {
  const secret = new URL(uri).searchParams.get('secret')!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000) + stepOffset));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const error = (res: LightMyRequestResponse) => ApiErrorResponse.parse(res.json()).error;

function cookieOf(res: LightMyRequestResponse) {
  return res.cookies.find((c) => c.name === 'op_sid');
}

describe.skipIf(!url)('operator sign-in', () => {
  let name: string;
  let admin: AdminDatabase;
  let db: OperatorDatabase;
  let owner: pg.Pool;
  let app: FastifyInstance;
  let uri: string;
  let operatorId: string;
  let address = 0;
  const secrets = new SecretBox(KEY);

  const login = (body: Record<string, unknown>, ip = `10.1.0.${(address += 1) % 250}`) =>
    app.inject({
      method: 'POST',
      url: '/api/platform/v1/auth/login',
      remoteAddress: ip,
      payload: body,
    });
  const good = (stepOffset = 0) => ({
    email: 'shyam.ops@planetpulse.example',
    password: PASSWORD,
    code: codeAt(uri, now, stepOffset),
  });
  async function signIn(stepOffset = 0) {
    const res = await login(good(stepOffset));
    expect(res.statusCode, res.body).toBe(200);
    const me = OperatorMe.parse(res.json());
    return { res, me, cookie: `op_sid=${cookieOf(res)!.value}`, csrf: me.csrfToken };
  }
  const audit = () =>
    db.withOperator('read', (tx) => operatorAudit.query(tx, { action: 'OPERATOR_LOGIN' }));

  beforeAll(async () => {
    const base = new URL(url!);
    name = `canopy_m15_${randomBytes(6).toString('hex')}`;
    const server = new pg.Client({ connectionString: base.toString() });
    await server.connect();
    await server.query(`CREATE DATABASE ${name}`);
    await server.end();
    const target = new URL(base);
    target.pathname = `/${name}`;
    admin = createAdminDatabase({ connectionString: target.toString() });
    await admin.migrate();
    db = createOperatorDatabase({ connectionString: target.toString(), max: 3 });
    owner = new pg.Pool({ connectionString: target.toString(), max: 1 });
    const added = await addOperator(db, secrets, {
      email: 'shyam.ops@planetpulse.example',
      displayName: 'Shyam',
      password: PASSWORD,
    });
    uri = added.otpauthUri;
    operatorId = added.operator.id;
    app = buildServer({
      clock: () => now,
      platform: { db, secrets, secureCookies: true, appUrl: APP_URL },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    await owner?.end();
    await admin?.close();
    const cleanup = new pg.Client({ connectionString: url! });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  });

  beforeEach(() => {
    // Each test signs in at a later 30-second step, so no code is a replay of another test's.
    now = new Date(now.getTime() + 10 * 60_000);
  });

  it('creates operators only through the CLI, with the authenticator URI shown once', async () => {
    expect(uri).toMatch(
      /^otpauth:\/\/totp\/PlanetPulse%20Compliance%3Ashyam\.ops%40planetpulse\.example\?/,
    );
    const stdin = new PassThrough();
    stdin.end('another long operator password\n');
    const lines: string[] = [];
    await runAddOperator(
      ['--email', 'second.ops@planetpulse.example', '--name', 'Second operator'],
      { OPERATOR_DATABASE_URL: new URL(`/${name}`, url!).toString(), AUTH_SECRET_KEY: KEY },
      { stdin, out: (line) => lines.push(line) },
    );
    expect(lines[0]).toMatch(/^Operator second\.ops@planetpulse\.example created/);
    expect(lines[2]).toMatch(/^otpauth:\/\/totp\//);
    await expect(
      runAddOperator(['--email', 'x@planetpulse.example'], {}, { stdin, out: () => {} }),
    ).rejects.toThrow('Usage');
    await expect(
      runAddOperator(
        ['--email', 'x@planetpulse.example', '--name', 'X'],
        {},
        {
          stdin,
          out: () => {},
        },
      ),
    ).rejects.toThrow('OPERATOR_DATABASE_URL');
    const short = new PassThrough();
    short.end('short\n');
    await expect(
      runAddOperator(
        ['--email', 'third.ops@planetpulse.example', '--name', 'Third'],
        { OPERATOR_DATABASE_URL: new URL(`/${name}`, url!).toString(), AUTH_SECRET_KEY: KEY },
        { stdin: short, out: () => {} },
      ),
    ).rejects.toThrow();
  });

  it('signs in with email, password and code, on its own strict cookie, and audits it', async () => {
    const { res, me } = await signIn();
    expect(me.operator).toMatchObject({ id: operatorId, displayName: 'Shyam', disabledAt: null });
    expect(me.session).toEqual({
      expiresAt: new Date(now.getTime() + 8 * 3_600_000).toISOString(),
      idleExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    });
    expect(cookieOf(res)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/api/platform',
    });
    expect(res.cookies.find((c) => c.name === 'sid')).toBeUndefined();
    const [entry] = (await audit()).items;
    expect(entry).toMatchObject({
      operatorId,
      action: 'OPERATOR_LOGIN',
      accountId: null,
      ip: expect.stringMatching(/^10\.1\.0\./),
    });
  });

  it('accepts the email in any case', async () => {
    const res = await login({ ...good(), email: 'Shyam.Ops@PlanetPulse.example' });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['an unknown email', { email: 'nobody@planetpulse.example' }],
    ['a wrong password', { password: 'not the operator password' }],
    ['a wrong code', { code: '000000' }],
  ])('says only "not correct" for %s', async (_, change) => {
    const res = await login({ ...good(), ...change });
    expect(res.statusCode).toBe(401);
    expect(error(res)).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Email, password or code is not correct.',
    });
    expect(cookieOf(res)).toBeUndefined();
  });

  it('refuses a code used before', async () => {
    await signIn();
    const replay = await login(good());
    expect(error(replay).code).toBe('UNAUTHENTICATED');
  });

  it('refuses a malformed body as VALIDATION', async () => {
    const res = await login({ email: 'shyam.ops@planetpulse.example', password: PASSWORD });
    expect(error(res).code).toBe('VALIDATION');
  });

  it('locks after ten failures in a row, even with everything right, until the lock ends', async () => {
    for (let i = 0; i < 10; i++) await login({ ...good(), code: '000000' });
    expect(error(await login(good())).code).toBe('UNAUTHENTICATED');
    now = new Date(now.getTime() + 16 * 60_000);
    expect((await login(good())).statusCode).toBe(200);
  });

  it('reads /me with the session, and refuses without it or with the customer cookie', async () => {
    const { cookie, me } = await signIn();
    const res = await app.inject({ url: '/api/platform/v1/me', headers: { cookie } });
    expect(OperatorMe.parse(res.json())).toEqual(me);
    expect(error(await app.inject({ url: '/api/platform/v1/me' })).code).toBe('UNAUTHENTICATED');
    const customer = await app.inject({
      url: '/api/platform/v1/me',
      headers: { cookie: `sid=${cookie.slice('op_sid='.length)}` },
    });
    expect(error(customer).code).toBe('UNAUTHENTICATED');
    expect(
      error(await app.inject({ url: '/api/platform/v1/me', headers: { cookie: 'op_sid=guess' } }))
        .code,
    ).toBe('UNAUTHENTICATED');
  });

  it('is never read by the customer API', async () => {
    const { cookie } = await signIn();
    const res = await app.inject({ url: '/api/v1/portfolio', headers: { cookie } });
    expect(error(res).code).toBe('UNAUTHENTICATED');
  });

  it('ends after 30 minutes idle, and each request moves the idle clock on', async () => {
    const { cookie } = await signIn();
    now = new Date(now.getTime() + 25 * 60_000);
    const used = await app.inject({ url: '/api/platform/v1/me', headers: { cookie } });
    expect(OperatorMe.parse(used.json()).session.idleExpiresAt).toBe(
      new Date(now.getTime() + 30 * 60_000).toISOString(),
    );
    now = new Date(now.getTime() + 25 * 60_000);
    expect((await app.inject({ url: '/api/platform/v1/me', headers: { cookie } })).statusCode).toBe(
      200,
    );
    now = new Date(now.getTime() + 30 * 60_000);
    expect(error(await app.inject({ url: '/api/platform/v1/me', headers: { cookie } })).code).toBe(
      'UNAUTHENTICATED',
    );
    // Revoked once found idle: coming back to the clock it had does not reopen it.
    now = new Date(now.getTime() - 10 * 60_000);
    expect(error(await app.inject({ url: '/api/platform/v1/me', headers: { cookie } })).code).toBe(
      'UNAUTHENTICATED',
    );
    now = new Date(now.getTime() + 10 * 60_000);
  });

  it('ends 8 hours after sign-in, however busy', async () => {
    const { cookie } = await signIn();
    for (let i = 0; i < 17; i++) {
      now = new Date(now.getTime() + 28 * 60_000);
      const res = await app.inject({ url: '/api/platform/v1/me', headers: { cookie } });
      expect(res.statusCode).toBe(200);
    }
    now = new Date(now.getTime() + 28 * 60_000);
    expect(error(await app.inject({ url: '/api/platform/v1/me', headers: { cookie } })).code).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('signs out with the CSRF token only, and the session is gone', async () => {
    const { cookie, csrf } = await signIn();
    const logout = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/platform/v1/auth/logout', headers });
    const missing = await logout({ cookie });
    expect(error(missing)).toMatchObject({ code: 'FORBIDDEN' });
    expect(error(await logout({ cookie, 'x-csrf-token': 'not-the-token-at-all' })).code).toBe(
      'FORBIDDEN',
    );
    const res = await logout({ cookie, 'x-csrf-token': csrf });
    expect(res.statusCode).toBe(204);
    expect(cookieOf(res)).toMatchObject({ value: '', path: '/api/platform' });
    expect(error(await app.inject({ url: '/api/platform/v1/me', headers: { cookie } })).code).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('refuses a disabled operator at sign-in and ends their sessions', async () => {
    const stdin = new PassThrough();
    stdin.end('fourth operator password\n');
    const lines: string[] = [];
    await runAddOperator(
      ['--email', 'fourth.ops@planetpulse.example', '--name', 'Fourth'],
      { OPERATOR_DATABASE_URL: new URL(`/${name}`, url!).toString(), AUTH_SECRET_KEY: KEY },
      { stdin, out: (line) => lines.push(line) },
    );
    const fourth = lines[2]!;
    const body = () => ({
      email: 'fourth.ops@planetpulse.example',
      password: 'fourth operator password',
      code: codeAt(fourth, now),
    });
    const first = await login(body());
    expect(first.statusCode).toBe(200);
    const cookie = `op_sid=${cookieOf(first)!.value}`;
    const id = OperatorMe.parse(first.json()).operator.id;
    await db.withOperator('disable', (tx) => operators.disable(tx, id, now.toISOString()));
    expect(error(await app.inject({ url: '/api/platform/v1/me', headers: { cookie } })).code).toBe(
      'UNAUTHENTICATED',
    );
    now = new Date(now.getTime() + 60_000);
    expect(error(await login(body())).code).toBe('UNAUTHENTICATED');
  });

  it('answers 404 on every operator route to an address outside PLATFORM_IP_ALLOWLIST', async () => {
    const listed = buildServer({
      clock: () => now,
      platform: { db, secrets, allowlist: ipAllowlistFromEnv('203.0.113.0/24'), appUrl: APP_URL },
    });
    try {
      const outside = await listed.inject({
        method: 'POST',
        url: '/api/platform/v1/auth/login',
        remoteAddress: '198.51.100.9',
        payload: good(),
      });
      expect(outside.statusCode).toBe(404);
      expect(error(outside).code).toBe('NOT_FOUND');
      const inside = await listed.inject({
        method: 'POST',
        url: '/api/platform/v1/auth/login',
        remoteAddress: '203.0.113.9',
        payload: good(),
      });
      expect(inside.statusCode).toBe(200);
      // The customer API is not behind the operator allowlist.
      expect(
        (await listed.inject({ url: '/health', remoteAddress: '198.51.100.9' })).statusCode,
      ).toBe(200);
    } finally {
      await listed.close();
    }
  });

  it('is not mounted without platform options', async () => {
    const plain = buildServer();
    try {
      expect((await plain.inject({ url: '/api/platform/v1/me' })).statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

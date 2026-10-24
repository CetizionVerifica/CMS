import { createHash } from 'node:crypto';

import { ENDPOINTS } from '@canopy/contracts';
import { systemContext, tenantSettings } from '@canopy/db';
import { expect, request, test } from '@playwright/test';
import pg from 'pg';

import { anonymousApi, apiAs, itemsOf, type ApiSession } from './api.js';
import { seeded } from './helpers.js';
import {
  API_URL,
  APP_LOGIN,
  APP_PASSWORD,
  E2E_DATABASE,
  FIRM_A,
  FIRM_B,
  PASSWORD,
  ACCOUNTS,
  databaseUrl,
  storageStateOf,
} from './stack.js';

// Security review checks (docs/security/review.md) against the running API and database: tenant isolation for every
// endpoint, sessions and CSRF, evidence upload and download rules, and RLS for the app's own database login.
const FY = 'fy=2022-23';
const PDF = Buffer.from('%PDF-1.4\n% integrated journey evidence\n%%EOF\n');

type Endpoint = { auth: string; method: string; path: string };
const endpoints = Object.entries(ENDPOINTS as Record<string, Endpoint>);

/** Firm A's ids for every kind of record a path can name, read as firm A's own users. */
async function firmAIds(): Promise<Record<string, string>> {
  const { clients, people } = seeded();
  const admin = await apiAs('consultant');
  const get = async (path: string) => {
    const res = await admin.get(path);
    expect(res.status, path).toBe(200);
    return res.body;
  };
  const instance = itemsOf(
    await get(`/clients/${clients.kestrel}/instances?${FY}&workflowState=OPEN&limit=1`),
  )[0]!;
  const detail = (await get(`/instances/${instance.id}`)) as {
    obligationId: string;
    actId: string;
  };
  const first = async (path: string) =>
    ((await get(path)) as { items: { id: string }[] }).items[0]?.id ?? '';
  const exportJob = await admin.post(`/clients/${clients.kestrel}/exports`, {
    kind: 'REGISTER_XLSX',
    filters: FY,
  });
  const categories = (await get('/library/categories')) as { items: { id: string }[] };
  const ids = {
    clientId: clients.kestrel,
    instances: instance.id,
    exports: (exportJob.body as { id: string }).id,
    imports: await first(`/clients/${clients.kestrel}/imports`),
    companies: await first(`/clients/${clients.kestrel}/companies`),
    units: await first(`/clients/${clients.kestrel}/units`),
    departments: await first(`/clients/${clients.kestrel}/departments`),
    assignments: await first(`/clients/${clients.kestrel}/assignments`),
    people: people.owner,
    memberships: await first(`/people/${people.owner}/memberships`),
    acts: detail.actId,
    obligations: detail.obligationId,
    categories: categories.items[0]!.id,
    evidence: await evidenceOf(instance.id),
  };
  await admin.dispose();
  return ids;
}

/** Uploads a small PDF to an instance as the client admin, the way the drawer will, and returns its evidence id. */
async function evidenceOf(instanceId: string): Promise<string> {
  const admin = await apiAs('clientAdmin');
  const ticket = await admin.post(`/instances/${instanceId}/evidence/upload-url`, {
    fileName: 'challan.pdf',
    mimeType: 'application/pdf',
    sizeBytes: PDF.length,
  });
  expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);
  const { uploadId, url, headers } = ticket.body as {
    uploadId: string;
    url: string;
    headers: Record<string, string>;
  };
  const put = await admin.http.put(url, { headers, data: PDF });
  expect(put.status()).toBe(200);
  const confirmed = await admin.post(`/instances/${instanceId}/evidence`, {
    uploadId,
    fileName: 'challan.pdf',
    sha256: createHash('sha256').update(PDF).digest('hex'),
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
  await admin.dispose();
  return (confirmed.body as { id: string }).id;
}

/** The path with every parameter filled from `ids` (by the segment before it), or null when one has no id. */
function fill(path: string, ids: Record<string, string>): string | null {
  let missing = false;
  const filled = path.replace(/([\w-]+)\/\{(\w+)\}/g, (_m, segment: string, param: string) => {
    const key = param === 'clientId' ? 'clientId' : param === 'groupKey' ? 'group' : segment;
    const id = key === 'group' ? 'RULE_LOW_CONFIDENCE-0' : ids[key];
    if (!id) missing = true;
    return `${segment}/${id}`;
  });
  return missing ? null : filled;
}

const SAFE_DENIALS = [403, 404];
const UNKNOWN = '01920000-0000-7000-8000-0000000dead0';
/** Ids no firm has, for every record kind `fill` can name. */
const NOBODY = new Proxy({} as Record<string, string>, { get: () => UNKNOWN });

async function call(api: ApiSession, method: string, path: string) {
  if (method === 'GET') return api.get(path);
  const res = await api.http.fetch(`/api/v1${path}`, {
    method,
    headers: { 'x-csrf-token': api.csrfToken, 'idempotency-key': crypto.randomUUID() },
    data: {},
  });
  return { status: res.status(), body: await res.text() };
}

test.describe('tenant isolation', () => {
  test('firm B’s admins reach none of firm A’s records through any endpoint', async () => {
    const ids = await firmAIds();
    const kestrelNames = ['Kestrel', 'Person Mike', 'challan.pdf'];
    for (const key of ['ospreyFirmAdmin', 'ospreyAdmin'] as const) {
      const api = await apiAs(key);
      for (const [name, e] of endpoints) {
        if (e.auth === 'public' || !e.path.includes('{')) continue;
        if (e.path.startsWith('/invites/')) continue;
        const path = fill(e.path, ids);
        if (path === null) continue;
        const res = await call(api, e.method, path);
        const label = `${key} ${e.method} ${path} (${name}) -> ${res.status}`;
        if (e.method === 'GET') {
          // A record in another firm is never shown: not found, or forbidden for the role.
          expect(SAFE_DENIALS, label).toContain(res.status);
        } else {
          // Never changed, and no existence oracle: firm A's id gets the same answer as an id nobody has (a write
          // with an empty body may fail validation first, which is fine when it fails the same way for both).
          expect(res.status, label).toBeGreaterThanOrEqual(400);
          const nobody = await call(api, e.method, fill(e.path, NOBODY)!);
          expect(res.status, `${label}; unknown id -> ${nobody.status}`).toBe(nobody.status);
        }
        const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        for (const word of kestrelNames) expect(text, `${name} leaks ${word}`).not.toContain(word);
      }
      // Firm-wide lists hold only firm B's records.
      for (const path of [
        '/clients',
        '/people',
        '/portfolio',
        '/library/obligations',
        '/me/approvals',
      ]) {
        const res = await api.get(path);
        if (res.status !== 200) continue;
        const text = JSON.stringify(res.body);
        for (const word of kestrelNames)
          expect(text, `${key} ${path} leaks ${word}`).not.toContain(word);
      }
      await api.dispose();
    }
  });

  test('the app’s database login sees only the tenant it is set to (RLS)', async () => {
    const base = process.env.DATABASE_URL!;
    const client = new pg.Client({
      connectionString: databaseUrl(base, E2E_DATABASE, [APP_LOGIN, APP_PASSWORD]),
    });
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    /** Rows of `table` belonging to `owner`, as seen in a transaction set to `as` (or to no tenant). */
    const rowsOf = async (as: string | null, table: string, owner: string) => {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE canopy_app');
      if (as) {
        // Exactly what withTenant sets for a firm-wide system context.
        for (const [name, value] of Object.entries(tenantSettings(systemContext(as, 'e2e-rls')))) {
          await client.query('SELECT set_config($1, $2, true)', [name, value]);
        }
      }
      try {
        const res = await client.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'firm' ? 'id' : 'firm_id'} = $1`,
          [owner],
        );
        return res.rows[0].n as number;
      } catch {
        return 0;
      } finally {
        await client.query('ROLLBACK');
      }
    };
    const tables = [
      'firm',
      'client',
      'person',
      'membership',
      'compliance_instance',
      'assignment',
      'obligation',
      'evidence',
      'comment',
      'audit_event',
      'import_batch',
      'export_job',
      'auth_session',
    ];
    for (const table of tables) {
      expect(await rowsOf(FIRM_A, table, FIRM_A), `${table}: firm A sees its rows`).toBeGreaterThan(
        0,
      );
      expect(await rowsOf(FIRM_B, table, FIRM_A), `${table}: firm B sees firm A's`).toBe(0);
      expect(await rowsOf(null, table, FIRM_A), `${table}: no tenant sees firm A's`).toBe(0);
    }
    await client.end();
  });
});

test.describe('sessions', () => {
  test('every signed-in endpoint refuses a request with no session', async () => {
    const ids = await firmAIds();
    const anon = await anonymousApi();
    for (const [name, e] of endpoints) {
      if (e.auth === 'public') continue;
      const path = fill(e.path, ids) ?? e.path;
      const res = await call(anon, e.method, path);
      // GETs: 401. Writes: 403 (no session means no CSRF match) or 401.
      expect([401, 403], `${e.method} ${path} (${name}) -> ${res.status}`).toContain(res.status);
    }
    await anon.dispose();
  });

  test('a write without the CSRF token is refused', async () => {
    const { clients } = seeded();
    const admin = await apiAs('clientAdmin');
    const res = await admin.http.post(`/api/v1/clients/${clients.kestrel}/exports`, {
      data: { kind: 'REGISTER_XLSX', filters: FY },
    });
    expect(res.status()).toBe(403);
    await admin.dispose();
  });

  test('the session cookie is HttpOnly, Secure and SameSite=Lax, and sign-out ends it on the server', async () => {
    const { cookies } = JSON.parse(
      await import('node:fs').then((fs) => fs.readFileSync(storageStateOf('viewer'), 'utf8')),
    ) as { cookies: { name: string; httpOnly: boolean; secure: boolean; sameSite: string }[] };
    expect(cookies.find((c) => c.name === 'sid')).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });

    // A fresh session for the viewer, then sign out and replay its cookie.
    const http = await request.newContext({ baseURL: API_URL });
    const login = await http.post('/api/v1/auth/login', {
      data: { email: ACCOUNTS.viewer.email, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
    const sid = login
      .headersArray()
      .find((h) => /^set-cookie$/i.test(h.name) && h.value.startsWith('sid='));
    const cookie = sid!.value.split(';')[0]!;
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    expect((await http.get('/api/v1/me', { headers: { cookie } })).status()).toBe(200);
    const out = await http.post('/api/v1/auth/logout', {
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(out.status()).toBe(204);
    expect((await http.get('/api/v1/me', { headers: { cookie } })).status()).toBe(401);
    // A wrong password says nothing about whether the email exists.
    const wrong = await http.post('/api/v1/auth/login', {
      data: { email: ACCOUNTS.viewer.email, password: 'not the password' },
    });
    const nobody = await http.post('/api/v1/auth/login', {
      data: { email: 'nobody@kestrel.test', password: 'not the password' },
    });
    expect(wrong.status()).toBe(401);
    expect(nobody.status()).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { code: (await nobody.json()).error.code } });
    await http.dispose();
  });
});

test.describe('evidence files', () => {
  test('only accepted types get an upload link, and the link binds the declared type and size', async () => {
    const { clients } = seeded();
    const admin = await apiAs('clientAdmin');
    const instance = itemsOf(
      (await admin.get(`/clients/${clients.kestrel}/instances?${FY}&workflowState=OPEN&limit=1`))
        .body,
    )[0]!;
    for (const [fileName, mimeType] of [
      ['payload.html', 'text/html'],
      ['payload.svg', 'image/svg+xml'],
      ['tool.exe', 'application/octet-stream'],
      ['scan.pdf', 'text/html'],
    ]) {
      const res = await admin.post(`/instances/${instance.id}/evidence/upload-url`, {
        fileName,
        mimeType,
        sizeBytes: 10,
      });
      expect(res.status, fileName).toBe(400);
    }
    const tooBig = await admin.post(`/instances/${instance.id}/evidence/upload-url`, {
      fileName: 'big.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 25 * 1024 * 1024 + 1,
    });
    expect(tooBig.status).toBe(400);

    const ticket = (
      await admin.post(`/instances/${instance.id}/evidence/upload-url`, {
        fileName: 'challan.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
      })
    ).body as { url: string; headers: Record<string, string> };
    expect(new URL(ticket.url).searchParams.get('X-Amz-Expires')).toBe('300');
    // Another content type than the one signed is refused by storage.
    const swapped = await admin.http.put(ticket.url, {
      headers: { ...ticket.headers, 'Content-Type': 'text/html' },
      data: PDF,
    });
    expect(swapped.status()).toBe(403);
    await admin.dispose();
  });

  test('an unscanned file cannot be downloaded, and the vault is per client', async () => {
    const { clients } = seeded();
    const admin = await apiAs('clientAdmin');
    const open = itemsOf(
      (await admin.get(`/clients/${clients.kestrel}/instances?${FY}&workflowState=OPEN&limit=1`))
        .body,
    )[0]!;
    await evidenceOf(open.id);
    const vault = await admin.get(`/clients/${clients.kestrel}/evidence`);
    expect(vault.status).toBe(200);
    const files = itemsOf(vault.body) as unknown as { id: string; scanStatus: string }[];
    expect(files.length).toBeGreaterThan(0);
    // No scanner runs yet (docs/security/review.md F8), so every file stays PENDING and is not handed out.
    for (const file of files) {
      expect(file.scanStatus).toBe('PENDING');
      const link = await admin.get(`/evidence/${file.id}/download-url`);
      expect(link).toMatchObject({ status: 422, body: { error: { code: 'EVIDENCE_NOT_READY' } } });
    }
    // The vault never returns the storage key.
    expect(JSON.stringify(vault.body)).not.toContain('storageKey');
    await admin.dispose();
  });
});

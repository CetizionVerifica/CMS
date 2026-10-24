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

type Endpoint = {
  auth: string;
  method: string;
  path: string;
  body?: { parse(v: unknown): unknown } | null;
};
const endpoints = Object.entries(ENDPOINTS as Record<string, Endpoint>);

/**
 * Contract endpoints the API does not serve yet, with why. Every check below expects them to answer 404 (no route) and
 * fails once one answers anything else, so it must come off this list the day it ships and be checked like the rest.
 */
const UNMOUNTED: Record<string, string> = {
  getAccount: 'M15 account routes: contracts 1.5.0 (#127), API not built yet',
  listSupportGrants: 'M15 account routes: contracts 1.5.0 (#127), API not built yet',
  createSupportGrant: 'M15 account routes: contracts 1.5.0 (#127), API not built yet',
  revokeSupportGrant: 'M15 account routes: contracts 1.5.0 (#127), API not built yet',
};

/**
 * Endpoints the isolation sweep does not call with firm A's ids, with why. The sweep fails on any endpoint that is in
 * neither the sweep nor this list, so a new endpoint has to be placed in one or the other.
 */
const NOT_SWEPT: Record<string, string> = {
  login: 'public, names no record',
  requestMagicLink: 'public, names no record',
  verifyMagicLink: 'public, takes a secret token, not an id',
  getInvite: 'public, takes a secret token, not an id',
  acceptInvite: 'public, takes a secret token, not an id',
  verifySupportSession: 'public, takes a secret token, not an id',
  logout: 'acts on the caller’s own session',
  enrollMfa: 'acts on the caller’s own session',
  verifyMfa: 'acts on the caller’s own session',
  createClient: 'creates in the caller’s own firm; names no record',
  createLocation: 'creates in the caller’s own firm; names no record',
  createAct: 'creates in the caller’s own firm; names no record',
  createCategory: 'creates in the caller’s own firm; names no record',
  createObligation: 'creates in the caller’s own firm; names no record',
  previewRule: 'computes due dates from the body; reads no record',
  ...UNMOUNTED,
};

const PROBE = 'isolation probe';
const SHA = '0'.repeat(64);

/**
 * Valid bodies for the writes that change compliance state or reach a record through the body, built from firm A's
 * own record versions, so a write that got past the tenant check would be applied, not refused for its body. Each one
 * is checked against the contract's schema first.
 */
const BODIES: Record<string, (ids: Ids) => unknown> = {
  submitInstance: ({ v }) => ({ version: v.instances, completedOn: '2023-03-31', comment: PROBE }),
  requestNa: ({ v }) => ({ version: v.instances, reason: PROBE }),
  approveInstance: ({ v }) => ({ version: v.instances }),
  sendBackInstance: ({ v }) => ({ version: v.instances, reason: PROBE }),
  reopenInstance: ({ v }) => ({ version: v.instances, reason: PROBE }),
  updateInstance: ({ v }) => ({ version: v.instances, dueDate: '2023-03-31', reason: PROBE }),
  bulkApprove: ({ id, v }) => ({ items: [{ id: id.instances, version: v.instances }] }),
  createComment: () => ({ body: PROBE }),
  evidenceUploadUrl: () => ({ fileName: 'probe.pdf', mimeType: 'application/pdf', sizeBytes: 10 }),
  confirmEvidence: () => ({ uploadId: UNKNOWN, fileName: 'probe.pdf', sha256: SHA }),
  removeEvidence: () => ({ reason: PROBE }),
  createExport: () => ({ kind: 'REGISTER_XLSX', filters: '' }),
  createImport: () => ({ fileName: 'probe.xlsx', sizeBytes: 10 }),
  updateClient: ({ v }) => ({ version: v.clientId, name: 'Probe Group' }),
  archiveClient: ({ v }) => ({ version: v.clientId, reason: PROBE }),
  restoreClient: ({ v }) => ({ version: v.clientId }),
  archiveCompany: ({ v }) => ({ version: v.companies, reason: PROBE }),
  archiveUnit: ({ v }) => ({ version: v.units, reason: PROBE }),
  archiveAssignment: ({ v }) => ({ version: v.assignments, reason: PROBE }),
  archiveMembership: ({ v }) => ({ version: v.memberships, reason: PROBE }),
  archiveObligation: ({ v }) => ({ version: v.obligations, reason: PROBE }),
  updatePerson: ({ v }) => ({ version: v.people, displayName: 'Probe Person' }),
  revokeInvite: () => undefined,
  cancelImport: () => undefined,
  // Names firm A's person and client in the body rather than the path.
  createInvite: ({ id }) => ({
    personId: id.people,
    email: 'probe@kestrel.test',
    role: 'VIEWER',
    clientId: id.clientId,
    consultantClientIds: null,
    unitIds: null,
    expiresAt: '2099-12-31T00:00:00Z',
  }),
};

/**
 * The sweep calls every signed-in endpoint that names a record in its path or (BODIES) its body, and reads every
 * firm-wide list.
 */
const sweepable = (name: string, e: Endpoint) =>
  e.auth !== 'public' && (e.path.includes('{') || e.method === 'GET' || name in BODIES);

/** Firm A's ids (and record versions) for every kind of record a path can name, read as firm A's own users. */
type Ids = { id: Record<string, string>; v: Record<string, number> };

async function firmAIds(): Promise<Ids> {
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
  type Rec = { id: string; version: number };
  const first = async (path: string) => {
    const item = ((await get(path)) as { items: Rec[] }).items[0];
    if (!item) throw new Error(`firm A has no record at ${path}`);
    return item;
  };
  const exportJob = await admin.post(`/clients/${clients.kestrel}/exports`, {
    kind: 'REGISTER_XLSX',
    filters: FY,
  });
  const invite = await admin.post('/invites', {
    displayName: 'Invited Viewer',
    // firmAIds runs once per test, and an email names one person in a firm.
    email: `invited-${crypto.randomUUID().slice(0, 8)}@kestrel.test`,
    role: 'VIEWER',
    clientId: clients.kestrel,
    consultantClientIds: null,
    unitIds: null,
    expiresAt: '2099-12-31T00:00:00Z',
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const batch = (await first(`/clients/${clients.kestrel}/imports`)) as Rec & { mapping: unknown };
  const template = await admin.post(`/clients/${clients.kestrel}/mapping-templates`, {
    name: `Kestrel register layout ${crypto.randomUUID().slice(0, 8)}`,
    mapping: batch.mapping,
    scope: 'CLIENT',
  });
  expect(template.status, JSON.stringify(template.body)).toBe(201);
  const records: Record<string, Rec> = {
    clientId: (await get(`/clients/${clients.kestrel}`)) as Rec,
    instances: instance,
    exports: exportJob.body as Rec,
    invites: invite.body as Rec,
    imports: batch,
    'mapping-templates': template.body as Rec,
    companies: await first(`/clients/${clients.kestrel}/companies`),
    units: await first(`/clients/${clients.kestrel}/units`),
    departments: await first(`/clients/${clients.kestrel}/departments`),
    assignments: await first(`/clients/${clients.kestrel}/assignments`),
    people: (
      (await get(`/clients/${clients.kestrel}/people?limit=100`)) as { items: Rec[] }
    ).items.find((p) => p.id === people.owner)!,
    memberships: await first(`/people/${people.owner}/memberships`),
    acts: { id: detail.actId, version: 1 },
    obligations: (await get(`/library/obligations/${detail.obligationId}`)) as Rec,
    categories: await first('/library/categories'),
    evidence: { id: await evidenceOf(instance.id), version: 1 },
  };
  await admin.dispose();
  return {
    id: Object.fromEntries(Object.entries(records).map(([k, r]) => [k, r.id])),
    v: Object.fromEntries(Object.entries(records).map(([k, r]) => [k, r.version])),
  };
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

/** The path with every parameter filled from `ids` (by the segment before it). Throws on a kind it has no id for. */
function fill(path: string, ids: Record<string, string>): string {
  return path.replace(/([\w-]+)\/\{(\w+)\}/g, (_m, segment: string, param: string) => {
    if (param === 'groupKey') return `${segment}/RULE_LOW_CONFIDENCE-0`;
    const id = ids[param === 'clientId' ? 'clientId' : segment];
    if (!id) throw new Error(`no id for {${param}} in ${path}: add the record kind to firmAIds`);
    return `${segment}/${id}`;
  });
}

const SAFE_DENIALS = [403, 404];
const UNKNOWN = '01920000-0000-7000-8000-0000000dead0';
/** Ids no firm has, for every record kind `fill` can name. */
const NOBODY = new Proxy({} as Record<string, string>, { get: () => UNKNOWN });

async function call(api: ApiSession, method: string, path: string, body: unknown = {}) {
  if (method === 'GET') return api.get(path);
  const res = await api.http.fetch(`/api/v1${path}`, {
    method,
    headers: { 'x-csrf-token': api.csrfToken, 'idempotency-key': crypto.randomUUID() },
    ...(body === undefined ? {} : { data: body }),
  });
  return { status: res.status(), body: await res.text() };
}

test.describe('tenant isolation', () => {
  test('every endpoint is either swept or listed with a reason', () => {
    for (const name of [...Object.keys(UNMOUNTED), ...Object.keys(BODIES)])
      expect(ENDPOINTS, name).toHaveProperty(name);
    for (const [name, e] of endpoints) {
      expect(
        sweepable(name, e) !== name in NOT_SWEPT || name in UNMOUNTED,
        `${name} (${e.method} ${e.path}): sweep it, or list it in NOT_SWEPT with a reason`,
      ).toBe(true);
    }
  });

  test('firm B’s admins reach none of firm A’s records through any endpoint', async () => {
    const ids = await firmAIds();
    const kestrelNames = ['Kestrel', 'Person Mike', 'challan.pdf'];
    for (const key of ['ospreyFirmAdmin', 'ospreyAdmin'] as const) {
      const api = await apiAs(key);
      for (const [name, e] of endpoints) {
        if (!sweepable(name, e) || name in UNMOUNTED) continue;
        let res: { status: number; body: unknown };
        let label: string;
        if (e.method === 'GET' && !e.path.includes('{')) {
          // A firm-wide list holds firm B's records only.
          res = await api.get(e.path);
          label = `${key} GET ${e.path} (${name}) -> ${res.status}`;
          expect([200, 403], label).toContain(res.status);
        } else if (e.method === 'GET') {
          const path = fill(e.path, ids.id);
          res = await api.get(path);
          label = `${key} GET ${path} (${name}) -> ${res.status}`;
          // A record in another firm is never shown: not found, or forbidden for the role.
          expect(SAFE_DENIALS, label).toContain(res.status);
        } else {
          const path = fill(e.path, ids.id);
          const build = BODIES[name];
          const body = build ? build(ids) : {};
          const nobodyBody = build ? build({ id: NOBODY, v: ids.v }) : {};
          if (build && body !== undefined) e.body!.parse(body);
          res = await call(api, e.method, path, body);
          label = `${key} ${e.method} ${path} (${name}) -> ${res.status}`;
          // Never changed, and no existence oracle: firm A's id gets the same answer as an id nobody has. With a
          // valid body that answer is a denial; an empty body may fail validation first, the same way for both.
          if (build) expect(SAFE_DENIALS, label).toContain(res.status);
          else expect(res.status, label).toBeGreaterThanOrEqual(400);
          const nobody = await call(api, e.method, fill(e.path, NOBODY), nobodyBody);
          expect(res.status, `${label}; unknown id -> ${nobody.status}`).toBe(nobody.status);
        }
        const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        for (const word of kestrelNames) expect(text, `${label} leaks ${word}`).not.toContain(word);
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
      // No error is swallowed: a policy that refused instead of filtering would fail the test, not count as 0.
      try {
        const res = await client.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'firm' ? 'id' : 'firm_id'} = $1`,
          [owner],
        );
        return res.rows[0].n as number;
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
      const path = fill(e.path, name in UNMOUNTED ? NOBODY : ids.id);
      const res = await call(anon, e.method, path);
      const label = `${e.method} ${path} (${name}) -> ${res.status}`;
      if (name in UNMOUNTED) {
        // Not served yet: no route at all. Anything else means it shipped; take it off UNMOUNTED.
        expect(res.status, `${label}: now served, remove it from UNMOUNTED`).toBe(404);
      } else if (e.auth !== 'public') {
        // GETs: 401. Writes: 403 (no session means no CSRF match) or 401.
        expect([401, 403], label).toContain(res.status);
      }
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

import { ENDPOINTS, IsoFileSubjectType } from '@canopy/contracts';
import { systemContext, tenantSettings } from '@canopy/db';
import { expect, request, test } from '@playwright/test';
import pg from 'pg';

import { anonymousApi, apiAs, itemsOf } from './api.js';
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
  EICAR,
  databaseUrl,
  storageStateOf,
} from './stack.js';
import {
  BODIES,
  FILE_BODIES,
  FILE_SUBJECTS,
  FY,
  NOBODY,
  PDF,
  PROBE,
  SAFE_DENIALS,
  SWEEP_CHUNK,
  UNMOUNTED,
  call,
  endpoints,
  evidenceOf,
  fileKey,
  fill,
  firmAIds,
  isoOff,
  isoRecordsOf,
  probesOf,
  sweepable,
} from './sweep.js';

// Security review checks (docs/security/review.md) against the running API and database: tenant isolation for every
// endpoint, sessions and CSRF, evidence upload and download rules, and RLS for the app's own database login. The
// records and probes they use are in sweep.ts.

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
  enrollInviteMfa: 'public, takes a secret token, not an id',
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
  createSupportGrant: 'creates in the caller’s own account; names no record',
  ...UNMOUNTED,
};

test.afterAll(isoOff);

test.describe('tenant isolation', () => {
  test('every endpoint is either swept or listed with a reason', () => {
    for (const name of [
      ...Object.keys(UNMOUNTED),
      ...Object.keys(BODIES),
      ...Object.keys(FILE_BODIES),
    ])
      expect(ENDPOINTS, name).toHaveProperty(name);
    // A file probe on a record of every subject type the contract has.
    for (const type of IsoFileSubjectType.options)
      expect(
        FILE_SUBJECTS[type]?.length ?? 0,
        `files on ${type}: add a record to FILE_SUBJECTS`,
      ).toBeGreaterThan(0);
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
    const probes = endpoints
      .filter(([name, e]) => sweepable(name, e) && !(name in UNMOUNTED))
      .flatMap(([name, e]) => probesOf(name, e, ids).map((probe) => ({ probe, e })));
    for (const key of ['ospreyFirmAdmin', 'ospreyAdmin'] as const) {
      // Up to two calls a probe: a fresh address every SWEEP_CHUNK probes keeps each under the API's per-IP limit
      // (300 a minute), which 05-shell-load.spec.ts checks on its own.
      let api = await apiAs(key, 1);
      for (const [index, { probe, e }] of probes.entries()) {
        if (index > 0 && index % SWEEP_CHUNK === 0) {
          await api.dispose();
          api = await apiAs(key, 1 + index / SWEEP_CHUNK);
        }
        const { name, path } = probe;
        let res: { status: number; body: unknown };
        let label: string;
        if (e.method === 'GET' && !e.path.includes('{')) {
          // A firm-wide list holds firm B's records only.
          res = await api.get(path);
          label = `${key} GET ${path} (${name}) -> ${res.status}`;
          expect([200, 403], label).toContain(res.status);
        } else if (e.method === 'GET') {
          res = await api.get(path);
          label = `${key} GET ${path} (${name}) -> ${res.status}`;
          // A record in another firm is never shown: not found, or forbidden for the role.
          expect(SAFE_DENIALS, label).toContain(res.status);
        } else {
          if (probe.built && probe.body !== undefined) e.body!.parse(probe.body);
          res = await call(api, e.method, path, probe.body);
          label = `${key} ${e.method} ${path} (${name}) -> ${res.status}`;
          // Never changed, and no existence oracle: firm A's id gets the same answer as an id nobody has. With a
          // valid body that answer is a denial; an empty body may fail validation first, the same way for both.
          if (probe.built) expect(SAFE_DENIALS, label).toContain(res.status);
          else expect(res.status, label).toBeGreaterThanOrEqual(400);
          const nobody = await call(api, e.method, probe.nobodyPath, probe.nobodyBody);
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
    // pg-boss's rows carry every firm's ids and have no RLS, so from migration 0023 (ADR M3-0004) the tenant login
    // cannot reach them at all.
    const jobsRole = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'canopy_jobs'`);
    if (jobsRole.rowCount) {
      await expect(client.query('SELECT count(*) FROM pgboss.job')).rejects.toMatchObject({
        code: '42501',
      });
    }
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

test.describe('ISO files', () => {
  test('firm A lists, downloads once clean, and removes its own file on every ISO subject', async () => {
    test.setTimeout(240_000);
    const { clients, people } = seeded();
    const consultant = await apiAs('consultant');
    const records = await isoRecordsOf(consultant, clients.kestrel, {
      owner: people.owner,
      approver: people.approver,
    });
    await consultant.dispose();
    const admin = await apiAs('clientAdmin');
    const iso = `/clients/${clients.kestrel}/iso`;
    const subjects = (Object.entries(FILE_SUBJECTS) as [string, readonly string[]][]).flatMap(
      ([type, keys]) =>
        keys.map((key) => ({ type, key, id: records[key]!.id, file: records[fileKey(key)]!.id })),
    );
    type File = { id: string; scanStatus: string };
    const listed = async (s: (typeof subjects)[number], removed = false) => {
      const res = await admin.get(
        `${iso}/files?subjectType=${s.type}&subjectId=${s.id}${removed ? '&includeRemoved=true' : ''}`,
      );
      expect(res.status, `list on ${s.key}: ${JSON.stringify(res.body)}`).toBe(200);
      return itemsOf(res.body) as unknown as File[];
    };
    for (const s of subjects) {
      expect(
        (await listed(s)).map((f) => f.id),
        `files on ${s.key}`,
      ).toContain(s.file);
    }
    // PENDING until M9's scan job (once a minute) passes it. The job may pass the file before this request, so the
    // refusal is required only when the file is still PENDING after the request: it was PENDING when asked.
    const first = subjects[0]!;
    const early = await admin.get(`${iso}/files/${first.file}/download-url`);
    const stillPending = (await listed(first)).some(
      (f) => f.id === first.file && f.scanStatus === 'PENDING',
    );
    if (stillPending) {
      expect(early).toMatchObject({ status: 422, body: { error: { code: 'EVIDENCE_NOT_READY' } } });
    } else {
      expect([200, 422], JSON.stringify(early.body)).toContain(early.status);
    }
    await expect
      .poll(
        async () => {
          const states = new Set<string>();
          for (const s of subjects) {
            for (const f of await listed(s)) if (f.id === s.file) states.add(f.scanStatus);
          }
          return [...states];
        },
        { timeout: 200_000, intervals: [5_000] },
      )
      .toEqual(['CLEAN']);
    for (const s of subjects) {
      const link = await admin.get(`${iso}/files/${s.file}/download-url`);
      expect(link.status, `download on ${s.key}: ${JSON.stringify(link.body)}`).toBe(200);
      const { url } = link.body as { url: string };
      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300');
      const download = await admin.http.get(url);
      expect(download.status(), `stored file on ${s.key}`).toBe(200);
      expect(Buffer.from(await download.body()).equals(PDF)).toBe(true);
    }
    for (const s of subjects) {
      const removed = await admin.post(`${iso}/files/${s.file}/remove`, { reason: PROBE });
      expect(removed.status, `remove on ${s.key}: ${JSON.stringify(removed.body)}`).toBe(200);
      expect(
        (await listed(s)).map((f) => f.id),
        `files left on ${s.key}`,
      ).not.toContain(s.file);
      expect((await listed(s, true)).map((f) => f.id)).toContain(s.file);
    }
    await admin.dispose();
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

  test('a file is handed out only once the scan finds it clean, and the vault is per client', async () => {
    test.setTimeout(180_000);
    const { clients } = seeded();
    const admin = await apiAs('clientAdmin');
    const open = itemsOf(
      (await admin.get(`/clients/${clients.kestrel}/instances?${FY}&workflowState=OPEN&limit=1`))
        .body,
    )[0]!;
    const clean = await evidenceOf(open.id, 'challan.pdf');
    // EICAR's test string in a file with an accepted name and type: only the scan can catch it.
    const flagged = await evidenceOf(open.id, 'form-5a.pdf', Buffer.from(EICAR));
    // The scan job runs once a minute (M9), so a file just recorded is still PENDING and is not handed out.
    const early = await admin.get(`/evidence/${flagged}/download-url`);
    expect(early).toMatchObject({ status: 422, body: { error: { code: 'EVIDENCE_NOT_READY' } } });

    type File = { id: string; scanStatus: string };
    const statusOf = async () => {
      const vault = await admin.get(`/clients/${clients.kestrel}/evidence?limit=200`);
      expect(vault.status).toBe(200);
      // The vault never returns the storage key.
      expect(JSON.stringify(vault.body)).not.toContain('storageKey');
      const files = itemsOf(vault.body) as unknown as File[];
      return Object.fromEntries(files.map((f) => [f.id, f.scanStatus]));
    };
    await expect
      .poll(
        async () => {
          const status = await statusOf();
          return [status[clean], status[flagged]];
        },
        { timeout: 150_000, intervals: [5_000] },
      )
      .toEqual(['CLEAN', 'INFECTED']);

    const refused = await admin.get(`/evidence/${flagged}/download-url`);
    expect(refused).toMatchObject({ status: 422, body: { error: { code: 'EVIDENCE_NOT_READY' } } });
    const link = await admin.get(`/evidence/${clean}/download-url`);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const { url } = link.body as { url: string };
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300');
    const download = await admin.http.get(url);
    expect(download.status()).toBe(200);
    expect(Buffer.from(await download.body()).equals(PDF)).toBe(true);

    // The scan's verdicts and the download are on the instance's audit trail.
    const trail = await admin.get(`/instances/${open.id}/audit?limit=50`);
    expect(trail.status, JSON.stringify(trail.body)).toBe(200);
    const events = (
      trail.body as { items: { action: string; after: Record<string, unknown> | null }[] }
    ).items;
    for (const [evidenceId, scanStatus] of [
      [clean, 'CLEAN'],
      [flagged, 'INFECTED'],
    ])
      expect(events, `${scanStatus} verdict audited`).toContainEqual(
        expect.objectContaining({
          action: 'UPDATE',
          after: expect.objectContaining({ evidenceId, scanStatus }),
        }),
      );
    expect(events).toContainEqual(
      expect.objectContaining({ action: 'EVIDENCE_DOWNLOAD', after: { evidenceId: clean } }),
    );

    // Firm B's admin sees none of it.
    const osprey = await apiAs('ospreyAdmin');
    expect(SAFE_DENIALS).toContain(
      (await osprey.get(`/clients/${clients.kestrel}/evidence`)).status,
    );
    expect(SAFE_DENIALS).toContain((await osprey.get(`/evidence/${clean}/download-url`)).status);
    await osprey.dispose();
    await admin.dispose();
  });
});

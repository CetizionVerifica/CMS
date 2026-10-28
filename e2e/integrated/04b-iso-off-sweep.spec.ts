import { ISO_EXPORT_KINDS, type IsoExportKind } from '@canopy/contracts';
import { expect, test } from '@playwright/test';
import JSZip from 'jszip';

import { apiAs, type ApiSession } from './api.js';
import { OFF, checkPage, pageAs, seeded, shownAfterMeCache } from './helpers.js';
import { type AccountKey } from './stack.js';
import {
  ASSIGNMENT,
  FILE_SUBJECTS,
  PDF,
  PROBE,
  SWEEP_CHUNK,
  UNMOUNTED,
  call,
  endpoints,
  evidenceOf,
  fileKey,
  firmAIds,
  isoOff,
  isoOn,
  probesOf,
  sweepable,
  type Endpoint,
  type Ids,
  type Probe,
} from './sweep.js';

// The ISO add-on's off switch against the real stack (docs/iso/packages.md ISO-13b, plan §7 item 3). With the add-on on,
// firm A gets an ISO record of every kind with a file on each, a STANDARD activity from the copied catalogue assigned to
// a unit with the instances M9 generates for it, evidence on one of them, and an export of each ISO kind. Then the
// add-on goes off: every ISO route answers 403, every endpoint that names one of those fixtures refuses it or leaves it
// out, the lists hide them, the bulk routes refuse each ISO item, the ISO exports are refused, every ISO screen says it is
// not turned on, while the client audit trail and the client archive still hold the ISO data. Turned back on, the same
// data shows and each export downloads again.
//
// It switches the add-on with sweep.ts's account override (`isoOn`, `isoOff`), which the API reads on every request,
// and leaves none behind. It runs after 04-security, whose `isoOn` refuses a firm that already has one.

const FEATURE_NOT_ENABLED = 'FEATURE_NOT_ENABLED';
/** The STANDARD activity the sweep assigns: annual, due 30 April, so each financial year has one instance. */
const ACTIVITY = 'Review of context and interested parties';
const EVIDENCE = 'context-review.pdf';
const OFF_TITLE = 'Not turned on · Kestrel Metals Group · PlanetPulse Compliance';

type Rec = { id: string; version: number };
type Instance = Rec & { dueDate: string; workflowState: string };

/** Today in the client's time zone (Asia/Kolkata, the default). */
const clientToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

/**
 * How long before the client's midnight the snapshot waits for the next day. Some ISO reads are worked out against
 * today (what is overdue, days left), so a snapshot taken before midnight and compared after it can differ with no
 * data changed. The tests between the snapshot and the comparison take a few minutes; this leaves room to spare.
 */
const MIDNIGHT_MARGIN_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
/** Asia/Kolkata is UTC+05:30 all year. */
const KOLKATA_OFFSET_MS = 19_800_000;

/** Waits for the client's next day when its midnight is under `MIDNIGHT_MARGIN_MS` away. */
async function clearOfClientMidnight(): Promise<void> {
  const untilMidnight = DAY_MS - ((Date.now() + KOLKATA_OFFSET_MS) % DAY_MS);
  if (untilMidnight < MIDNIGHT_MARGIN_MS) {
    await new Promise((resolve) => setTimeout(resolve, untilMidnight + 5_000));
  }
}

/** Every id in a read's answer. */
const idsIn = (text: string) =>
  new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []);

/** A list the add-on hides from: who reads it, where, and which fixtures it shows while the add-on is on. */
type ListCheck = { name: string; key: AccountKey; path: string; shows: string[] };

/** What the first test makes with the add-on on, for the rest. */
const made: {
  ids?: Ids;
  /** Every id that names an ISO fixture: ISO records and files, the STANDARD act, obligation, assignment, instances, evidence. */
  iso?: string[];
  act?: Rec;
  obligation?: Rec;
  assignment?: Rec;
  /** The earlier instance, submitted with the evidence on it; the later one stays open. */
  submitted?: Instance;
  open?: Instance;
  evidence?: string;
  exports?: Record<IsoExportKind, string>;
  lists?: ListCheck[];
  /** Each ISO read's answer with the add-on on, by path. */
  snapshot?: Map<string, string>;
  /** The client's day when the snapshot was taken. */
  snapshotDay?: string;
} = {};

/** The API as `key` from a fresh address (stack.ts `addressOf`), so one test's calls stay under the per-IP limits. */
let addresses = 10;
const fresh = (key: AccountKey) => apiAs(key, addresses++);

/** Every page of a list, as one string of their bodies. */
async function allPages(api: ApiSession, path: string): Promise<{ status: number; text: string }> {
  let text = '';
  let cursor: string | null = null;
  do {
    const res = await api.get(
      cursor === null ? path : `${path}&cursor=${encodeURIComponent(cursor)}`,
    );
    if (res.status !== 200) return { status: res.status, text: JSON.stringify(res.body) };
    text += JSON.stringify(res.body);
    cursor = (res.body as { nextCursor?: string | null }).nextCursor ?? null;
  } while (cursor !== null);
  return { status: 200, text };
}

const parsed = (body: unknown): unknown => {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
};
const codeOf = (body: unknown) =>
  (parsed(body) as { error?: { code?: string } } | null)?.error?.code;

/** Every probe of the sweep, with the endpoint it calls, for firm A's ids with the ISO fixtures in place. */
function probes(ids: Ids): { probe: Probe; e: Endpoint; name: string }[] {
  return endpoints
    .filter(([name, e]) => sweepable(name, e) && !(name in UNMOUNTED))
    .flatMap(([name, e]) => probesOf(name, e, ids).map((probe) => ({ probe, e, name })));
}

const names = (probe: Probe, iso: readonly string[]) => {
  const text = `${probe.path} ${JSON.stringify(probe.body ?? null)}`;
  return iso.some((id) => text.includes(id));
};

/** The ISO reads whose answers must be the same after the add-on comes back on: every GET that names a fixture. */
const reads = (ids: Ids, iso: readonly string[]) =>
  probes(ids).filter(
    ({ probe, e }) =>
      e.method === 'GET' &&
      !probe.path.endsWith('/download-url') &&
      ('feature' in e || names(probe, iso)),
  );

test.describe.serial('the ISO add-on turned off and on again', () => {
  test.afterAll(isoOff);

  test('with the add-on on, firm A has ISO records with files, a STANDARD instance with evidence, and each ISO export', async () => {
    test.setTimeout(420_000 + MIDNIGHT_MARGIN_MS);
    const { clients } = seeded();
    // An ISO record of every kind with a file on each, made with the add-on on (sweep.ts `isoOn`).
    const ids = await firmAIds();
    const consultant = await fresh('consultant');
    const ok = async (res: Promise<{ status: number; body: unknown }>, status = 200) => {
      const { status: got, body } = await res;
      expect(got, JSON.stringify(body)).toBe(status);
      return body;
    };

    // A STANDARD activity from the copied catalogue, assigned to firm A's unit; M9 generates its instances.
    const acts = (await ok(consultant.get('/library/acts?limit=200'))) as {
      items: (Rec & { kind?: string; shortName: string | null })[];
    };
    const act = acts.items.find((a) => a.kind === 'STANDARD' && a.shortName === 'ISO IMS');
    if (!act) throw new Error('no ISO IMS act in the copied catalogue');
    const obligations = (await ok(
      consultant.get(`/library/obligations?actId=${act.id}&limit=200`),
    )) as { items: (Rec & { title: string })[] };
    const obligation = obligations.items.find((o) => o.title === ACTIVITY)!;
    expect(obligation, `${ACTIVITY} under ISO IMS`).toBeTruthy();
    const assignment = (await ok(
      consultant.post(`/clients/${clients.kestrel}/assignments`, {
        ...ASSIGNMENT(ids.id),
        obligationId: obligation.id,
      }),
      201,
    )) as Rec;
    let instances: Instance[] = [];
    await expect
      .poll(
        async () => {
          const res = await consultant.get(
            `/clients/${clients.kestrel}/instances?actId=${act.id}&limit=50`,
          );
          instances = ((res.body as { items?: Instance[] }).items ?? []).sort((a, b) =>
            a.dueDate.localeCompare(b.dueDate),
          );
          return instances.length;
        },
        { timeout: 60_000, intervals: [1_000, 2_000] },
      )
      .toBeGreaterThanOrEqual(2);
    const [first, open] = [instances[0]!, instances.at(-1)!];

    // Evidence on the earlier instance, scanned CLEAN, then submitted by its owner so it waits for its approver.
    const evidence = await evidenceOf(first.id, EVIDENCE);
    await expect
      .poll(
        async () => {
          const res = await consultant.get(`/instances/${first.id}/evidence`);
          const items = (res.body as { items?: { id: string; scanStatus: string }[] }).items;
          return items?.find((f) => f.id === evidence)?.scanStatus;
        },
        { timeout: 150_000, intervals: [5_000] },
      )
      .toBe('CLEAN');
    const owner = await fresh('owner');
    const detail = (await ok(owner.get(`/instances/${first.id}`))) as Rec;
    const submitted = (await ok(
      owner.post(`/instances/${first.id}/submit`, {
        version: detail.version,
        completedOn: clientToday(),
        comment: PROBE,
      }),
    )) as Instance;
    await owner.dispose();

    // Every ISO file scanned CLEAN, so the archive holds them and the reads do not change under the sweep.
    const files = (Object.entries(FILE_SUBJECTS) as [string, readonly string[]][]).flatMap(
      ([type, keys]) =>
        keys.map((key) => ({ type, subject: ids.id[key]!, file: ids.id[fileKey(key)]! })),
    );
    const iso = `/clients/${clients.kestrel}/iso`;
    await expect
      .poll(
        async () => {
          const states = new Set<string>();
          for (const f of files) {
            const res = await consultant.get(
              `${iso}/files?subjectType=${f.type}&subjectId=${f.subject}`,
            );
            const items = (res.body as { items?: { id: string; scanStatus: string }[] }).items;
            states.add(items?.find((i) => i.id === f.file)?.scanStatus ?? `missing ${res.status}`);
          }
          return [...states];
        },
        { timeout: 200_000, intervals: [5_000] },
      )
      .toEqual(['CLEAN']);
    await consultant.dispose();

    // One export of each ISO kind, run to DONE while the add-on is on (a job that ran while it was off would fail).
    const exporter = await fresh('consultant');
    const filters: Record<IsoExportKind, string> = {
      ISO_NC_LOG_XLSX: `managementSystemId=${ids.id.systems}`,
      ISO_RISK_REGISTER_XLSX: `managementSystemId=${ids.id.systems}`,
      ISO_AUDIT_REPORT_PDF: `internalAuditId=${ids.id['internal-audits']}`,
      ISO_REVIEW_PACK_PDF: `managementReviewId=${ids.id['management-reviews']}`,
    };
    const exports = {} as Record<IsoExportKind, string>;
    for (const kind of ISO_EXPORT_KINDS) {
      const job = (await ok(
        exporter.post(`/clients/${clients.kestrel}/exports`, { kind, filters: filters[kind] }),
        202,
      )) as Rec;
      exports[kind] = job.id;
    }
    for (const kind of ISO_EXPORT_KINDS) {
      await expect
        .poll(
          async () =>
            ((await exporter.get(`/exports/${exports[kind]}`)).body as { status?: string }).status,
          { message: kind, timeout: 120_000, intervals: [1_000, 2_000] },
        )
        .toBe('DONE');
    }
    await exporter.dispose();

    // The fixtures in place of firm A's statutory ones, so the probes name them.
    ids.id.acts = act.id;
    ids.v.acts = act.version;
    ids.id.obligations = obligation.id;
    ids.v.obligations = obligation.version;
    ids.id.assignments = assignment.id;
    ids.v.assignments = assignment.version;
    ids.id.instances = submitted.id;
    ids.v.instances = submitted.version;
    ids.id.evidence = evidence;
    made.ids = ids;
    made.iso = [
      ...ids.isoKeys.map((key) => ids.id[key]!),
      act.id,
      obligation.id,
      assignment.id,
      submitted.id,
      open.id,
      evidence,
    ];
    Object.assign(made, { act, obligation, assignment, submitted, open, evidence, exports });

    // The lists the add-on hides ISO items from (plan §7 item 3), each showing its fixtures while it is on.
    made.lists = [
      { name: 'library acts', key: 'consultant', path: '/library/acts?limit=200', shows: [act.id] },
      {
        name: 'library obligations',
        key: 'consultant',
        path: `/library/obligations?actId=${act.id}&limit=200`,
        shows: [obligation.id],
      },
      {
        name: 'assignments',
        key: 'consultant',
        path: `/clients/${clients.kestrel}/assignments?obligationId=${obligation.id}&limit=200`,
        shows: [assignment.id],
      },
      {
        name: 'instances',
        key: 'consultant',
        path: `/clients/${clients.kestrel}/instances?limit=200`,
        shows: [submitted.id, open.id],
      },
      {
        name: 'my approvals',
        key: 'approver',
        path: '/me/approvals?limit=200',
        shows: [submitted.id],
      },
      { name: 'my tasks', key: 'owner', path: '/me/tasks?limit=200', shows: [open.id] },
      {
        name: 'evidence vault',
        key: 'consultant',
        path: `/clients/${clients.kestrel}/evidence?limit=200`,
        shows: [evidence],
      },
      {
        name: 'calendar',
        key: 'consultant',
        path: `/clients/${clients.kestrel}/calendar?from=${open.dueDate}&to=${open.dueDate}`,
        shows: [open.id],
      },
    ];
    for (const list of made.lists) {
      const api = await fresh(list.key);
      const { status, text } = await allPages(api, list.path);
      expect(status, `${list.name}: ${text}`).toBe(200);
      for (const id of list.shows) expect(text, `${list.name} shows ${id} while on`).toContain(id);
      await api.dispose();
    }

    // Each ISO read's answer while on, to compare once the add-on is back, taken on a day the comparison shares.
    await clearOfClientMidnight();
    made.snapshotDay = clientToday();
    made.snapshot = new Map();
    let api = await fresh('consultant');
    for (const [index, { probe }] of reads(ids, made.iso).entries()) {
      if (index > 0 && index % SWEEP_CHUNK === 0) {
        await api.dispose();
        api = await fresh('consultant');
      }
      const res = await api.get(probe.path);
      expect(res.status, `${probe.name} GET ${probe.path}: ${JSON.stringify(res.body)}`).toBe(200);
      made.snapshot.set(probe.path, JSON.stringify(res.body));
    }
    await api.dispose();
  });

  test('turned off, every ISO route answers 403 and every endpoint that names an ISO fixture refuses it', async () => {
    test.setTimeout(240_000);
    const { ids, iso } = made as Required<typeof made>;
    await isoOff();
    const swept = probes(ids).filter(({ e, probe }) => 'feature' in e || names(probe, iso));
    // The bulk routes answer 200 and refuse each item; the next test checks them.
    const bulk = new Set(['bulkApprove', 'bulkCreateAssignments']);
    let api = await fresh('consultant');
    let count = 0;
    for (const { probe, e, name } of swept) {
      if (bulk.has(name)) continue;
      if (count > 0 && count % SWEEP_CHUNK === 0) {
        await api.dispose();
        api = await fresh('consultant');
      }
      count += 1;
      if (e.method !== 'GET' && probe.built && probe.body !== undefined) e.body!.parse(probe.body);
      const res = await call(api, e.method, probe.path, probe.body);
      const label = `${e.method} ${probe.path} (${probe.name}) -> ${res.status} ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`;
      expect(res.status, label).toBe(403);
      expect(codeOf(res.body), label).toBe(FEATURE_NOT_ENABLED);
    }
    await api.dispose();
    // Every ISO route the API serves, and at least one endpoint of every other kind that names a fixture.
    expect(count).toBeGreaterThan(swept.filter(({ e }) => 'feature' in e).length);
  });

  test('turned off, the lists hide every ISO item, the bulk routes refuse each, and the ISO exports are refused', async () => {
    test.setTimeout(180_000);
    const { clients } = seeded();
    const { ids, iso, lists, submitted, obligation, exports } = made as Required<typeof made>;
    for (const list of lists) {
      const api = await fresh(list.key);
      const { status, text } = await allPages(api, list.path);
      expect(status, `${list.name}: ${text}`).toBe(200);
      for (const id of iso) expect(text, `${list.name} hides ${id} while off`).not.toContain(id);
      await api.dispose();
    }

    const approver = await fresh('approver');
    const approved = await approver.post(`/clients/${clients.kestrel}/instances/bulk-approve`, {
      items: [{ id: submitted.id, version: submitted.version }],
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((approved.body as { results: unknown[] }).results).toEqual([
      expect.objectContaining({
        id: submitted.id,
        ok: false,
        error: expect.objectContaining({ code: FEATURE_NOT_ENABLED }),
      }),
    ]);
    await approver.dispose();
    const consultant = await fresh('consultant');
    const assigned = await consultant.post(`/clients/${clients.kestrel}/assignments/bulk`, {
      items: [{ ...ASSIGNMENT(ids.id), obligationId: obligation.id }],
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect((assigned.body as { results: unknown[] }).results).toEqual([
      expect.objectContaining({
        index: 0,
        ok: false,
        error: expect.objectContaining({ code: FEATURE_NOT_ENABLED }),
      }),
    ]);

    // Each ISO kind: a create with its kind's filters, and the job its requester made while on, and its download.
    const filters: Record<IsoExportKind, string> = {
      ISO_NC_LOG_XLSX: `managementSystemId=${ids.id.systems}`,
      ISO_RISK_REGISTER_XLSX: `managementSystemId=${ids.id.systems}`,
      ISO_AUDIT_REPORT_PDF: `internalAuditId=${ids.id['internal-audits']}`,
      ISO_REVIEW_PACK_PDF: `managementReviewId=${ids.id['management-reviews']}`,
    };
    for (const kind of ISO_EXPORT_KINDS) {
      for (const res of [
        await consultant.post(`/clients/${clients.kestrel}/exports`, {
          kind,
          filters: filters[kind],
        }),
        await consultant.get(`/exports/${exports[kind]}`),
        await consultant.get(`/exports/${exports[kind]}/download-url`),
      ]) {
        expect(res, kind).toMatchObject({
          status: 403,
          body: { error: { code: FEATURE_NOT_ENABLED } },
        });
      }
    }
    await consultant.dispose();
  });

  test('turned off, every ISO screen says it is not turned on', async ({ browser }) => {
    test.setTimeout(600_000);
    const { clients } = seeded();
    const { ids } = made as Required<typeof made>;
    const page = await pageAs(browser, 'clientAdmin');
    const record: Record<string, string> = {
      documents: ids.id.documents!,
      risks: ids.id.risks!,
      objectives: ids.id.objectives!,
      audits: ids.id['internal-audits']!,
      nonconformities: ids.id.nonconformities!,
      'management-reviews': ids.id['management-reviews']!,
    };
    const screens = [
      'overview',
      'checklist',
      'actions',
      'certification',
      ...Object.entries(record).flatMap(([list, id]) => [list, `${list}/${id}`]),
    ];
    expect(screens).toHaveLength(16);
    for (const path of screens) {
      // The shell sets the title once the page's h1 settles (up to 10 s), and the add-ons trail the switch by the web
      // app's Me cache, so the heading and the title are retried together, as 03a does.
      await shownAfterMeCache(page, `/c/${clients.kestrel}/iso/${path}`, async () => {
        await expect(page.getByRole('heading', { name: OFF }), path).toBeVisible();
        await expect(page, path).toHaveTitle(OFF_TITLE, { timeout: 10_000 });
      });
      await expect(page.getByRole('table')).toHaveCount(0);
      await checkPage(page);
    }
    // The client's own overview, which leaves ISO out while it is off.
    await page.goto(`/c/${clients.kestrel}/overview`);
    await expect(page).toHaveTitle(/PlanetPulse Compliance$/);
    await checkPage(page);
    await page.context().close();
  });

  test('turned off, the client audit trail still lists ISO events, and the client archive holds the ISO data', async () => {
    test.setTimeout(240_000);
    const { clients } = seeded();
    const { ids, submitted } = made as Required<typeof made>;
    const consultant = await fresh('consultant');
    // The client trail is not gated; the STANDARD instance's own trail is.
    const trail = await consultant.get(
      `/clients/${clients.kestrel}/audit?entityType=nonconformity&entityId=${ids.id.nonconformities}&limit=50`,
    );
    expect(trail.status, JSON.stringify(trail.body)).toBe(200);
    expect((trail.body as { items: { action: string }[] }).items.map((e) => e.action)).toContain(
      'EVIDENCE_ADD',
    );
    expect(await consultant.get(`/instances/${submitted.id}/audit`)).toMatchObject({
      status: 403,
      body: { error: { code: FEATURE_NOT_ENABLED } },
    });
    await consultant.dispose();

    // The account admin's archive of the whole client, made while the add-on is off.
    const admin = await fresh('firmAdmin');
    const job = await admin.post(`/clients/${clients.kestrel}/exports`, {
      kind: 'CLIENT_ARCHIVE_ZIP',
      filters: '',
    });
    expect(job.status, JSON.stringify(job.body)).toBe(202);
    const id = (job.body as Rec).id;
    await expect
      .poll(async () => ((await admin.get(`/exports/${id}`)).body as { status?: string }).status, {
        timeout: 180_000,
        intervals: [2_000],
      })
      .toBe('DONE');
    const link = await admin.get(`/exports/${id}/download-url`);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const download = await admin.http.get((link.body as { url: string }).url);
    expect(download.status()).toBe(200);
    const zip = await JSZip.loadAsync(await download.body());
    await admin.dispose();
    const text = async (path: string) => {
      const entry = zip.file(path);
      expect(entry, `${path} in the archive`).not.toBeNull();
      return entry!.async('string');
    };
    for (const path of ['iso/nc-log.xlsx', 'iso/risk-register.xlsx', 'iso/records.xlsx'])
      expect(zip.file(path), `${path} in the archive`).not.toBeNull();
    expect(await text('README.txt')).toMatch(/^ISO files included: [1-9]\d*\.\r?$/m);

    // An ISO file scanned CLEAN before the switch-off: listed in iso/index.csv, at iso/<subject type>/<subject id>/.
    const nc = ids.id.nonconformities!;
    const isoPath = `nonconformity/${nc}/record.pdf`;
    expect((await text('iso/index.csv')).split(/\r?\n/)).toContainEqual(
      expect.stringMatching(new RegExp(`^${isoPath},nonconformity,${nc},`)),
    );
    const isoFile = zip.file(`iso/${isoPath}`);
    expect(isoFile, `iso/${isoPath} in the archive`).not.toBeNull();
    expect(Buffer.from(await isoFile!.async('uint8array')).equals(PDF)).toBe(true);

    // The STANDARD instance's evidence, listed under its obligation's title, at evidence/ plus the path the index gives.
    const rows = (await text('evidence/index.csv')).split(/\r?\n/);
    const row = rows.find((r) => r.includes(ACTIVITY) && r.includes(EVIDENCE));
    expect(row, `${EVIDENCE} under ${ACTIVITY} in evidence/index.csv`).toBeTruthy();
    const path = row!.split(',')[0]!;
    expect(row!.split(',')[1]).toBe(ACTIVITY);
    const evidenceFile = zip.file(`evidence/${path}`);
    expect(evidenceFile, `evidence/${path} in the archive`).not.toBeNull();
    expect(Buffer.from(await evidenceFile!.async('uint8array')).equals(PDF)).toBe(true);
  });

  test('turned back on, the same data shows and each ISO export downloads again', async () => {
    test.setTimeout(240_000);
    const { ids, iso, lists, snapshot, snapshotDay, exports } = made as Required<typeof made>;
    await isoOn();
    // Past the client's midnight, answers worked out against today may differ, so they must still hold every id.
    const sameDay = clientToday() === snapshotDay;
    let api = await fresh('consultant');
    for (const [index, { probe }] of reads(ids, iso).entries()) {
      if (index > 0 && index % SWEEP_CHUNK === 0) {
        await api.dispose();
        api = await fresh('consultant');
      }
      const res = await api.get(probe.path);
      expect(res.status, `${probe.name} GET ${probe.path}: ${JSON.stringify(res.body)}`).toBe(200);
      const before = snapshot.get(probe.path) ?? '';
      if (sameDay) {
        expect(JSON.stringify(res.body), `${probe.name} GET ${probe.path}`).toBe(before);
      } else {
        const after = idsIn(JSON.stringify(res.body));
        for (const id of idsIn(before)) {
          expect(after.has(id), `${probe.name} GET ${probe.path} still shows ${id}`).toBe(true);
        }
      }
    }
    for (const kind of ISO_EXPORT_KINDS) {
      const link = await api.get(`/exports/${exports[kind]}/download-url`);
      expect(link.status, `${kind}: ${JSON.stringify(link.body)}`).toBe(200);
      const download = await api.http.get((link.body as { url: string }).url);
      expect(download.status(), kind).toBe(200);
    }
    await api.dispose();
    for (const list of lists) {
      const reader = await fresh(list.key);
      const { status, text } = await allPages(reader, list.path);
      expect(status, `${list.name}: ${text}`).toBe(200);
      for (const id of list.shows) expect(text, `${list.name} shows ${id} again`).toContain(id);
      await reader.dispose();
    }
  });
});

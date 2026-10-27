import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ExportJob } from '@canopy/contracts';
import { PutObjectCommand, S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { accountView } from '../../auth/testing.js';
import { createWorld } from '../dashboard/testing/world.js';
import { clientArchive, safeFileName } from './archive.js';
import { partsOf, PART_BYTES, S3ExportFiles } from './files.js';

const w = createWorld();
afterAll(() => w.app.close());
afterEach(() => vi.restoreAllMocks());

const ctx = { firmId: w.firmId } as Parameters<typeof w.store.exportStorageKey>[0];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const NO_ISO = {
  ncLog: new Uint8Array([1]),
  riskRegister: new Uint8Array([1]),
  records: new Uint8Array([1]),
  files: [],
  withheld: 0,
};

/** Stores an evidence row and (unless `stored` is false) its file under `evidence/`. */
function evidence(
  instanceId: string,
  fileName: string,
  body: string,
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED' = 'CLEAN',
  stored = true,
) {
  const id = randomUUID();
  const storageKey = `evidence/${w.firmId}/${w.clientId}/${id}`;
  w.store.evidence.push({
    id,
    firmId: w.firmId,
    clientId: w.clientId,
    instanceId,
    fileName,
    sizeBytes: body.length,
    sha256: sha(body),
    uploadedAt: `2026-10-0${w.store.evidence.length + 1}T05:00:00.000Z`,
    storageKey,
    scanStatus,
  });
  if (stored)
    w.files.files.set(storageKey, { bytes: Buffer.from(body), contentType: 'text/plain' });
}

async function archiveOf(headers: Record<string, string>) {
  const res = await w.app.inject({
    method: 'POST',
    url: `/api/v1/clients/${w.clientId}/exports`,
    headers,
    payload: { kind: 'CLIENT_ARCHIVE_ZIP' },
  });
  expect(res.statusCode, res.body).toBe(202);
  await w.runner.idle();
  const job = ExportJob.parse(
    (await w.app.inject({ url: `/api/v1/exports/${res.json().id}`, headers })).json(),
  );
  expect(job.status).toBe('DONE');
  const key = await w.store.exportStorageKey(ctx, job.id);
  const file = w.files.files.get(key!)!;
  expect(file.contentType).toBe('application/zip');
  return { job, zip: await JSZip.loadAsync(file.bytes) };
}

describe('the client archive', () => {
  it('holds the whole register, each clean evidence file under its item, an index and a README', async () => {
    const mine = w.store.rows.filter((r) => r.clientId === w.clientId);
    const [first, second] = mine;
    evidence(first!.id, 'challan.pdf', 'paid on time');
    evidence(first!.id, 'challan.pdf', 'the revised one');
    evidence(second!.id, '../../etc/passwd', 'not a path');
    evidence(second!.id, 'scan.pdf', 'not scanned yet', 'PENDING');
    evidence(second!.id, 'virus.exe', 'bad', 'INFECTED');
    evidence(second!.id, 'lost.pdf', 'gone', 'CLEAN', false);

    const { job, zip } = await archiveOf(w.as('FIRM_ADMIN').headers);
    expect(job.fileName).toBe('client-archive-beta-group-2026-10-12.zip');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await zip.file('register.xlsx')!.async('arraybuffer')) as ArrayBuffer,
    );
    // Every instance of the client, all dates: the header row plus one per instance.
    expect(workbook.worksheets[0]!.rowCount).toBe(mine.length + 1);

    const folder = (r: (typeof mine)[number]) =>
      `evidence/${r.dueDate} ${r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const files = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
    const evidenceFiles = files.filter(
      (n) => n.startsWith('evidence/') && !n.endsWith('index.csv'),
    );
    expect(evidenceFiles).toHaveLength(3);
    const challans = evidenceFiles.filter((n) => n.startsWith(folder(first!)));
    expect(challans.map((n) => n.split('/').at(-1)).sort()).toEqual([
      '2 challan.pdf',
      'challan.pdf',
    ]);
    expect(await zip.file(challans.find((n) => n.endsWith('/challan.pdf'))!)!.async('string')).toBe(
      'paid on time',
    );
    // A name cannot climb out of its folder.
    expect(evidenceFiles.some((n) => n.endsWith('/_.._etc_passwd'))).toBe(true);
    expect(files.every((n) => n.split('/').every((part) => part !== '..' && part !== ''))).toBe(
      true,
    );

    const index = (await zip.file('evidence/index.csv')!.async('string')).trim().split('\r\n');
    expect(index).toHaveLength(4);
    expect(index[0]).toBe('File,Obligation,Unit,Due date,Uploaded at,Size (bytes),SHA-256');
    expect(index.some((line) => line.endsWith(sha('paid on time')))).toBe(true);

    const readme = await zip.file('README.txt')!.async('string');
    expect(readme).toContain('archive of Beta Group');
    expect(readme).toContain('Evidence files included: 3.');
    expect(readme).toContain('Left out: 2 file(s)');
    expect(readme).toContain('Not found in storage: 1 file(s)');
  });

  it('is for account admins only, takes no filters, and never for a support session', async () => {
    for (const role of ['CONSULTANT', 'CLIENT_ADMIN', 'APPROVER', 'OWNER', 'VIEWER'] as const) {
      const res = await w.app.inject({
        method: 'POST',
        url: `/api/v1/clients/${w.clientId}/exports`,
        headers: w.as(role).headers,
        payload: { kind: 'CLIENT_ARCHIVE_ZIP' },
      });
      expect([res.statusCode, res.json().error.code], role).toEqual([403, 'FORBIDDEN']);
    }
    const filtered = await w.app.inject({
      method: 'POST',
      url: `/api/v1/clients/${w.clientId}/exports`,
      headers: w.as('FIRM_ADMIN').headers,
      payload: { kind: 'CLIENT_ARCHIVE_ZIP', fy: '2026-27' },
    });
    expect(filtered.statusCode).toBe(400);

    const support = w.as('FIRM_ADMIN');
    const grantId = randomUUID();
    w.auth.store.supportGrants.set(grantId, { endsAt: '2099-01-01T00:00:00Z', revoked: false });
    const [hash, session] = [...w.auth.store.sessions].find(
      ([, s]) => s.personId === support.personId,
    )!;
    w.auth.store.sessions.set(hash, { ...session, supportGrantId: grantId });
    const res = await w.app.inject({
      method: 'POST',
      url: `/api/v1/clients/${w.clientId}/exports`,
      headers: support.headers,
      payload: { kind: 'CLIENT_ARCHIVE_ZIP' },
    });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'FORBIDDEN']);
  });

  it('can be taken and downloaded by an account admin while the account is closing', async () => {
    const closing = createWorld();
    try {
      closing.auth.store.accounts.set(
        closing.firmId,
        accountView(closing.firmId, { status: 'PENDING_DELETION' }),
      );
      const { headers } = closing.as('FIRM_ADMIN');
      const res = await closing.app.inject({
        method: 'POST',
        url: `/api/v1/clients/${closing.clientId}/exports`,
        headers,
        payload: { kind: 'CLIENT_ARCHIVE_ZIP' },
      });
      expect(res.statusCode, res.body).toBe(202);
      await closing.runner.idle();
      const id = res.json().id as string;
      expect((await closing.app.inject({ url: `/api/v1/exports/${id}`, headers })).statusCode).toBe(
        200,
      );
      const link = await closing.app.inject({ url: `/api/v1/exports/${id}/download-url`, headers });
      expect(link.statusCode).toBe(200);
      // Everything else stays shut.
      const overview = await closing.app.inject({
        url: `/api/v1/clients/${closing.clientId}/overview`,
        headers,
      });
      expect(overview.json().error.code).toBe('ACCOUNT_SUSPENDED');
    } finally {
      await closing.app.close();
    }
  });
});

describe('archive parts', () => {
  it('keeps file names inside their folder and short', () => {
    expect(safeFileName('a/b\\c:d')).toBe('a_b_c_d');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('  .hidden')).toBe('hidden');
    const long = safeFileName(`${'x'.repeat(200)}.pdf`);
    expect(long).toHaveLength(150);
    expect(long.endsWith('.pdf')).toBe(true);
    // Control characters become underscores; a long name with no short extension is cut at 150.
    expect(safeFileName('a\u0000b\u001fc\u007f.pdf')).toBe('a_b_c_.pdf');
    expect(safeFileName('y'.repeat(200))).toBe('y'.repeat(150));
    expect(safeFileName(`${'z'.repeat(200)}.averylongextension`)).toBe('z'.repeat(150));
  });

  it('files evidence of an unknown item under other/ and keeps index cells inert', async () => {
    const file = (fileName: string, body: string) => ({
      id: randomUUID(),
      instanceId: randomUUID(),
      fileName,
      sizeBytes: body.length,
      sha256: sha(body),
      uploadedAt: '2026-10-01T00:00:00.000Z',
      storageKey: `evidence/${fileName}`,
    });
    const known = file('known.pdf', 'k');
    const archive = clientArchive({
      clientName: 'Kestrel Metals Group',
      register: new Uint8Array([1]),
      evidence: [file('orphan.pdf', 'o'), known],
      withheld: 0,
      iso: NO_ISO,
      instances: new Map([
        [
          known.instanceId,
          { dueDate: '2026-11-15', title: '=HYPERLINK("x")', unitName: 'Riverbend, "North"' },
        ],
      ]),
      open: async (key) => Readable.from([Buffer.from(key)]),
      generatedAt: '2026-10-12T00:00:00.000Z',
    });
    const chunks: Buffer[] = [];
    for await (const chunk of archive) chunks.push(chunk as Buffer);
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(zip.file('evidence/other/orphan.pdf')).not.toBeNull();
    const index = (await zip.file('evidence/index.csv')!.async('string')).trim().split('\r\n');
    // An unknown item leaves its columns empty.
    expect(index[1]).toMatch(/^other\/orphan\.pdf,,,,2026-10-01T00:00:00\.000Z,1,/);
    // A formula is prefixed with ' and a cell with a comma or quote is quoted.
    expect(index[2]).toContain(`,"'=HYPERLINK(""x"")","Riverbend, ""North""",2026-11-15,`);
    const readme = await zip.file('README.txt')!.async('string');
    expect(readme).toContain('Evidence files included: 2.');
    expect(readme).not.toContain('Left out');
    expect(readme).not.toContain('Not found');
  });

  it('fails the stream when a file cannot be read', async () => {
    const archive = clientArchive({
      clientName: 'Kestrel Metals Group',
      register: new Uint8Array([1]),
      evidence: [
        {
          id: randomUUID(),
          instanceId: randomUUID(),
          fileName: 'a.pdf',
          sizeBytes: 1,
          sha256: sha('a'),
          uploadedAt: '2026-10-01T00:00:00.000Z',
          storageKey: 'evidence/a',
        },
      ],
      withheld: 0,
      iso: NO_ISO,
      instances: new Map(),
      open: async () => {
        throw new Error('storage down');
      },
      generatedAt: '2026-10-12T00:00:00.000Z',
    });
    await expect(
      (async () => {
        for await (const _ of archive) void _;
      })(),
    ).rejects.toThrow('storage down');
  });

  it('fails the stream with a plain error when the read throws something that is not an Error', async () => {
    const archive = clientArchive({
      clientName: 'Kestrel Metals Group',
      register: new Uint8Array([1]),
      evidence: [
        {
          id: randomUUID(),
          instanceId: randomUUID(),
          fileName: 'a.pdf',
          sizeBytes: 1,
          sha256: sha('a'),
          uploadedAt: '2026-10-01T00:00:00.000Z',
          storageKey: 'evidence/a',
        },
      ],
      withheld: 0,
      iso: NO_ISO,
      instances: new Map(),
      open: async () => {
        throw 'storage down';
      },
      generatedAt: '2026-10-12T00:00:00.000Z',
    });
    await expect(
      (async () => {
        for await (const _ of archive) void _;
      })(),
    ).rejects.toThrow(/^archive$/);
  });

  it('cuts a stream into parts of the given size', async () => {
    const chunks = [Buffer.from('abc'), Buffer.from('defgh'), Buffer.from('i')];
    const parts: string[] = [];
    for await (const part of partsOf(Readable.from(chunks), 4)) parts.push(part.toString());
    expect(parts).toEqual(['abcd', 'efgh', 'i']);
  });
});

describe('S3ExportFiles streaming', () => {
  const options = {
    bucket: 'exports',
    region: 'ap-south-1',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
  };

  it('puts a small stream in one request', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    await new S3ExportFiles(options).putStream(
      'k',
      Readable.from([Buffer.from('zip')]),
      'application/zip',
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]![0] as PutObjectCommand).input).toMatchObject({ Key: 'k' });
  });

  it('uploads a large stream in parts and aborts the upload when a part fails', async () => {
    const big = () =>
      Readable.from([Buffer.alloc(PART_BYTES), Buffer.alloc(PART_BYTES), Buffer.alloc(10)]);
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async (command: unknown) =>
        command instanceof UploadPartCommand ? { ETag: '"e"' } : { UploadId: 'u' },
      );
    await new S3ExportFiles(options).putStream('k', big(), 'application/zip');
    const names = send.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(names).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ]);

    send.mockReset().mockImplementation(async (command: unknown) => {
      if (command instanceof UploadPartCommand) throw new Error('network');
      return { UploadId: 'u' };
    });
    await expect(
      new S3ExportFiles(options).putStream('k', big(), 'application/zip'),
    ).rejects.toThrow('network');
    expect(send.mock.calls.at(-1)![0].constructor.name).toBe('AbortMultipartUploadCommand');
  });

  it('reads an evidence object, and null when it is missing', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({ Body: Readable.from([Buffer.from('x')]) } as never)
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }))
      .mockRejectedValueOnce(new Error('denied'));
    const files = new S3ExportFiles(options);
    expect(await files.open('evidence/a')).not.toBeNull();
    expect(await files.open('evidence/b')).toBeNull();
    await expect(files.open('evidence/c')).rejects.toThrow('denied');
    expect(send).toHaveBeenCalledTimes(3);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ScanInterruptedError,
  ScanServiceError,
  ScanTimeoutError,
  type EvidenceObjects,
  type Scanner,
  type ScanVerdict,
} from './ports.js';
import {
  runScanEvidence,
  SCAN_ATTEMPTS,
  SCAN_BATCH,
  SCAN_EVIDENCE,
  SCAN_RUN_MS,
} from './scan-evidence.js';
import {
  assignment,
  evidenceFile,
  harness,
  instance,
  isoFile,
  person,
} from './testing/builders.js';
import { memoryClient, memoryFirm, type MemoryFirm } from './testing/memory-store.js';

type Storage = 'ok' | 'down' | 'refused' | 'cut' | 'stall' | 'broken';

/**
 * Bytes per storage key; a key with no entry has nothing stored. `down` throws a service error, `refused` a file
 * error, `cut` ends the stream after half the bytes, `stall` sends nothing until the deadline aborts, `broken`
 * breaks off mid-transfer.
 */
function fakeObjects(
  files: Map<string, string>,
  storage: (key: string) => Storage = () => 'ok',
): EvidenceObjects & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async open(key, signal) {
      opened.push(key);
      const mode = storage(key);
      if (mode === 'down') throw new ScanServiceError('storage unreachable');
      if (mode === 'refused') throw new Error('Object storage refused the file');
      const text = files.get(key);
      if (text === undefined) return null;
      return (async function* () {
        if (mode === 'stall') {
          await new Promise((_, reject) =>
            signal!.addEventListener('abort', () => reject(new ScanTimeoutError('stopped'))),
          );
        }
        if (mode === 'broken') {
          yield Buffer.from(text.slice(0, 2));
          throw new ScanInterruptedError('Object storage stopped sending the file');
        }
        yield Buffer.from(mode === 'cut' ? text.slice(0, text.length / 2) : text);
      })();
    },
  };
}

/** Infected with "EICAR"; "too big" is FAILED; "down" a service error; "slow" a timeout; "garbled" a file error. */
function fakeScanner(): Scanner & { scanned: string[] } {
  const scanned: string[] = [];
  return {
    scanned,
    async scan(content) {
      let text = '';
      for await (const chunk of content) text += Buffer.from(chunk).toString();
      scanned.push(text);
      if (text.includes('down')) throw new ScanServiceError('clamd could not be reached');
      if (text.includes('slow')) throw new ScanTimeoutError('clamd did not answer in time');
      if (text.includes('garbled')) throw new Error('Unexpected clamd reply');
      if (text.includes('too big')) return { status: 'FAILED' };
      const verdict: ScanVerdict = text.includes('EICAR')
        ? { status: 'INFECTED', signature: 'Eicar-Test-Signature' }
        : { status: 'CLEAN' };
      return verdict;
    },
  };
}

function setup(contents: string[]) {
  const firm = memoryFirm();
  const client = memoryClient('Kestrel Metals Group');
  const owner = person({ clientIds: [client.id] });
  const approver = person({ clientIds: [client.id] });
  firm.clients.push(client);
  firm.people.push(owner, approver);
  const a = assignment(client, owner, approver);
  firm.assignments.push(a);
  const i = instance(a, '2026-10-07', { version: 3 });
  firm.instances.push(i);
  const files = new Map<string, string>();
  const add = (text: string, createdAt: string) => {
    const e = evidenceFile(i, { createdAt, sizeBytes: Buffer.byteLength(text) });
    firm.evidence.push(e);
    files.set(e.storageKey, text);
    return e;
  };
  contents.forEach((text, n) => add(text, `2026-10-12T01:0${n}:00.000Z`));
  return { firm, client, instance: i, files, add };
}

function withScanning(
  firms: MemoryFirm[],
  files: Map<string, string>,
  storage?: (key: string) => Storage,
) {
  const h = harness(firms);
  const scanner = fakeScanner();
  const objects = fakeObjects(files, storage);
  h.deps.scanner = scanner;
  h.deps.evidenceObjects = objects;
  // Each transaction replaces the store's copy of the firm; read results after the run.
  return { h, scanner, objects, firm: () => h.store.firms[0]!, stored: h.store.firms };
}

const statuses = (f: MemoryFirm) => f.evidence.map((e) => e.scanStatus);
/** An audit row's `after` without the evidence id, which the first test checks. */
const scanAfter = (a: MemoryFirm['audits'][number]) => {
  const { evidenceId, ...rest } = a.after ?? {};
  void evidenceId;
  return rest;
};
const attemptRows = (f: MemoryFirm) =>
  f.audits.filter((a) => a.after?.scanStatus === 'PENDING').map(scanAfter);

describe('runScanEvidence', () => {
  it('marks clean and infected files, with an audit row and an evidence.scanned event each', async () => {
    const {
      firm: seed,
      client,
      instance: i,
      files,
    } = setup(['%PDF-1.7 challan', 'X5O!P EICAR test']);
    const { h, firm } = withScanning([seed], files);
    const report = await runScanEvidence(h.deps, 'job:scan-evidence:1');

    expect(report).toEqual({ firms: 1, clean: 1, infected: 1, failed: 0, retry: 0 });
    expect(statuses(firm())).toEqual(['CLEAN', 'INFECTED']);
    const [clean, infected] = firm().evidence;
    expect(firm().audits).toEqual([
      {
        clientId: client.id,
        at: '2026-10-12T01:30:00.000Z',
        requestId: 'job:scan-evidence:1',
        actorId: null,
        actorKind: 'SYSTEM',
        action: 'UPDATE',
        // On the instance, as M7's scanned() writes it, so the result shows in the instance history.
        entityType: 'instance',
        entityId: i.id,
        before: { evidenceId: clean!.id, scanStatus: 'PENDING' },
        after: { evidenceId: clean!.id, scanStatus: 'CLEAN' },
        reason: null,
      },
      expect.objectContaining({
        entityType: 'instance',
        entityId: i.id,
        after: {
          evidenceId: infected!.id,
          scanStatus: 'INFECTED',
          signature: 'Eicar-Test-Signature',
        },
      }),
    ]);
    expect(firm().events.map((e) => ({ ...e, id: undefined, occurredAt: undefined }))).toEqual([
      expect.objectContaining({
        type: 'evidence.scanned',
        clientId: client.id,
        actor: { kind: 'SYSTEM', job: SCAN_EVIDENCE },
        aggregate: { type: 'instance', id: i.id },
        aggregateVersion: 3,
        data: { evidenceId: clean!.id, instanceId: i.id, scanStatus: 'CLEAN' },
      }),
      expect.objectContaining({
        data: { evidenceId: infected!.id, instanceId: i.id, scanStatus: 'INFECTED' },
      }),
    ]);
    // The event carries ids and the status only: no storage key, no signature.
    expect(JSON.stringify(firm().events)).not.toContain(clean!.storageKey);
    expect(JSON.stringify(firm().events)).not.toContain('Eicar');
  });

  it('marks a file with nothing stored, or one the scanner cannot judge, FAILED at once', async () => {
    const { firm: seed, files } = setup(['%PDF too big', 'gone']);
    files.delete(seed.evidence[1]!.storageKey);
    const { h, scanner, firm } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ failed: 2, retry: 0 });
    expect(statuses(firm())).toEqual(['FAILED', 'FAILED']);
    expect(scanner.scanned).toEqual(['%PDF too big']);
    expect(firm().audits.map(scanAfter)).toEqual([
      { scanStatus: 'FAILED' },
      { scanStatus: 'FAILED' },
    ]);
  });

  it('stops the run and counts nothing when the scanner is down', async () => {
    const { firm: seed, files } = setup(['%PDF ok', '%PDF down', '%PDF later']);
    const { h, scanner, firm } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 1, retry: 1 });
    expect(statuses(firm())).toEqual(['CLEAN', 'PENDING', 'PENDING']);
    expect(scanner.scanned).toHaveLength(2);
    expect(attemptRows(firm())).toEqual([]);
  });

  it('stops the run and counts nothing when storage is down', async () => {
    const { firm: seed, files } = setup(['%PDF ok', '%PDF b']);
    const { h, objects, firm } = withScanning([seed], files, () => 'down');
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 0, retry: 1 });
    expect(objects.opened).toHaveLength(1);
    expect(statuses(firm())).toEqual(['PENDING', 'PENDING']);
    expect(firm().audits).toHaveLength(0);
    expect(firm().events).toHaveLength(0);
  });

  it('moves past a file that fails, and marks it FAILED after its last attempt', async () => {
    const { firm: seed, files } = setup(['%PDF garbled', '%PDF fine']);
    const { h, scanner, firm } = withScanning([seed], files);
    for (let run = 1; run < SCAN_ATTEMPTS; run++) {
      expect(await runScanEvidence(h.deps, `r${run}`)).toMatchObject({
        retry: 1,
        clean: run === 1 ? 1 : 0,
      });
    }
    // The file after the failing one was scanned on the first run, not held up behind it.
    expect(statuses(firm())).toEqual(['PENDING', 'CLEAN']);
    expect(attemptRows(firm())).toEqual([
      { scanStatus: 'PENDING', scanAttempt: 1, scanError: 'UNREADABLE' },
      { scanStatus: 'PENDING', scanAttempt: 2, scanError: 'UNREADABLE' },
    ]);
    expect(firm().events).toHaveLength(1);

    expect(await runScanEvidence(h.deps, 'last')).toMatchObject({ failed: 1, retry: 0 });
    expect(statuses(firm())).toEqual(['FAILED', 'CLEAN']);
    expect(scanAfter(firm().audits.at(-1)!)).toEqual({
      scanStatus: 'FAILED',
      attempts: SCAN_ATTEMPTS,
    });
    expect(firm().events.at(-1)!.data).toMatchObject({ scanStatus: 'FAILED' });
    expect(scanner.scanned.filter((t) => t.includes('garbled'))).toHaveLength(SCAN_ATTEMPTS);
    // Error text never reaches the audit trail.
    expect(JSON.stringify(firm().audits)).not.toContain('Unexpected');
  });

  it('counts a file storage refuses against that file and goes on', async () => {
    const { firm: seed, files } = setup(['%PDF a', '%PDF b']);
    const refused = seed.evidence[0]!.storageKey;
    const { h, firm } = withScanning([seed], files, (key) => (key === refused ? 'refused' : 'ok'));
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 1, retry: 1 });
    expect(attemptRows(firm())).toEqual([
      { scanStatus: 'PENDING', scanAttempt: 1, scanError: 'UNREADABLE' },
    ]);
  });

  it('counts a scanner timeout against the file and stops the run, in case the scanner is stuck', async () => {
    const { firm: seed, files } = setup(['%PDF slow', '%PDF later']);
    const { h, scanner, firm } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ retry: 1, clean: 0 });
    expect(scanner.scanned).toEqual(['%PDF slow']);
    expect(attemptRows(firm())).toEqual([
      { scanStatus: 'PENDING', scanAttempt: 1, scanError: 'TIMEOUT' },
    ]);
  });

  it('gives up on a storage stream that stalls, at the file’s deadline', async () => {
    const { firm: seed, files } = setup(['%PDF stalled']);
    const { h, scanner, firm } = withScanning([seed], files, () => 'stall');
    expect(await runScanEvidence(h.deps, 'r', { fileMs: 20 })).toMatchObject({ retry: 1 });
    expect(scanner.scanned).toEqual([]);
    expect(attemptRows(firm())).toEqual([
      { scanStatus: 'PENDING', scanAttempt: 1, scanError: 'TIMEOUT' },
    ]);
  });

  it('counts storage breaking off mid-file against the file and stops the run, so one bad object cannot block the queue', async () => {
    const { firm: seed, files } = setup(['%PDF broken', '%PDF later']);
    const broken = seed.evidence[0]!.storageKey;
    const { h, scanner, firm } = withScanning([seed], files, (key) =>
      key === broken ? 'broken' : 'ok',
    );
    for (let run = 1; run < SCAN_ATTEMPTS; run++) {
      expect(await runScanEvidence(h.deps, `r${run}`)).toMatchObject({ retry: 1, clean: 0 });
    }
    // The run stopped at the broken file each time, in case storage itself is failing.
    expect(scanner.scanned).toEqual([]);
    expect(attemptRows(firm())).toEqual([
      { scanStatus: 'PENDING', scanAttempt: 1, scanError: 'INTERRUPTED' },
      { scanStatus: 'PENDING', scanAttempt: 2, scanError: 'INTERRUPTED' },
    ]);
    expect(await runScanEvidence(h.deps, 'last')).toMatchObject({ failed: 1 });
    expect(statuses(firm())).toEqual(['FAILED', 'PENDING']);
    expect(await runScanEvidence(h.deps, 'next')).toMatchObject({ clean: 1 });
  });

  it('counts only attempts on the same file', async () => {
    const { firm: seed, files } = setup(['%PDF garbled a', '%PDF garbled b']);
    const { h, firm } = withScanning([seed], files);
    await runScanEvidence(h.deps, 'r1');
    await runScanEvidence(h.deps, 'r2');
    // Two files on one instance: each has its own two attempts, so neither is FAILED yet.
    expect(statuses(firm())).toEqual(['PENDING', 'PENDING']);
    expect(attemptRows(firm()).map((a) => a.scanAttempt)).toEqual([1, 1, 2, 2]);
  });

  it('never marks a file CLEAN from fewer bytes than were uploaded', async () => {
    const { firm: seed, files } = setup(['%PDF-1.7 whole file']);
    const { h, firm } = withScanning([seed], files, () => 'cut');
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 0, retry: 1 });
    expect(statuses(firm())).toEqual(['PENDING']);
    expect(attemptRows(firm())).toEqual([
      { scanStatus: 'PENDING', scanAttempt: 1, scanError: 'TRUNCATED' },
    ]);
  });

  it('still reports INFECTED from part of a file', async () => {
    const { firm: seed, files } = setup(['EICAR then more bytes']);
    const { h, firm } = withScanning([seed], files, () => 'cut');
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ infected: 1 });
    expect(statuses(firm())).toEqual(['INFECTED']);
  });

  it('skips archived and already scanned files', async () => {
    const { firm: seed, files } = setup(['%PDF a', '%PDF b', '%PDF c']);
    seed.evidence[0]!.archived = true;
    seed.evidence[1]!.scanStatus = 'CLEAN';
    const { h, scanner, firm } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 1 });
    expect(scanner.scanned).toEqual(['%PDF c']);
    expect(firm().evidence[0]!.scanStatus).toBe('PENDING');
  });

  it('scans oldest first and works through more than one batch, past failing files', async () => {
    const { firm: seed, files, add } = setup([]);
    for (let n = SCAN_BATCH + 5; n > 0; n--) {
      const text = n <= 3 ? `%PDF garbled ${n}` : `%PDF ${n}`;
      add(text, new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString());
    }
    const { h, scanner, firm } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: SCAN_BATCH + 2, retry: 3 });
    expect(scanner.scanned.slice(0, 4)).toEqual([
      '%PDF garbled 1',
      '%PDF garbled 2',
      '%PDF garbled 3',
      '%PDF 4',
    ]);
    // Each failing file was tried once this run.
    expect(scanner.scanned).toHaveLength(SCAN_BATCH + 5);
    expect(firm().evidence.filter((e) => e.scanStatus === 'PENDING')).toHaveLength(3);
  });

  it('scans every firm, each in its own tenant', async () => {
    const a = setup(['%PDF a']);
    const b = setup(['%PDF EICAR']);
    const files = new Map([...a.files, ...b.files]);
    const { h, stored } = withScanning([a.firm, b.firm], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ firms: 2, clean: 1, infected: 1 });
    expect(stored.map((f) => f.audits.map(scanAfter))).toEqual([
      [{ scanStatus: 'CLEAN' }],
      [{ scanStatus: 'INFECTED', signature: 'Eicar-Test-Signature' }],
    ]);
  });

  it('starts no new file once the run is past its time budget', async () => {
    const { firm: seed, files } = setup(['%PDF a', '%PDF b']);
    const { h, firm } = withScanning([seed], files);
    let now = Date.parse('2026-10-12T01:30:00.000Z');
    h.deps.clock = () => {
      const at = new Date(now).toISOString();
      // Each read moves a quarter of the budget on: the first file starts at half, the second at the limit.
      now += SCAN_RUN_MS / 4;
      return at;
    };
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 1 });
    expect(statuses(firm())).toEqual(['CLEAN', 'PENDING']);
  });

  it('refuses to run without a scanner or storage', async () => {
    const { firm: seed } = setup([]);
    await expect(runScanEvidence(harness([seed]).deps, 'r')).rejects.toThrow(
      'needs a virus scanner and evidence storage',
    );
  });
});

describe('runScanEvidence on ISO files', () => {
  /** A firm with the add-on as given and PENDING ISO files with these contents, oldest first. */
  function isoSetup(contents: string[], features: string[] = []) {
    const firm = {
      ...memoryFirm(),
      features,
      isoCatalogueCopiedAt: features.length > 0 ? '2026-10-20T00:00:00.000Z' : null,
    };
    const client = memoryClient('Osprey Textiles Group');
    firm.clients.push(client);
    const files = new Map<string, string>();
    contents.forEach((text, n) => {
      const f = isoFile(client, {
        createdAt: new Date(Date.UTC(2026, 9, 12, 1, 0, n)).toISOString(),
        sizeBytes: Buffer.byteLength(text),
      });
      firm.isoFiles.push(f);
      files.set(f.storageKey, text);
    });
    return { firm, files };
  }
  const isoStatuses = (f: MemoryFirm) => f.isoFiles.map((x) => x.scanStatus);

  it.each([
    ['off', []],
    ['on', ['isoManagement']],
  ])(
    'scans PENDING ISO files to CLEAN or INFECTED with the add-on %s, audited on the subject with no event',
    async (_label, features) => {
      const { firm: seed, files } = isoSetup(['%PDF fine', 'EICAR'], features);
      const [clean, infected] = seed.isoFiles as [
        MemoryFirm['isoFiles'][number],
        MemoryFirm['isoFiles'][number],
      ];
      const { h, firm } = withScanning([seed], files);
      expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 1, infected: 1 });
      expect(isoStatuses(firm())).toEqual(['CLEAN', 'INFECTED']);
      expect(firm().audits).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          actorKind: 'SYSTEM',
          clientId: clean.clientId,
          entityType: 'risk_item',
          entityId: clean.subject.id,
          before: { fileId: clean.id, scanStatus: 'PENDING' },
          after: { fileId: clean.id, scanStatus: 'CLEAN' },
        }),
        expect.objectContaining({
          entityType: 'risk_item',
          entityId: infected.subject.id,
          after: {
            fileId: infected.id,
            scanStatus: 'INFECTED',
            signature: 'Eicar-Test-Signature',
          },
        }),
      ]);
      expect(firm().events).toEqual([]);
      // Never the storage key in the trail.
      expect(JSON.stringify(firm().audits)).not.toContain(clean.storageKey);
    },
  );

  it('scans evidence before ISO files in the same run', async () => {
    const { firm: seed, files } = setup(['%PDF evidence']);
    const client = seed.clients[0]!;
    const f = isoFile(client, { sizeBytes: Buffer.byteLength('%PDF iso') });
    seed.isoFiles.push(f);
    files.set(f.storageKey, '%PDF iso');
    const { h, scanner, firm } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ firms: 1, clean: 2 });
    expect(scanner.scanned).toEqual(['%PDF evidence', '%PDF iso']);
    expect(firm().events.map((e) => e.type)).toEqual(['evidence.scanned']);
  });

  it('keeps the status of a file archived before its result is recorded', async () => {
    const { firm: seed, files } = isoSetup(['%PDF removed']);
    const { h, firm, stored } = withScanning([seed], files);
    const scanner = h.deps.scanner!;
    h.deps.scanner = {
      async scan(content, signal) {
        stored[0]!.isoFiles[0]!.archived = true;
        return scanner.scan(content, signal);
      },
    };
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 0 });
    expect(firm().isoFiles[0]).toMatchObject({ scanStatus: 'PENDING', archived: true });
    expect(firm().audits).toEqual([]);
  });

  it('skips archived and already scanned ISO files', async () => {
    const { firm: seed, files } = isoSetup(['%PDF a', '%PDF b', '%PDF c']);
    seed.isoFiles[0]!.archived = true;
    seed.isoFiles[1]!.scanStatus = 'CLEAN';
    const { h, scanner, firm } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 1 });
    expect(scanner.scanned).toEqual(['%PDF c']);
    expect(isoStatuses(firm())).toEqual(['PENDING', 'CLEAN', 'CLEAN']);
  });

  it('counts failed attempts on the subject and marks the file FAILED after the last', async () => {
    const { firm: seed, files } = isoSetup(['%PDF garbled']);
    const { h, firm } = withScanning([seed], files);
    for (let run = 1; run < SCAN_ATTEMPTS; run++) {
      expect(await runScanEvidence(h.deps, `r${run}`)).toMatchObject({ retry: 1 });
    }
    const subject = firm().isoFiles[0]!.subject;
    expect(
      firm().audits.map((a) => [
        a.entityType,
        a.entityId,
        a.after?.scanAttempt,
        a.after?.scanError,
      ]),
    ).toEqual([
      [subject.type, subject.id, 1, 'UNREADABLE'],
      [subject.type, subject.id, 2, 'UNREADABLE'],
    ]);
    expect(await runScanEvidence(h.deps, 'last')).toMatchObject({ failed: 1, retry: 0 });
    expect(isoStatuses(firm())).toEqual(['FAILED']);
    expect(firm().audits.at(-1)!.after).toEqual({
      fileId: firm().isoFiles[0]!.id,
      scanStatus: 'FAILED',
      attempts: SCAN_ATTEMPTS,
    });
    expect(firm().events).toEqual([]);
  });

  it('never asks the ISO queue for more than 200 files, however many failed in the run', async () => {
    // The memory store throws above 200, as M3's pendingScan does.
    const { firm: seed, files } = isoSetup(Array.from({ length: 210 }, () => '%PDF garbled'));
    const { h, scanner } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ retry: 200 });
    expect(scanner.scanned).toHaveLength(200);
  });
});

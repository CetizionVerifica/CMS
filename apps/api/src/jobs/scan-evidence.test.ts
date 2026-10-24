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
import { assignment, evidenceFile, harness, instance, person } from './testing/builders.js';
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

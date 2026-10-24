import { describe, expect, it } from 'vitest';
import type { EvidenceObjects, Scanner, ScanVerdict } from './ports.js';
import { runScanEvidence, SCAN_BATCH, SCAN_EVIDENCE, SCAN_RUN_MS } from './scan-evidence.js';
import { assignment, evidenceFile, harness, instance, person } from './testing/builders.js';
import { memoryClient, memoryFirm, type MemoryFirm } from './testing/memory-store.js';

/** Bytes per storage key; a key with no entry has nothing stored. */
function fakeObjects(
  files: Map<string, string>,
  failing = false,
): EvidenceObjects & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async open(key) {
      opened.push(key);
      if (failing) throw new Error('storage unreachable');
      const text = files.get(key);
      if (text === undefined) return null;
      return (async function* () {
        yield Buffer.from(text);
      })();
    },
  };
}

/** Infected when the file holds "EICAR"; throws for "unreachable". */
function fakeScanner(): Scanner & { scanned: string[] } {
  const scanned: string[] = [];
  return {
    scanned,
    async scan(content) {
      let text = '';
      for await (const chunk of content) text += Buffer.from(chunk).toString();
      scanned.push(text);
      if (text.includes('unreachable')) throw new Error('clamd unreachable');
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
  contents.forEach((text, n) => {
    const e = evidenceFile(i, { createdAt: `2026-10-12T01:0${n}:00.000Z` });
    firm.evidence.push(e);
    files.set(e.storageKey, text);
  });
  return { firm, client, instance: i, files };
}

function withScanning(firms: MemoryFirm[], files: Map<string, string>, failing = false) {
  const h = harness(firms);
  const scanner = fakeScanner();
  const objects = fakeObjects(files, failing);
  h.deps.scanner = scanner;
  h.deps.evidenceObjects = objects;
  // Each transaction replaces the store's copy of the firm; read results after the run.
  return { h, scanner, objects, firm: () => h.store.firms[0]!, stored: h.store.firms };
}

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
    expect(firm().evidence.map((e) => e.scanStatus)).toEqual(['CLEAN', 'INFECTED']);
    const [clean, infected] = firm().evidence;
    expect(firm().audits).toEqual([
      {
        clientId: client.id,
        at: '2026-10-12T01:30:00.000Z',
        requestId: 'job:scan-evidence:1',
        actorId: null,
        actorKind: 'SYSTEM',
        action: 'UPDATE',
        entityType: 'evidence',
        entityId: clean!.id,
        before: { scanStatus: 'PENDING' },
        after: { scanStatus: 'CLEAN' },
        reason: null,
      },
      expect.objectContaining({
        entityId: infected!.id,
        after: { scanStatus: 'INFECTED', signature: 'Eicar-Test-Signature' },
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

  it('marks a file with nothing stored, or one the scanner cannot judge, FAILED', async () => {
    const { firm: seed, files } = setup(['%PDF too big', 'gone']);
    files.delete(seed.evidence[1]!.storageKey);
    const { h, scanner, firm } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ failed: 2, retry: 0 });
    expect(firm().evidence.map((e) => e.scanStatus)).toEqual(['FAILED', 'FAILED']);
    expect(scanner.scanned).toEqual(['%PDF too big']);
    expect(firm().audits.map((a) => a.after)).toEqual([
      { scanStatus: 'FAILED' },
      { scanStatus: 'FAILED' },
    ]);
  });

  it('stops the run and leaves the file PENDING when the scanner cannot be reached', async () => {
    const { firm: seed, files } = setup(['%PDF ok', 'unreachable', '%PDF later']);
    const { h, scanner, firm } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 1, retry: 1 });
    expect(firm().evidence.map((e) => e.scanStatus)).toEqual(['CLEAN', 'PENDING', 'PENDING']);
    expect(scanner.scanned).toHaveLength(2);
    expect(firm().audits).toHaveLength(1);
  });

  it('stops the run when storage cannot be reached', async () => {
    const { firm: seed, files } = setup(['%PDF ok']);
    const { h, objects, firm } = withScanning([seed], files, true);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: 0, retry: 1 });
    expect(objects.opened).toHaveLength(1);
    expect(firm().evidence[0]!.scanStatus).toBe('PENDING');
    expect(firm().audits).toHaveLength(0);
    expect(firm().events).toHaveLength(0);
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

  it('scans oldest first and works through more than one batch', async () => {
    const { firm: seed, instance: i, files } = setup([]);
    for (let n = SCAN_BATCH + 5; n > 0; n--) {
      const e = evidenceFile(i, { createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString() });
      seed.evidence.push(e);
      files.set(e.storageKey, `%PDF ${n}`);
    }
    const { h, scanner, firm } = withScanning([seed], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ clean: SCAN_BATCH + 5 });
    expect(scanner.scanned.slice(0, 3)).toEqual(['%PDF 1', '%PDF 2', '%PDF 3']);
    expect(firm().evidence.every((e) => e.scanStatus === 'CLEAN')).toBe(true);
  });

  it('scans every firm, each in its own tenant', async () => {
    const a = setup(['%PDF a']);
    const b = setup(['%PDF EICAR']);
    const files = new Map([...a.files, ...b.files]);
    const { h, stored } = withScanning([a.firm, b.firm], files);
    expect(await runScanEvidence(h.deps, 'r')).toMatchObject({ firms: 2, clean: 1, infected: 1 });
    expect(stored.map((f) => f.audits.map((x) => x.after))).toEqual([
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
    expect(firm().evidence.map((e) => e.scanStatus)).toEqual(['CLEAN', 'PENDING']);
  });

  it('refuses to run without a scanner or storage', async () => {
    const { firm: seed } = setup([]);
    await expect(runScanEvidence(harness([seed]).deps, 'r')).rejects.toThrow(
      'needs a virus scanner and evidence storage',
    );
  });
});

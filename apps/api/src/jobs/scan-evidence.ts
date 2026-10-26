import type { EntityType } from '@canopy/contracts';
import {
  ScanInterruptedError,
  ScanServiceError,
  ScanTimeoutError,
  type FirmTx,
  type JobAuditEvent,
  type JobDeps,
  type JobDomainEvent,
  type JobReport,
  type PendingEvidence,
  type PendingIsoFile,
  type ScanResult,
  type ScanVerdict,
} from './ports.js';

export const SCAN_EVIDENCE = 'scan-evidence';
/** Files read per firm per transaction. */
export const SCAN_BATCH = 50;
/** Failed attempts after which a file is FAILED, so one file that never scans cannot hold up the rest. */
export const SCAN_ATTEMPTS = 3;
/**
 * One file's deadline, storage read and scan together. Above the scanner's own timeout (`CLAMAV_TIMEOUT_MS`, at
 * most 4 minutes), so the scanner's answer normally comes first; it catches a storage stream that stalls.
 */
export const SCAN_FILE_MS = 5 * 60 * 1000;
/**
 * No new file is started once a run is this old. With one file's deadline on top, a run ends inside the 30-minute
 * job expiry. The queue is stately: the next run starts after this one and picks up the rest.
 */
export const SCAN_RUN_MS = 10 * 60 * 1000;

/** Why an attempt failed, recorded on its audit row. Codes only: no error text, which can quote a key. */
type AttemptCode = 'TIMEOUT' | 'INTERRUPTED' | 'TRUNCATED' | 'UNREADABLE';

/** Attempts that also stop the run: the scanner may be stuck, or storage may be failing. */
const STOPS_RUN: ReadonlySet<AttemptCode> = new Set(['TIMEOUT', 'INTERRUPTED']);

type Outcome =
  | { kind: 'verdict'; verdict: ScanVerdict }
  | { kind: 'service' }
  | { kind: 'attempt'; code: AttemptCode };

/** Reads and scans one file before its deadline. CLEAN only when every byte the upload recorded was scanned. */
async function scanFile(deps: JobDeps, file: ScanFile, fileMs: number): Promise<Outcome> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new ScanTimeoutError('The file was not scanned in time')),
    fileMs,
  );
  try {
    const content = await deps.evidenceObjects!.open(file.storageKey, deadline.signal);
    if (content === null) return { kind: 'verdict', verdict: { status: 'FAILED' } };
    let bytes = 0;
    const counted = (async function* () {
      for await (const chunk of content) {
        bytes += chunk.length;
        yield chunk;
      }
    })();
    const verdict = await deps.scanner!.scan(counted, deadline.signal);
    if (verdict.status === 'CLEAN' && bytes !== file.sizeBytes) {
      return { kind: 'attempt', code: 'TRUNCATED' };
    }
    return { kind: 'verdict', verdict };
  } catch (error) {
    if (deadline.signal.aborted || error instanceof ScanTimeoutError) {
      return { kind: 'attempt', code: 'TIMEOUT' };
    }
    if (error instanceof ScanInterruptedError) return { kind: 'attempt', code: 'INTERRUPTED' };
    if (error instanceof ScanServiceError) return { kind: 'service' };
    return { kind: 'attempt', code: 'UNREADABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/** A file in one of the scan queues: an evidence file or an ISO file. */
type ScanFile = Pick<PendingEvidence, 'id' | 'clientId' | 'storageKey' | 'sizeBytes'>;

/** One kind of file the job scans: where its PENDING files come from and where their results are recorded. */
interface ScanQueue<F extends ScanFile> {
  pending(tx: FirmTx, limit: number): Promise<F[]>;
  /**
   * Sets the file's result and returns the domain events to write with it, or null, and nothing changed, when the
   * file is missing, archived or no longer PENDING.
   */
  record(
    tx: FirmTx,
    requestId: string,
    file: F,
    status: ScanResult,
  ): Promise<JobDomainEvent[] | null>;
  attempts(tx: FirmTx, file: F): Promise<number>;
  /** The record the file's audit rows sit on, and how those rows name the file. */
  audit(file: F): { entityType: EntityType; entityId: string; ref: Record<string, string> };
}

/**
 * Evidence: audit rows on the instance, as M7's `scanned()` writes them, so they show in the instance's history, and
 * an `evidence.scanned` event.
 */
const EVIDENCE: ScanQueue<PendingEvidence> = {
  pending: (tx, limit) => tx.listPendingEvidence(limit),
  async record(tx, requestId, file, status) {
    const changed = await tx.recordScan(file.id, status);
    if (!changed) return null;
    return [
      {
        type: 'evidence.scanned',
        clientId: file.clientId,
        actor: { kind: 'SYSTEM', job: SCAN_EVIDENCE },
        requestId,
        aggregate: { type: 'instance', id: file.instanceId },
        aggregateVersion: changed.instanceVersion,
        data: { evidenceId: file.id, instanceId: file.instanceId, scanStatus: status },
      },
    ];
  },
  attempts: (tx, file) => tx.scanAttempts(file.id, file.instanceId),
  audit: (file) => ({
    entityType: 'instance',
    entityId: file.instanceId,
    ref: { evidenceId: file.id },
  }),
};

/** M3's `isoFiles.pendingScan` takes at most 200. */
const MAX_ISO_BATCH = 200;

/**
 * ISO files (docs/iso/plan.md §4.5): audit rows on the file's subject, as M7's ISO file service writes them, and no
 * event. Scanned with the add-on on or off, so a file uploaded before a switch-off is not left PENDING.
 */
const ISO_FILES: ScanQueue<PendingIsoFile> = {
  pending: (tx, limit) => tx.listPendingIsoFiles(Math.min(limit, MAX_ISO_BATCH)),
  record: async (tx, _requestId, file, status) =>
    (await tx.recordIsoScan(file.id, status)) ? [] : null,
  attempts: (tx, file) => tx.isoScanAttempts(file.id, file.subject),
  audit: (file) => ({
    entityType: file.subject.type,
    entityId: file.subject.id,
    ref: { fileId: file.id },
  }),
};

/** The status change, its audit row and its events, in the caller's transaction. */
async function recordResult<F extends ScanFile>(
  tx: FirmTx,
  queue: ScanQueue<F>,
  deps: JobDeps,
  requestId: string,
  file: F,
  verdict: ScanVerdict,
  attempts?: number,
): Promise<boolean> {
  const events = await queue.record(tx, requestId, file, verdict.status);
  if (!events) return false;
  const { entityType, entityId, ref } = queue.audit(file);
  const audit: JobAuditEvent = {
    clientId: file.clientId,
    at: deps.clock(),
    requestId,
    actorId: null,
    actorKind: 'SYSTEM',
    action: 'UPDATE',
    entityType,
    entityId,
    before: { ...ref, scanStatus: 'PENDING' },
    after: {
      ...ref,
      scanStatus: verdict.status,
      ...(verdict.status === 'INFECTED' && { signature: verdict.signature }),
      ...(attempts !== undefined && { attempts }),
    },
    reason: null,
  };
  await tx.writeAudit([audit]);
  if (events.length > 0) await tx.writeEvents(events);
  return true;
}

/**
 * Records a failed attempt on the file's audit trail (it stays PENDING: 'retry'), or FAILED once it has failed
 * `SCAN_ATTEMPTS` times ('failed'). 'gone' when the file stopped being PENDING meanwhile.
 */
async function recordAttempt<F extends ScanFile>(
  tx: FirmTx,
  queue: ScanQueue<F>,
  deps: JobDeps,
  requestId: string,
  file: F,
  code: AttemptCode,
): Promise<'failed' | 'retry' | 'gone'> {
  const attempt = (await queue.attempts(tx, file)) + 1;
  if (attempt >= SCAN_ATTEMPTS) {
    const failed = await recordResult(
      tx,
      queue,
      deps,
      requestId,
      file,
      { status: 'FAILED' },
      attempt,
    );
    return failed ? 'failed' : 'gone';
  }
  const { entityType, entityId, ref } = queue.audit(file);
  await tx.writeAudit([
    {
      clientId: file.clientId,
      at: deps.clock(),
      requestId,
      actorId: null,
      actorKind: 'SYSTEM',
      action: 'UPDATE',
      entityType,
      entityId,
      before: { ...ref, scanStatus: 'PENDING' },
      after: { ...ref, scanStatus: 'PENDING', scanAttempt: attempt, scanError: code },
      reason: null,
    },
  ]);
  return 'retry';
}

/** Scans one firm's PENDING files of one queue. 'stop' when the run must end (time up, a service down, a stop code). */
async function scanQueue<F extends ScanFile>(
  deps: JobDeps,
  firmId: string,
  requestId: string,
  queue: ScanQueue<F>,
  report: JobReport,
  fileMs: number,
  timeLeft: () => boolean,
): Promise<'stop' | 'next'> {
  // Files that failed an attempt in this run are not tried again until the next one.
  const tried = new Set<string>();
  for (;;) {
    const pending = (
      await deps.store.withFirm(firmId, requestId, (tx) =>
        queue.pending(tx, SCAN_BATCH + tried.size),
      )
    ).filter((file) => !tried.has(file.id));
    for (const file of pending) {
      if (!timeLeft()) return 'stop';
      const outcome = await scanFile(deps, file, fileMs);
      if (outcome.kind === 'service') {
        report.retry! += 1;
        return 'stop';
      }
      if (outcome.kind === 'verdict') {
        const { verdict } = outcome;
        const recorded = await deps.store.withFirm(firmId, requestId, (tx) =>
          recordResult(tx, queue, deps, requestId, file, verdict),
        );
        if (recorded) report[verdict.status.toLowerCase()]! += 1;
        continue;
      }
      tried.add(file.id);
      const result = await deps.store.withFirm(firmId, requestId, (tx) =>
        recordAttempt(tx, queue, deps, requestId, file, outcome.code),
      );
      if (result === 'failed') report.failed! += 1;
      if (result === 'retry') report.retry! += 1;
      if (STOPS_RUN.has(outcome.code)) return 'stop';
    }
    if (pending.length < SCAN_BATCH) return 'next';
  }
}

/**
 * Scans PENDING evidence, then PENDING ISO files, and records CLEAN, INFECTED or FAILED (apps/api/CLAUDE.md: a file is
 * unavailable until the scan marks it clean), oldest upload first. Each result is written with its `UPDATE` audit row
 * (and, for evidence, an `evidence.scanned` event) in one transaction.
 * - Storage or the scanner down (`ScanServiceError`): the run stops and nothing is counted, since every file would
 *   fail the same way. The next run starts over.
 * - Anything else that keeps a file from a verdict is a failed attempt, recorded on its audit trail (the instance's,
 *   or the ISO file's subject's).
 *   After `SCAN_ATTEMPTS` the file is FAILED. A timeout, or storage breaking off mid-file, also stops the run, in
 *   case the scanner is stuck or storage is failing; any other failure moves on to the next file.
 * Never logs or records the file name, its storage key, its bytes or an error message.
 */
export async function runScanEvidence(
  deps: JobDeps,
  requestId: string,
  { fileMs = SCAN_FILE_MS }: { fileMs?: number } = {},
): Promise<JobReport> {
  if (!deps.scanner || !deps.evidenceObjects) {
    throw new Error(`${SCAN_EVIDENCE} needs a virus scanner and evidence storage`);
  }
  const report: JobReport = { firms: 0, clean: 0, infected: 0, failed: 0, retry: 0 };
  const stopAt = Date.parse(deps.clock()) + SCAN_RUN_MS;
  const timeLeft = () => Date.parse(deps.clock()) < stopAt;
  for (const firmId of await deps.store.listFirmIds()) {
    if (!timeLeft()) break;
    report.firms! += 1;
    const scan = <F extends ScanFile>(queue: ScanQueue<F>) =>
      scanQueue(deps, firmId, requestId, queue, report, fileMs, timeLeft);
    if ((await scan(EVIDENCE)) === 'stop' || (await scan(ISO_FILES)) === 'stop') return report;
  }
  return report;
}

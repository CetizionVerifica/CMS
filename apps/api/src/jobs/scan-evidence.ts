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
async function scanFile(deps: JobDeps, file: PendingEvidence, fileMs: number): Promise<Outcome> {
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

/**
 * The status change, its audit row and its `evidence.scanned` event, in the caller's transaction. Scan audit rows sit
 * on the instance, as M7's `scanned()` writes them, so they show in the instance's history.
 */
async function recordResult(
  tx: FirmTx,
  deps: JobDeps,
  requestId: string,
  file: PendingEvidence,
  verdict: ScanVerdict,
  attempts?: number,
): Promise<boolean> {
  const changed = await tx.recordScan(file.id, verdict.status);
  if (!changed) return false;
  const audit: JobAuditEvent = {
    clientId: file.clientId,
    at: deps.clock(),
    requestId,
    actorId: null,
    actorKind: 'SYSTEM',
    action: 'UPDATE',
    entityType: 'instance',
    entityId: file.instanceId,
    before: { evidenceId: file.id, scanStatus: 'PENDING' },
    after: {
      evidenceId: file.id,
      scanStatus: verdict.status,
      ...(verdict.status === 'INFECTED' && { signature: verdict.signature }),
      ...(attempts !== undefined && { attempts }),
    },
    reason: null,
  };
  const event: JobDomainEvent = {
    type: 'evidence.scanned',
    clientId: file.clientId,
    actor: { kind: 'SYSTEM', job: SCAN_EVIDENCE },
    requestId,
    aggregate: { type: 'instance', id: file.instanceId },
    aggregateVersion: changed.instanceVersion,
    data: { evidenceId: file.id, instanceId: file.instanceId, scanStatus: verdict.status },
  };
  await tx.writeAudit([audit]);
  await tx.writeEvents([event]);
  return true;
}

/**
 * Records a failed attempt on the instance's audit trail (it stays PENDING: 'retry'), or FAILED once it has failed
 * `SCAN_ATTEMPTS` times ('failed'). 'gone' when the file stopped being PENDING meanwhile.
 */
async function recordAttempt(
  tx: FirmTx,
  deps: JobDeps,
  requestId: string,
  file: PendingEvidence,
  code: AttemptCode,
): Promise<'failed' | 'retry' | 'gone'> {
  const attempt = (await tx.scanAttempts(file.id, file.instanceId)) + 1;
  if (attempt >= SCAN_ATTEMPTS) {
    const failed = await recordResult(tx, deps, requestId, file, { status: 'FAILED' }, attempt);
    return failed ? 'failed' : 'gone';
  }
  await tx.writeAudit([
    {
      clientId: file.clientId,
      at: deps.clock(),
      requestId,
      actorId: null,
      actorKind: 'SYSTEM',
      action: 'UPDATE',
      entityType: 'instance',
      entityId: file.instanceId,
      before: { evidenceId: file.id, scanStatus: 'PENDING' },
      after: { evidenceId: file.id, scanStatus: 'PENDING', scanAttempt: attempt, scanError: code },
      reason: null,
    },
  ]);
  return 'retry';
}

/**
 * Scans PENDING evidence and records CLEAN, INFECTED or FAILED (apps/api/CLAUDE.md: a file is unavailable until the
 * scan marks it clean), oldest upload first. Each result is written with its `UPDATE` audit row and an
 * `evidence.scanned` event in one transaction.
 * - Storage or the scanner down (`ScanServiceError`): the run stops and nothing is counted, since every file would
 *   fail the same way. The next run starts over.
 * - Anything else that keeps a file from a verdict is a failed attempt, recorded on its instance's audit trail.
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
    // Files that failed an attempt in this run are not tried again until the next one.
    const tried = new Set<string>();
    for (;;) {
      const pending = (
        await deps.store.withFirm(firmId, requestId, (tx) =>
          tx.listPendingEvidence(SCAN_BATCH + tried.size),
        )
      ).filter((file) => !tried.has(file.id));
      for (const file of pending) {
        if (!timeLeft()) return report;
        const outcome = await scanFile(deps, file, fileMs);
        if (outcome.kind === 'service') {
          report.retry! += 1;
          return report;
        }
        if (outcome.kind === 'verdict') {
          const { verdict } = outcome;
          const recorded = await deps.store.withFirm(firmId, requestId, (tx) =>
            recordResult(tx, deps, requestId, file, verdict),
          );
          if (recorded) report[verdict.status.toLowerCase()]! += 1;
          continue;
        }
        tried.add(file.id);
        const result = await deps.store.withFirm(firmId, requestId, (tx) =>
          recordAttempt(tx, deps, requestId, file, outcome.code),
        );
        if (result === 'failed') report.failed! += 1;
        if (result === 'retry') report.retry! += 1;
        if (STOPS_RUN.has(outcome.code)) return report;
      }
      if (pending.length < SCAN_BATCH) break;
    }
  }
  return report;
}

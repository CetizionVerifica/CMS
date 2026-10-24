import type { JobAuditEvent, JobDeps, JobDomainEvent, JobReport, ScanVerdict } from './ports.js';

export const SCAN_EVIDENCE = 'scan-evidence';
/** Files read per firm per transaction. */
export const SCAN_BATCH = 50;
/**
 * No new file is started once a run is this old, so a run (with one clamd timeout at most) ends well inside the
 * 30-minute job expiry. The queue is stately: the next run starts after this one and picks up the rest.
 */
export const SCAN_RUN_MS = 10 * 60 * 1000;

/**
 * Scans PENDING evidence and records CLEAN, INFECTED or FAILED (apps/api/CLAUDE.md: a file is unavailable until the
 * scan marks it clean), oldest upload first. Each result is written with its `UPDATE` audit row and an
 * `evidence.scanned` event in one transaction. When storage or the scanner cannot be reached, the run stops and the
 * file stays PENDING for the next one: that failure is the service's, not the file's, so trying more files would only
 * fail the same way. Never logs or records the file name, its storage key or its bytes.
 */
export async function runScanEvidence(deps: JobDeps, requestId: string): Promise<JobReport> {
  const { scanner, evidenceObjects } = deps;
  if (!scanner || !evidenceObjects) {
    throw new Error(`${SCAN_EVIDENCE} needs a virus scanner and evidence storage`);
  }
  const report: JobReport = { firms: 0, clean: 0, infected: 0, failed: 0, retry: 0 };
  const stopAt = Date.parse(deps.clock()) + SCAN_RUN_MS;
  const timeLeft = () => Date.parse(deps.clock()) < stopAt;
  for (const firmId of await deps.store.listFirmIds()) {
    if (!timeLeft()) break;
    report.firms! += 1;
    for (;;) {
      const pending = await deps.store.withFirm(firmId, requestId, (tx) =>
        tx.listPendingEvidence(SCAN_BATCH),
      );
      let recordedAny = false;
      for (const file of pending) {
        if (!timeLeft()) return report;
        let verdict: ScanVerdict;
        try {
          const content = await evidenceObjects.open(file.storageKey);
          verdict = content === null ? { status: 'FAILED' } : await scanner.scan(content);
        } catch {
          report.retry! += 1;
          return report;
        }
        const recorded = await deps.store.withFirm(firmId, requestId, async (tx) => {
          const changed = await tx.recordScan(file.id, verdict.status);
          if (!changed) return false;
          const audit: JobAuditEvent = {
            clientId: file.clientId,
            at: deps.clock(),
            requestId,
            actorId: null,
            actorKind: 'SYSTEM',
            action: 'UPDATE',
            entityType: 'evidence',
            entityId: file.id,
            before: { scanStatus: 'PENDING' },
            after: {
              scanStatus: verdict.status,
              ...(verdict.status === 'INFECTED' && { signature: verdict.signature }),
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
        });
        if (recorded) {
          recordedAny = true;
          report[verdict.status.toLowerCase()]! += 1;
        }
      }
      // A full batch that changed nothing would be read again unchanged; anything less means the firm is done.
      if (pending.length < SCAN_BATCH || !recordedAny) break;
    }
  }
  return report;
}

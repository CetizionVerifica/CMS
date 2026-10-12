import type { Id } from '@canopy/contracts';
import type { JobDeps, JobReport } from './ports.js';

export const RELAY_OUTBOX = 'relay-outbox';

/** Events claimed per transaction. A firm with more is drained in further batches in the same run. */
export const RELAY_BATCH = 200;

/**
 * Publishes each firm's unpublished outbox events (docs/contracts/events.md §1) to the pg-boss queue named after
 * the event type, then marks them published in the same transaction that claimed them. The pg-boss job id is the
 * event id, so a crash between publishing and committing re-publishes the same job, never a second one.
 * Types no consumer listens to are marked published without being sent. A failed publish is counted on the row,
 * left unpublished for the next run, and fails this run so it is logged.
 */
export async function runRelayOutbox(deps: JobDeps, requestId: string): Promise<JobReport> {
  const bus = deps.bus;
  if (!bus) throw new Error(`${RELAY_OUTBOX} needs the runner's event bus`);
  const report: JobReport = { firms: 0, published: 0, skipped: 0, failed: 0 };
  for (const firmId of await deps.store.listFirmIds()) {
    report.firms! += 1;
    for (;;) {
      const { claimed, failed } = await deps.store.withFirm(firmId, requestId, async (tx) => {
        const events = await tx.claimEvents(RELAY_BATCH);
        const done: Id[] = [];
        let failed = 0;
        for (const event of events) {
          if (!bus.consumes(event.type)) {
            report.skipped! += 1;
            done.push(event.id);
            continue;
          }
          try {
            await bus.publish(event);
            report.published! += 1;
            done.push(event.id);
          } catch {
            failed += 1;
            await tx.recordEventFailure(event.id);
          }
        }
        await tx.markEventsPublished(done);
        return { claimed: events.length, failed };
      });
      report.failed! += failed;
      // A failure means the queue is unreachable: stop for this firm rather than reclaim the same rows.
      if (failed > 0 || claimed < RELAY_BATCH) break;
    }
  }
  if (report.failed! > 0) {
    throw new Error(`${RELAY_OUTBOX}: ${report.failed} event(s) not published`);
  }
  return report;
}

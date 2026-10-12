import type { Id } from '@canopy/contracts';
import { renderEmail, type EmailMessage } from '@canopy/notifications';
import type { FirmTx, JobDeps, JobReport, SendFailureCode, SendKey } from './ports.js';

export function sendKeyString(key: SendKey): string {
  if (key.eventId) return ['event', key.eventId, key.recipientId].join(':');
  return [key.kind, key.instanceId ?? key.recipientId, key.recipientId, key.sendDate].join(':');
}

function bump(report: JobReport, name: string): void {
  report[name] = (report[name] ?? 0) + 1;
}

/**
 * Claims the send-log row, sends, then records the outcome, each step its own transaction so no email is sent
 * while a transaction is open. A crash after sending and before recording leaves the row PENDING and the next
 * run sends again: at least once, but never again after DONE.
 */
export async function deliver(
  deps: JobDeps,
  firmId: Id,
  requestId: string,
  key: SendKey,
  to: { name: string; email: string | null; canReceive: boolean },
  message: EmailMessage,
  job: string,
  report: JobReport,
): Promise<void> {
  const withTx = <T>(fn: (tx: FirmTx) => Promise<T>) => deps.store.withFirm(firmId, requestId, fn);
  const claim = await withTx((tx) => tx.claimSend(key));
  if (claim === 'DONE') {
    bump(report, 'alreadySent');
    return;
  }
  const failure: SendFailureCode | null = !to.email
    ? 'NO_EMAIL'
    : to.canReceive
      ? null
      : 'NOT_ACTIVE';
  if (failure) {
    await withTx((tx) => tx.markFailed(key, failure));
    bump(report, `failed${failure}`);
    return;
  }
  await deps.mailer.send({
    ...renderEmail(message),
    to: { name: to.name, email: to.email! },
    idempotencyKey: sendKeyString(key),
  });
  await withTx((tx) =>
    tx.markSent(key, deps.clock(), {
      type: 'notification.sent',
      clientId: key.clientId,
      actor: { kind: 'SYSTEM', job },
      requestId,
      data: {
        kind: key.kind,
        recipientId: key.recipientId,
        instanceId: key.instanceId,
        sendDate: key.sendDate,
      },
    }),
  );
  bump(report, 'sent');
}

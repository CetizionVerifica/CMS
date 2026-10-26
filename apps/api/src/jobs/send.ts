import type { Id } from '@canopy/contracts';
import { renderEmail, type EmailMessage } from '@canopy/notifications';
import type { AnySendKey, FirmTx, JobDeps, JobReport, SendFailureCode } from './ports.js';

/**
 * The send's identity as a string: the done-set key and the source of the mailer's Message-ID. An ISO reminder adds its
 * subject, so two ISO records due the same day for the same person are two keys (`ISO_NOTIFICATION_DEDUPE_KEY`).
 */
export function sendKeyString(key: AnySendKey): string {
  if (key.eventId) return ['event', key.eventId, key.recipientId].join(':');
  const parts = [key.kind, key.instanceId ?? key.recipientId, key.recipientId, key.sendDate];
  if ('isoSubjectId' in key && key.isoSubjectId) {
    parts.push(`${key.isoSubjectType}:${key.isoSubjectId}`);
  }
  return parts.join(':');
}

function bump(report: JobReport, name: string): void {
  report[name] = (report[name] ?? 0) + 1;
}

/**
 * Claims the send-log row, sends, then records the outcome, each step its own transaction so no email is sent
 * while a transaction is open. A crash after sending and before recording leaves the row PENDING and the next
 * run sends again: at least once, but never again after DONE. `message` may be a function, called only once the
 * claim and the recipient checks pass, so a sign-in token is issued only for an email that is about to go.
 */
export async function deliver(
  deps: JobDeps,
  firmId: Id,
  requestId: string,
  key: AnySendKey,
  to: { name: string; email: string | null; canReceive: boolean },
  message: EmailMessage | (() => Promise<EmailMessage>),
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
  const content = typeof message === 'function' ? await message() : message;
  await deps.mailer.send({
    ...renderEmail(content),
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
        sourceEventId: key.eventId ?? null,
        ...('isoSubjectId' in key && {
          isoSubjectType: key.isoSubjectType,
          isoSubjectId: key.isoSubjectId,
        }),
      },
    }),
  );
  bump(report, 'sent');
}

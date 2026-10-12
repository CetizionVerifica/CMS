import type { LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { deliver, sendKeyString } from './send.js';
import { harness } from './testing/builders.js';
import { memoryFirm } from './testing/memory-store.js';

const key = {
  clientId: '0190a000-0000-7000-8000-000000000001',
  instanceId: null,
  recipientId: '0190a000-0000-7000-8000-000000000002',
  kind: 'CONSULTANT_DIGEST' as const,
  sendDate: '2026-10-12' as LocalDate,
};
const message = {
  kind: 'CONSULTANT_DIGEST' as const,
  recipientName: 'Meera Iyer',
  asOf: '2026-10-12' as LocalDate,
  fyLabel: '2026-27',
  clients: [],
};

describe('deliver', () => {
  it('skips a key the send log already has as sent, even when the pre-check missed it', async () => {
    const firm = memoryFirm();
    firm.sends.push({
      ...key,
      id: '0190a000-0000-7000-8000-000000000009',
      sentAt: '2026-10-12T01:30:00Z',
      failureCode: null,
    });
    const h = harness([firm]);
    const report = {};
    await deliver(
      h.deps,
      firm.id,
      'job:t',
      key,
      { name: 'Meera', email: 'm@example.com', canReceive: true },
      message,
      'test',
      report,
    );
    expect(h.mailer.sent).toEqual([]);
    expect(report).toEqual({ alreadySent: 1 });
  });

  it('resends a PENDING key left by a crash after claiming', async () => {
    const firm = memoryFirm();
    firm.sends.push({
      ...key,
      id: '0190a000-0000-7000-8000-000000000009',
      sentAt: null,
      failureCode: null,
    });
    const h = harness([firm]);
    await deliver(
      h.deps,
      firm.id,
      'job:t',
      key,
      { name: 'Meera', email: 'm@example.com', canReceive: true },
      message,
      'test',
      {},
    );
    expect(h.mailer.sent).toHaveLength(1);
    expect(h.store.firms[0]!.sends).toHaveLength(1);
    expect(h.store.firms[0]!.events[0]).toMatchObject({
      type: 'notification.sent',
      aggregate: { type: 'notification_send', id: '0190a000-0000-7000-8000-000000000009' },
      aggregateVersion: 1,
      data: {
        kind: 'CONSULTANT_DIGEST',
        instanceId: null,
        recipientId: key.recipientId,
        sendDate: '2026-10-12',
      },
    });
  });

  it('builds a stable idempotency key', () => {
    expect(sendKeyString(key)).toBe(
      `CONSULTANT_DIGEST:${key.recipientId}:${key.recipientId}:2026-10-12`,
    );
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_CONSUMERS } from './account-setup.js';
import { activeConsumers, CONSUMERS } from './consumers.js';
import type { JobDeps, LibraryCopier, OutboxEvent } from './ports.js';
import { harness } from './testing/builders.js';
import { memoryFirm } from './testing/memory-store.js';

const consumer = ACCOUNT_CONSUMERS.find((c) => c.type === 'account.created')!;

function created(accountId: string, data: Record<string, unknown> = {}): OutboxEvent {
  return {
    id: randomUUID(),
    type: 'account.created',
    schemaVersion: 1,
    occurredAt: '2026-10-24T03:00:00.000Z',
    firmId: accountId,
    clientId: null,
    actor: { kind: 'OPERATOR', operatorId: randomUUID() },
    requestId: 'req:create',
    aggregate: { type: 'account', id: accountId },
    aggregateVersion: 1,
    data: { accountId, kind: 'ENTERPRISE', planCode: 'BUSINESS', status: 'PROVISIONING', ...data },
  };
}

function deps(copyLibrary?: LibraryCopier): JobDeps {
  const { deps } = harness([memoryFirm()]);
  return { ...deps, ...(copyLibrary && { copyLibrary }) };
}

describe('account.created', () => {
  it("copies the master library into the new account with the run's request id", async () => {
    const copy = vi.fn<LibraryCopier>().mockResolvedValue({
      copied: true,
      categories: 1,
      acts: 2,
      obligations: 5,
    });
    const accountId = randomUUID();
    expect(await consumer.handle(deps(copy), created(accountId), 'run:1')).toEqual({
      copied: 1,
      categories: 1,
      acts: 2,
      obligations: 5,
    });
    expect(copy).toHaveBeenCalledExactlyOnceWith(accountId, 'run:1');
  });

  it('reports a repeated delivery that the copier skipped', async () => {
    const copy = vi
      .fn<LibraryCopier>()
      .mockResolvedValue({ copied: false, categories: 0, acts: 0, obligations: 0 });
    expect(await consumer.handle(deps(copy), created(randomUUID()), 'run:2')).toEqual({
      copied: 0,
      categories: 0,
      acts: 0,
      obligations: 0,
    });
  });

  it('refuses an event naming another account than its own outbox', async () => {
    const copy = vi.fn<LibraryCopier>();
    await expect(
      consumer.handle(deps(copy), created(randomUUID(), { accountId: randomUUID() }), 'run:3'),
    ).rejects.toThrow('names another account');
    expect(copy).not.toHaveBeenCalled();
  });

  it('refuses an event without an account id, and a run without the copier', async () => {
    await expect(
      consumer.handle(deps(vi.fn()), created(randomUUID(), { accountId: 'nope' }), 'run:4'),
    ).rejects.toThrow();
    await expect(consumer.handle(deps(), created(randomUUID()), 'run:5')).rejects.toThrow(
      'A new account needs copyLibrary',
    );
  });
});

describe('activeConsumers', () => {
  const types = (list: { type: string }[]) => list.map((c) => c.type);
  const full: JobDeps = {
    ...deps(vi.fn()),
    issueLoginToken: async () => ({ token: 't', expiresAt: '2026-10-24T04:00:00.000Z' }),
  };

  it('registers every consumer with mail, the issuer and the copier', () => {
    expect(types(activeConsumers(full, true))).toEqual(types([...CONSUMERS]));
    expect(types(activeConsumers(full, true))).toContain('account.created');
  });

  it('leaves the library copy off without the copier, and only it', () => {
    const active = types(activeConsumers({ ...full, copyLibrary: undefined }, true));
    expect(active).not.toContain('account.created');
    expect(active).toHaveLength(CONSUMERS.length - 1);
  });

  it('leaves the sign-in emails off without the issuer, and the senders off without mail', () => {
    expect(types(activeConsumers({ ...full, issueLoginToken: undefined }, true))).not.toContain(
      'person.invited',
    );
    const quiet = activeConsumers(full, false);
    expect(quiet.every((c) => !c.sendsMail)).toBe(true);
    expect(types(quiet)).toContain('account.created');
  });
});

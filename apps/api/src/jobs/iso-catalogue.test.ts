import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { activeConsumers } from './consumers.js';
import {
  ISO_CATALOGUE_CONSUMERS,
  ISO_CATALOGUE_SWEEP,
  runIsoCatalogueSweep,
} from './iso-catalogue.js';
import type { IsoCatalogueCopier, JobDeps, OutboxEvent } from './ports.js';
import { JOBS } from './runner.js';
import { harness } from './testing/builders.js';
import { memoryFirm, type MemoryFirm } from './testing/memory-store.js';

const consumer = ISO_CATALOGUE_CONSUMERS.find((c) => c.type === 'account.features_changed')!;
const COPIED_AT = '2026-10-25T10:00:00.000Z';

function changed(
  accountId: string,
  added: string[],
  removed: string[] = [],
  data: Record<string, unknown> = {},
): OutboxEvent {
  return {
    id: randomUUID(),
    type: 'account.features_changed',
    schemaVersion: 1,
    occurredAt: '2026-10-25T09:55:00.000Z',
    firmId: accountId,
    clientId: null,
    actor: { kind: 'OPERATOR', operatorId: randomUUID() },
    requestId: 'req:override',
    aggregate: { type: 'account', id: accountId },
    aggregateVersion: 2,
    data: { accountId, added, removed, ...data },
  };
}

function firmWith(features: string[], status: MemoryFirm['status'] = 'ACTIVE'): MemoryFirm {
  return { ...memoryFirm(), features, status };
}

/**
 * Behaves like M6's `copyIsoCatalogue` on the memory firms: copies only with the feature, in TRIAL or ACTIVE, and once
 * (its own record, as the real marker under the row lock), marking the firm as the marker does. The memory store
 * replaces a firm's object on every transaction, so firms are looked up in the array at call time.
 */
function fakeCopier(firms: MemoryFirm[]) {
  const copied = new Set<string>();
  return vi.fn<IsoCatalogueCopier>(async (accountId) => {
    const firm = firms.find((f) => f.id === accountId)!;
    if (
      !firm.features.includes('isoManagement') ||
      !['TRIAL', 'ACTIVE'].includes(firm.status) ||
      copied.has(accountId)
    ) {
      return { copied: false };
    }
    copied.add(accountId);
    firm.isoCatalogueCopiedAt = COPIED_AT;
    return { copied: true };
  });
}

const current = (firms: MemoryFirm[], id: string) => firms.find((f) => f.id === id)!;

function setup(firms: MemoryFirm[], copy?: IsoCatalogueCopier): JobDeps {
  const { deps } = harness(firms);
  return { ...deps, ...(copy && { copyIsoCatalogue: copy }) };
}

describe('account.features_changed', () => {
  it('copies once for the event twice and a sweep at once', async () => {
    const firms = [firmWith(['isoManagement'])];
    const id = firms[0]!.id;
    const copy = fakeCopier(firms);
    const deps = setup(firms, copy);
    const event = changed(id, ['isoManagement']);
    const reports = await Promise.all([
      consumer.handle(deps, event, 'job:a'),
      consumer.handle(deps, event, 'job:b'),
      runIsoCatalogueSweep(deps, 'job:sweep'),
    ]);
    const outcomes = await Promise.all(
      copy.mock.results.map((r) => r.value as Promise<{ copied: boolean }>),
    );
    expect(outcomes.filter((o) => o.copied)).toHaveLength(1);
    expect(reports.reduce((n, r) => n + r.copied!, 0)).toBe(1);
    // A later redelivery reaches the copier, which copies nothing more.
    expect(await consumer.handle(deps, event, 'job:c')).toEqual({ copied: 0 });
  });

  it("passes the account and the run's request id to the copier", async () => {
    const firm = firmWith(['isoManagement']);
    const copy = fakeCopier([firm]);
    expect(
      await consumer.handle(setup([firm], copy), changed(firm.id, ['isoManagement']), 'job:1'),
    ).toEqual({ copied: 1 });
    expect(copy).toHaveBeenCalledExactlyOnceWith(firm.id, 'job:1');
  });

  it('does not call the copier when isoManagement is not among the added flags', async () => {
    const firm = firmWith([]);
    const copy = fakeCopier([firm]);
    const deps = setup([firm], copy);
    expect(await consumer.handle(deps, changed(firm.id, ['importer']), 'job:1')).toEqual({
      copied: 0,
    });
    expect(await consumer.handle(deps, changed(firm.id, [], ['isoManagement']), 'job:2')).toEqual({
      copied: 0,
    });
    expect(copy).not.toHaveBeenCalled();
  });

  it('acknowledges copied: false for an account not yet in TRIAL or ACTIVE, and a later sweep copies', async () => {
    const firms = [firmWith(['isoManagement'], 'PROVISIONING')];
    const id = firms[0]!.id;
    const copy = fakeCopier(firms);
    const deps = setup(firms, copy);
    expect(await consumer.handle(deps, changed(id, ['isoManagement']), 'job:1')).toEqual({
      copied: 0,
    });
    expect(current(firms, id).isoCatalogueCopiedAt).toBeNull();
    // The sweep leaves a PROVISIONING account alone; once ACTIVE it copies.
    expect(await runIsoCatalogueSweep(deps, 'job:sweep:1')).toMatchObject({ firms: 0, copied: 0 });
    current(firms, id).status = 'ACTIVE';
    expect(await runIsoCatalogueSweep(deps, 'job:sweep:2')).toEqual({
      firms: 1,
      copied: 1,
      notCopied: 0,
    });
    expect(current(firms, id).isoCatalogueCopiedAt).toBe(COPIED_AT);
    expect(copy).toHaveBeenCalledTimes(2);
  });

  it('fails loudly without the copier, so pg-boss retries the event', async () => {
    const firm = firmWith(['isoManagement']);
    await expect(
      consumer.handle(setup([firm]), changed(firm.id, ['isoManagement']), 'job:1'),
    ).rejects.toThrow('The ISO add-on needs copyIsoCatalogue');
  });

  it('refuses an event naming another account than its own outbox, or with malformed data', async () => {
    const firm = firmWith(['isoManagement']);
    const copy = fakeCopier([firm]);
    const deps = setup([firm], copy);
    await expect(
      consumer.handle(
        deps,
        changed(firm.id, ['isoManagement'], [], { accountId: randomUUID() }),
        'job:1',
      ),
    ).rejects.toThrow('names another account');
    await expect(
      consumer.handle(
        deps,
        changed(firm.id, ['isoManagement'], [], { added: 'isoManagement' }),
        'job:2',
      ),
    ).rejects.toThrow();
    expect(copy).not.toHaveBeenCalled();
  });

  it('stays registered without the copier, so a switch-on is retried, not dropped', () => {
    const deps = setup([memoryFirm()]);
    expect(activeConsumers(deps, false).map((c) => c.type)).toContain('account.features_changed');
  });
});

describe(ISO_CATALOGUE_SWEEP, () => {
  it('runs every 10 minutes, without mail', () => {
    expect(JOBS.find((j) => j.name === ISO_CATALOGUE_SWEEP)).toMatchObject({
      cron: '*/10 * * * *',
      tz: 'UTC',
      sendsMail: false,
    });
  });

  it('copies only TRIAL and ACTIVE accounts with the feature and no recorded copy', async () => {
    const trial = firmWith(['isoManagement'], 'TRIAL');
    const active = firmWith(['isoManagement']);
    const done = {
      ...firmWith(['isoManagement']),
      isoCatalogueCopiedAt: '2026-10-20T00:00:00.000Z',
    };
    const without = firmWith([]);
    const suspended = firmWith(['isoManagement'], 'SUSPENDED');
    const closing = firmWith(['isoManagement'], 'PENDING_DELETION');
    const firms = [trial, active, done, without, suspended, closing];
    const copy = fakeCopier(firms);
    expect(await runIsoCatalogueSweep(setup(firms, copy), 'job:sweep')).toEqual({
      firms: 2,
      copied: 2,
      notCopied: 0,
    });
    expect(copy.mock.calls.map(([id]) => id).sort()).toEqual([trial.id, active.id].sort());
  });

  it('needs no copier while no account is due', async () => {
    const firms = [
      firmWith([]),
      { ...firmWith(['isoManagement']), isoCatalogueCopiedAt: COPIED_AT },
    ];
    expect(await runIsoCatalogueSweep(setup(firms), 'job:sweep')).toEqual({
      firms: 0,
      copied: 0,
      notCopied: 0,
    });
  });

  it('copies the other accounts when one fails, then fails the run so it is retried', async () => {
    const firms = [firmWith(['isoManagement']), firmWith(['isoManagement'])];
    const [failing, ok] = firms.map((f) => f.id) as [string, string];
    const real = fakeCopier(firms);
    const copy = vi.fn<IsoCatalogueCopier>(async (accountId, requestId) => {
      if (accountId === failing) throw new Error('copy failed');
      return real(accountId, requestId);
    });
    await expect(runIsoCatalogueSweep(setup(firms, copy), 'job:sweep')).rejects.toThrow(
      `${ISO_CATALOGUE_SWEEP}: 1 account(s) failed`,
    );
    expect(current(firms, ok).isoCatalogueCopiedAt).toBe(COPIED_AT);
    expect(current(firms, failing).isoCatalogueCopiedAt).toBeNull();
  });

  it('counts a copy the copier skipped, and fails without the copier when an account is due', async () => {
    const firm = firmWith(['isoManagement']);
    const skip = vi.fn<IsoCatalogueCopier>().mockResolvedValue({ copied: false });
    expect(await runIsoCatalogueSweep(setup([firm], skip), 'job:1')).toEqual({
      firms: 1,
      copied: 0,
      notCopied: 1,
    });
    await expect(runIsoCatalogueSweep(setup([firm]), 'job:2')).rejects.toThrow(
      `${ISO_CATALOGUE_SWEEP}: 1 account(s) failed`,
    );
  });
});

import type { LocalDate } from '@canopy/contracts';
import { ENGINE_VERSION } from '@canopy/engine';
import { describe, expect, it } from 'vitest';
import { memoisedGenerator, runGenerateInstances, skipReason } from './generate-instances.js';
import { assignment, harness, instance, person } from './testing/builders.js';
import { memoryClient, memoryFirm } from './testing/memory-store.js';

function setup() {
  const firm = memoryFirm();
  const client = memoryClient('Kestrel Metals Group');
  const owner = person({ clientIds: [client.id] });
  const approver = person({ displayName: 'Vikram Shah', clientIds: [client.id] });
  firm.clients.push(client);
  firm.people.push(owner, approver);
  const a = assignment(client, owner, approver);
  firm.assignments.push(a);
  return { firm, client, owner, approver, a };
}

describe('generate-instances', () => {
  it('creates the current and next FY in the client time zone, with one audit row per instance', async () => {
    const { firm, a } = setup();
    const h = harness([firm]);
    h.at('2026-10-11T20:00:00Z'); // 12 Oct 01:30 IST
    const report = await runGenerateInstances(h.deps, 'job:test:1');

    const [stored] = h.store.firms;
    // Monthly on day 7 of the next month: due dates 7 Apr 2026 ... 7 Mar 2028 (FY 2026-27 and 2027-28).
    expect(stored!.instances).toHaveLength(24);
    expect(stored!.instances.map((i) => i.dueDate).sort()[0]).toBe('2026-04-07');
    expect(
      stored!.instances
        .map((i) => i.dueDate)
        .sort()
        .at(-1),
    ).toBe('2028-03-07');
    expect(
      stored!.instances.every((i) => i.workflowState === 'OPEN' && i.ownerId === a.ownerId),
    ).toBe(true);
    expect(report).toMatchObject({ firms: 1, clients: 1, created: 24, existing: 0 });

    expect(stored!.audits).toHaveLength(24);
    expect(stored!.audits[0]).toMatchObject({
      actorKind: 'SYSTEM',
      actorId: null,
      action: 'CREATE',
      entityType: 'instance',
      requestId: 'job:test:1',
      before: null,
      after: { assignmentId: a.assignmentId, workflowState: 'OPEN', engineVersion: ENGINE_VERSION },
    });
    expect(stored!.audits.map((e) => e.entityId).sort()).toEqual(
      stored!.instances.map((i) => i.id).sort(),
    );

    expect(stored!.events).toHaveLength(24);
    const first = stored!.instances.find((i) => i.dueDate === '2026-04-07')!;
    expect(stored!.events).toContainEqual(
      expect.objectContaining({
        type: 'instance.generated',
        aggregate: { type: 'instance', id: first.id },
        aggregateVersion: 1,
        data: {
          instanceId: first.id,
          assignmentId: a.assignmentId,
          periodStart: first.periodStart,
          periodEnd: first.periodEnd,
          dueDate: '2026-04-07',
          engineVersion: ENGINE_VERSION,
        },
      }),
    );
  });

  it('is idempotent: a second run creates nothing and writes no audit or event', async () => {
    const { firm } = setup();
    const h = harness([firm]);
    await runGenerateInstances(h.deps, 'job:test:1');
    const second = await runGenerateInstances(h.deps, 'job:test:2');
    expect(second.created).toBe(0);
    expect(h.store.firms[0]!.instances).toHaveLength(24);
    expect(h.store.firms[0]!.audits).toHaveLength(24);
    expect(h.store.firms[0]!.events).toHaveLength(24);
  });

  it('counts a row the database already had (a concurrent run) as existing, not created', async () => {
    const { firm, a } = setup();
    const h = harness([firm]);
    // Same period start as a generated period, but a due date outside the range, so only the insert's
    // ON CONFLICT sees it, as with a run that committed between this run's read and its insert.
    firm.instances.push(instance(a, '2026-03-07', { periodStart: '2026-04-01' as LocalDate }));
    const report = await runGenerateInstances(h.deps, 'job:test:1');
    expect(report.created).toBe(23);
    expect(report.existing).toBe(1);
    expect(h.store.firms[0]!.audits).toHaveLength(23);
  });

  it('switches to FY 2027-28 and 2028-29 when 1 Apr starts in India, before UTC midnight', async () => {
    const { firm } = setup();
    const h = harness([firm]);
    h.at('2027-03-31T18:30:00Z'); // 1 Apr 2027 00:00 IST
    await runGenerateInstances(h.deps, 'job:test:1');
    const dates = h.store.firms[0]!.instances.map((i) => i.dueDate).sort();
    expect(dates[0]).toBe('2027-04-07');
    expect(dates.at(-1)).toBe('2029-03-07');
  });

  it('does not create a twin of an imported instance that has a different period start but the same due date', async () => {
    const { firm, a } = setup();
    firm.instances.push(instance(a, '2026-05-07', { periodStart: '2026-04-15' as LocalDate }));
    const h = harness([firm]);
    const report = await runGenerateInstances(h.deps, 'job:test:1');
    expect(report.created).toBe(23);
    expect(h.store.firms[0]!.instances.filter((i) => i.dueDate === '2026-05-07')).toHaveLength(1);
  });

  it('keeps to the assignment active window', async () => {
    const { firm, a } = setup();
    a.activeFrom = '2027-01-01' as LocalDate;
    a.activeTo = '2027-06-30' as LocalDate;
    const h = harness([firm]);
    await runGenerateInstances(h.deps, 'job:test:1');
    expect(h.store.firms[0]!.instances.map((i) => i.dueDate).sort()).toEqual([
      '2027-01-07',
      '2027-02-07',
      '2027-03-07',
      '2027-04-07',
      '2027-05-07',
      '2027-06-07',
    ]);
  });

  it('creates nothing for an assignment whose active window ended before the range', async () => {
    const { firm, a } = setup();
    a.activeTo = '2025-12-31' as LocalDate;
    const h = harness([firm]);
    const report = await runGenerateInstances(h.deps, 'job:test:1');
    expect(report.created).toBe(0);
    expect(h.store.firms[0]!.events).toEqual([]);
  });

  it('skips not-applicable, to-assess, event-driven and unconfirmed assignments', async () => {
    const { firm, client, owner, approver } = setup();
    firm.assignments = [
      assignment(client, owner, approver, { applicability: 'NOT_APPLICABLE' }),
      assignment(client, owner, approver, { applicability: 'TO_ASSESS' }),
      assignment(client, owner, approver, {
        recurrenceRule: { kind: 'EVENT_DRIVEN', trigger: 'Accident', withinDays: 7 },
      }),
      assignment(client, owner, approver, { ruleStatus: 'TO_REVIEW' }),
    ];
    const h = harness([firm]);
    const report = await runGenerateInstances(h.deps, 'job:test:1');
    expect(h.store.firms[0]!.instances).toEqual([]);
    expect(report).toMatchObject({
      skippedNOT_APPLICABLE: 2,
      skippedEVENT_DRIVEN: 1,
      skippedRULE_TO_REVIEW: 1,
    });
  });

  it('rolls back only the failing client and still fails the job so it is retried', async () => {
    const { firm, client, owner, approver } = setup();
    const other = memoryClient('Osprey Textiles Group');
    firm.clients.push(other);
    firm.assignments.push(assignment(other, owner, approver));
    let calls = 0;
    const h = harness([firm], {
      beforeInsert: () => {
        calls += 1;
        if (calls === 1) throw new Error('deadlock detected');
      },
    });
    await expect(runGenerateInstances(h.deps, 'job:test:1')).rejects.toThrow('1 client(s) failed');
    const stored = h.store.firms[0]!;
    expect(stored.instances.filter((i) => i.clientId === client.id)).toEqual([]);
    expect(stored.audits.every((e) => e.clientId === other.id)).toBe(true);
    expect(stored.instances.filter((i) => i.clientId === other.id)).toHaveLength(24);
    // The retry fills in the client that failed.
    await runGenerateInstances(h.deps, 'job:test:1');
    expect(h.store.firms[0]!.instances).toHaveLength(48);
  });

  it('keeps firms apart: each firm only gets rows for its own assignments', async () => {
    const one = setup();
    const two = setup();
    const h = harness([one.firm, two.firm]);
    const report = await runGenerateInstances(h.deps, 'job:test:1');
    expect(report.firms).toBe(2);
    for (const [firm, a] of [
      [h.store.firms[0]!, one.a],
      [h.store.firms[1]!, two.a],
    ] as const) {
      expect(firm.instances.every((i) => i.assignmentId === a.assignmentId)).toBe(true);
      expect(firm.instances).toHaveLength(24);
    }
  });
});

describe('memoisedGenerator', () => {
  it('calls the engine once per rule, range and calendar', () => {
    const { client } = setup();
    const generate = memoisedGenerator();
    const range = { from: '2026-04-01' as LocalDate, to: '2027-03-31' as LocalDate };
    const rule = { kind: 'MONTHLY', day: 7, offsetMonths: 1 } as const;
    const first = generate(rule, range, client.settings);
    expect(generate({ ...rule }, range, client.settings)).toBe(first);
    expect(generate(rule, range, { ...client.settings, fyStartMonth: 1 })).not.toBe(first);
  });
});

describe('skipReason', () => {
  it('generates for an applicable, confirmed, recurring assignment', () => {
    const { a } = setup();
    expect(skipReason(a)).toBeNull();
  });
});

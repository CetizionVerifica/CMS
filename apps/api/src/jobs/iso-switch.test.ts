import { randomUUID } from 'node:crypto';
import type { LocalDate } from '@canopy/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CONSUMERS } from './consumers.js';
import { runConsultantDigest } from './digest.js';
import { generateForScope, runGenerateInstances } from './generate-instances.js';
import { runIsoCatalogueSweep } from './iso-catalogue.js';
import type { OutboxEvent } from './ports.js';
import { runReminders } from './reminders.js';
import { assignment, harness, instance, person } from './testing/builders.js';
import { memoryClient, memoryFirm, type MemoryFirm } from './testing/memory-store.js';

// 12 Oct 2026 is a Monday (the default digest day); 07:00 IST is 01:30Z.
const SEND_TIME = '2026-10-12T01:30:00.000Z';
const COPIED_AT = '2026-10-01T00:00:00.000Z';

type Switch = 'on' | 'off' | 'notCopied';

/** A firm with one statutory and one ISO-standard assignment, and the add-on as given. */
function setup(state: Switch) {
  const firm: MemoryFirm = {
    ...memoryFirm(),
    features: state === 'off' ? [] : ['isoManagement'],
    isoCatalogueCopiedAt: state === 'on' ? COPIED_AT : null,
  };
  const client = memoryClient('Kestrel Metals Group');
  const owner = person({ displayName: 'Asha Rao', clientIds: [client.id] });
  const approver = person({ displayName: 'Vikram Shah', clientIds: [client.id] });
  const consultant = person({ displayName: 'Meera Iyer', consultantFor: [client.id] });
  firm.clients.push(client);
  firm.people.push(owner, approver, consultant);
  const law = assignment(client, owner, approver, { criticality: 'HIGH' });
  const iso = assignment(client, owner, approver, {
    actKind: 'STANDARD',
    title: 'Review the quality policy',
    actName: 'ISO 9001',
    criticality: 'HIGH',
  });
  firm.assignments.push(law, iso);
  const h = harness([firm]);
  h.at(SEND_TIME);
  return { firm, client, owner, approver, law, iso, h };
}

const stored = (w: ReturnType<typeof setup>) => w.h.store.firms[0]!;
const subjects = (w: ReturnType<typeof setup>) => w.h.mailer.sent.map((m) => m.subject).sort();

describe('generate-instances with the ISO add-on', () => {
  it.each<Switch>(['off', 'notCopied'])(
    'generates nothing for a STANDARD obligation when the add-on is %s',
    async (state) => {
      const w = setup(state);
      const report = await runGenerateInstances(w.h.deps, 'job:g');
      const made = stored(w).instances;
      expect(made.length).toBeGreaterThan(0);
      expect(made.every((i) => i.assignmentId === w.law.assignmentId)).toBe(true);
      expect(report).toMatchObject({ skippedIsoOff: 1 });
    },
  );

  it('generates STANDARD obligations once the add-on is on and its catalogue copied', async () => {
    const w = setup('on');
    const report = await runGenerateInstances(w.h.deps, 'job:g');
    const byAssignment = new Set(stored(w).instances.map((i) => i.assignmentId));
    expect(byAssignment).toEqual(new Set([w.law.assignmentId, w.iso.assignmentId]));
    expect(report.skippedIsoOff).toBeUndefined();
  });

  it('applies the switch to a targeted run too', async () => {
    const w = setup('off');
    await generateForScope(
      w.h.deps,
      w.firm.id,
      { clientIds: 'ALL', assignmentIds: [w.iso.assignmentId] },
      'job:scope',
    );
    expect(stored(w).instances).toEqual([]);
  });
});

describe('reminders with the ISO add-on', () => {
  function withDueToday(state: Switch) {
    const w = setup(state);
    // Both due today: the owner's T-0 reminder.
    w.firm.instances.push(instance(w.law, '2026-10-12'), instance(w.iso, '2026-10-12'));
    // An overdue STANDARD instance would be escalated to the approver at +1.
    w.firm.instances.push(instance(w.iso, '2026-10-11'));
    return w;
  }

  it('sends no reminder or escalation for a STANDARD instance when the add-on is off', async () => {
    const w = withDueToday('off');
    expect(await runReminders(w.h.deps, 'job:r')).toMatchObject({ sent: 1 });
    expect(subjects(w)).toEqual(['Due today: Deposit TDS for the month']);
    expect(stored(w).sends.every((s) => s.instanceId === stored(w).instances[0]!.id)).toBe(true);
  });

  it('reminds and escalates STANDARD instances while the add-on is on', async () => {
    const w = withDueToday('on');
    expect(await runReminders(w.h.deps, 'job:r')).toMatchObject({ sent: 3 });
    expect(subjects(w)).toEqual(
      [
        'Due today: Deposit TDS for the month',
        'Due today: Review the quality policy',
        'Not submitted, overdue 1 day: Review the quality policy',
      ].sort(),
    );
  });
});

describe('workflow emails with the ISO add-on', () => {
  function submitted(state: Switch) {
    const w = setup(state);
    const i = instance(w.iso, '2026-10-15', {
      workflowState: 'SUBMITTED',
      pendingKind: 'COMPLETION',
    });
    w.firm.instances.push(i);
    const event: OutboxEvent = {
      id: randomUUID(),
      type: 'instance.submitted',
      schemaVersion: 1,
      occurredAt: '2026-10-12T01:29:00.000Z',
      firmId: w.firm.id,
      clientId: w.client.id,
      actor: { kind: 'PERSON', personId: w.owner.id },
      requestId: 'req:submit',
      aggregate: { type: 'compliance_instance', id: i.id },
      aggregateVersion: i.version,
      data: { instanceId: i.id },
    };
    const consumer = CONSUMERS.find((c) => c.type === 'instance.submitted')!;
    return { ...w, event, handle: () => consumer.handle(w.h.deps, event, `job:${event.id}`) };
  }

  it('sends nothing for an event queued before the add-on was switched off', async () => {
    const w = submitted('on');
    // The operator switches the add-on off after the event was queued, before it is handled.
    stored(w).features = [];
    expect(await w.handle()).toMatchObject({ sent: 0 });
    expect(w.h.mailer.sent).toEqual([]);
    expect(stored(w).sends).toEqual([]);
  });

  it('emails the approver about a STANDARD instance while the add-on is on', async () => {
    const w = submitted('on');
    expect(await w.handle()).toEqual({ sent: 1 });
    expect(subjects(w)).toEqual(['Awaiting your approval: Review the quality policy']);
  });
});

describe('consultant digest with the ISO add-on', () => {
  /** The digest line for the client, with or without a due STANDARD instance in each digest figure. */
  async function digestLine(state: Switch, withIso: boolean): Promise<string> {
    const w = setup(state);
    w.firm.instances.push(
      instance(w.law, '2026-09-07', {
        workflowState: 'APPROVED',
        completedOn: '2026-09-05' as LocalDate,
      }),
      instance(w.law, '2026-10-07'), // overdue
      instance(w.law, '2026-10-15'), // due soon
    );
    if (withIso) {
      w.firm.instances.push(
        instance(w.iso, '2026-10-05'), // overdue
        instance(w.iso, '2026-10-14'), // due soon
        instance(w.iso, '2026-10-08', { workflowState: 'SUBMITTED', pendingKind: 'COMPLETION' }),
        instance(w.iso, '2026-09-10', {
          workflowState: 'APPROVED',
          completedOn: '2026-09-01' as LocalDate,
        }),
      );
    }
    expect(await runConsultantDigest(w.h.deps, 'job:d')).toMatchObject({ sent: 1 });
    const line = w.h.mailer.sent[0]!.text.split('\n').find((l) => l.startsWith('Kestrel Metals'))!;
    // Without the client's link, whose id differs between setups.
    return line.split(' https://')[0]!;
  }

  it.each<Switch>(['on', 'off'])(
    'leaves the score and counts unchanged by STANDARD instances with the add-on %s',
    async (state) => {
      const without = await digestLine(state, false);
      expect(without).toBe(
        'Kestrel Metals Group: score 50.0%, 1 overdue, 1 due soon, 0 awaiting approval.',
      );
      expect(await digestLine(state, true)).toBe(without);
    },
  );
});

describe('ISO catalogue sweep', () => {
  it('reads no account without the feature', async () => {
    const withIso = { ...memoryFirm(), features: ['isoManagement'] };
    const without = memoryFirm();
    const h = harness([withIso, without]);
    const withFirm = vi.spyOn(h.store, 'withFirm');
    const copy = vi.fn().mockResolvedValue({ copied: true });
    const report = await runIsoCatalogueSweep({ ...h.deps, copyIsoCatalogue: copy }, 'job:sweep');
    expect(report).toEqual({ firms: 1, copied: 1, notCopied: 0 });
    expect(withFirm.mock.calls.map(([id]) => id)).toEqual([withIso.id]);
    expect(copy).toHaveBeenCalledExactlyOnceWith(withIso.id, 'job:sweep');
  });
});

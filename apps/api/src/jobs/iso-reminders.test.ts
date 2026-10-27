import { randomUUID } from 'node:crypto';
import type { Id, LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { isoReminderInputs, ISO_REMINDERS, runIsoReminders } from './iso-reminders.js';
import type { IsoReminderData } from './ports.js';
import { JOBS } from './runner.js';
import { harness, person } from './testing/builders.js';
import { emptyIsoData, memoryClient, memoryFirm, type MemoryFirm } from './testing/memory-store.js';

// 07:00 IST on Monday 12 Oct 2026.
const SEND_TIME = '2026-10-12T01:30:00.000Z';
const TODAY = '2026-10-12' as LocalDate;
const d = (date: string) => date as LocalDate;

type Switch = 'on' | 'off' | 'notCopied';

/** A firm with one client, an owner, an approver and a client admin, and the add-on as given. */
function setup(state: Switch = 'on', fill: (data: IsoReminderData, p: People) => void = () => {}) {
  const firm: MemoryFirm = {
    ...memoryFirm(),
    features: state === 'off' ? [] : ['isoManagement'],
    isoCatalogueCopiedAt: state === 'on' ? '2026-10-01T00:00:00.000Z' : null,
  };
  const client = memoryClient('Kestrel Metals Group');
  const people = {
    owner: person({ displayName: 'Asha Rao', email: 'asha@example.com', clientIds: [client.id] }),
    approver: person({
      displayName: 'Vikram Shah',
      email: 'vikram@example.com',
      clientIds: [client.id],
    }),
    admin: person({
      displayName: 'Meera Iyer',
      email: 'meera@example.com',
      clientIds: [client.id],
    }),
  };
  firm.clients.push(client);
  firm.people.push(people.owner, people.approver, people.admin);
  const data = { ...emptyIsoData(), clientAdminIds: [people.admin.id] };
  fill(data, people);
  firm.iso[client.id] = data;
  const h = harness([firm]);
  h.at(SEND_TIME);
  return { firm, client, h, ...people };
}
type People = { owner: { id: Id }; approver: { id: Id }; admin: { id: Id } };

const action = (ownerId: Id, dueOn: string, text = 'Recalibrate the furnace gauges') => ({
  id: randomUUID(),
  text,
  dueOn: d(dueOn),
  ownerId,
  approverId: null,
});

const mailTo = (w: ReturnType<typeof setup>) =>
  w.h.mailer.sent
    .map((m) => [m.to.email, m.subject])
    .sort((a, b) => a.join().localeCompare(b.join()));

describe(ISO_REMINDERS, () => {
  it('runs every 15 minutes in UTC and sends mail', () => {
    expect(JOBS.find((j) => j.name === ISO_REMINDERS)).toMatchObject({
      cron: '*/15 * * * *',
      tz: 'UTC',
      sendsMail: true,
    });
  });

  it('emails one person twice for two actions due the same day, and a second run sends neither again', async () => {
    const w = setup('on', (data, p) => {
      data.actions.push(
        action(p.owner.id, '2026-10-12', 'Recalibrate the furnace gauges'),
        action(p.owner.id, '2026-10-12', 'Retrain the casting shift'),
      );
    });
    expect(await runIsoReminders(w.h.deps, 'job:iso:1')).toMatchObject({ sent: 2 });
    expect(mailTo(w)).toEqual([
      ['asha@example.com', 'Due today: Recalibrate the furnace gauges'],
      ['asha@example.com', 'Due today: Retrain the casting shift'],
    ]);
    const sends = w.h.store.firms[0]!.sends;
    expect(sends.map((s) => 'isoSubjectId' in s && s.isoSubjectId).sort()).toEqual(
      w.firm.iso[w.client.id]!.actions.map((a) => a.id).sort(),
    );
    expect(sends.every((s) => s.instanceId === null && s.kind === 'ISO_ACTION_DUE')).toBe(true);

    w.h.at('2026-10-12T01:45:00.000Z');
    expect(await runIsoReminders(w.h.deps, 'job:iso:2')).toMatchObject({
      sent: 0,
      alreadySent: 2,
    });
    expect(w.h.mailer.sent).toHaveLength(2);
    const events = w.h.store.firms[0]!.events.filter((e) => e.type === 'notification.sent');
    expect(events).toHaveLength(2);
    expect(events[0]!.data).toMatchObject({
      kind: 'ISO_ACTION_DUE',
      instanceId: null,
      isoSubjectType: 'iso_action',
    });
  });

  it('links each email to the record in the ISO screens', async () => {
    const w = setup('on', (data, p) => data.actions.push(action(p.owner.id, '2026-10-19')));
    await runIsoReminders(w.h.deps, 'job:iso');
    const id = w.firm.iso[w.client.id]!.actions[0]!.id;
    expect(w.h.mailer.sent[0]!.subject).toBe('Due in 7 days: Recalibrate the furnace gauges');
    expect(w.h.mailer.sent[0]!.text).toContain(
      `https://app.planetpulse.example/c/${w.client.id}/iso/actions?ids=${id}`,
    );
    expect(w.h.mailer.sent[0]!.text).toContain('19 Oct 2026');
  });

  it("uses the client's local date in Asia/Kolkata, not the UTC date", async () => {
    const w = setup('on', (data, p) => data.actions.push(action(p.owner.id, '2026-10-13')));
    w.client.settings.reminders.sendAtLocalTime = '01:00';
    w.h.store.firms[0]!.clients[0]!.settings.reminders.sendAtLocalTime = '01:00';
    w.h.at('2026-10-12T19:00:00.000Z'); // 13 Oct 00:30 IST: today is the 13th, before the send time
    expect(await runIsoReminders(w.h.deps, 'job:iso:1')).toMatchObject({
      sent: 0,
      clientsNotYetDue: 1,
    });
    w.h.at('2026-10-12T20:00:00.000Z'); // 13 Oct 01:30 IST, still the 12th in UTC
    expect(await runIsoReminders(w.h.deps, 'job:iso:2')).toMatchObject({ sent: 1 });
    expect(w.h.mailer.sent[0]!.subject).toBe('Due today: Recalibrate the furnace gauges');
    expect(w.h.store.firms[0]!.sends[0]!.sendDate).toBe('2026-10-13');
  });

  it('waits for the 07:00 IST send time', async () => {
    const w = setup('on', (data, p) => data.actions.push(action(p.owner.id, '2026-10-12')));
    w.h.at('2026-10-12T01:29:00.000Z');
    expect(await runIsoReminders(w.h.deps, 'job:iso')).toMatchObject({ sent: 0 });
    expect(w.h.mailer.sent).toEqual([]);
  });

  it.each<Switch>(['off', 'notCopied'])('sends nothing while the add-on is %s', async (state) => {
    const w = setup(state, (data, p) => data.actions.push(action(p.owner.id, '2026-10-12')));
    expect(await runIsoReminders(w.h.deps, 'job:iso')).toMatchObject({ firms: 0, sent: 0 });
    expect(w.h.mailer.sent).toEqual([]);
  });

  it('sends nothing to a suspended account', async () => {
    const w = setup('on', (data, p) => data.actions.push(action(p.owner.id, '2026-10-12')));
    w.h.store.firms[0]!.status = 'SUSPENDED';
    expect(await runIsoReminders(w.h.deps, 'job:iso')).toMatchObject({ firms: 0, sent: 0 });
  });

  it('escalates an action overdue 7 days to the subject approver, else the client admins', async () => {
    const w = setup('on', (data, p) => {
      data.actions.push(
        { ...action(p.owner.id, '2026-10-05', 'Fix the NC'), approverId: p.approver.id },
        action(p.owner.id, '2026-10-05', 'Fix the risk'),
      );
    });
    await runIsoReminders(w.h.deps, 'job:iso');
    expect(mailTo(w)).toEqual([
      ['meera@example.com', 'Action overdue 7 days: Fix the risk'],
      ['vikram@example.com', 'Action overdue 7 days: Fix the NC'],
    ]);
  });

  it('logs a failed send for a recipient who cannot receive mail, without an address', async () => {
    const w = setup('on', (data, p) => data.actions.push(action(p.owner.id, '2026-10-12')));
    w.h.store.firms[0]!.people[0]!.email = null;
    await runIsoReminders(w.h.deps, 'job:iso');
    expect(w.h.mailer.sent).toEqual([]);
    expect(w.h.store.firms[0]!.sends[0]).toMatchObject({ failureCode: 'NO_EMAIL' });
  });
});

describe('isoReminderInputs', () => {
  const settings = { dueSoonDays: 7 };
  const planFor = (data: Partial<IsoReminderData>) =>
    isoReminderInputs({ ...emptyIsoData(), clientAdminIds: ['admin'], ...data }, TODAY, settings);

  it('passes closed subjects with open: false, so the engine sends nothing for them', () => {
    const items = planFor({
      internalAudits: (['PLANNED', 'IN_PROGRESS', 'REPORTED', 'CLOSED', 'CANCELLED'] as const).map(
        (state) => ({
          id: state,
          title: 'Casting line audit',
          state,
          plannedStart: d('2026-10-19'),
          leadAuditorId: 'lead',
          auditorIds: ['aud'],
          auditeeIds: ['auditee'],
        }),
      ),
      externalAudits: (['PLANNED', 'HELD', 'RESPONDED', 'CLOSED', 'CANCELLED'] as const).map(
        (state) => ({
          id: state,
          managementSystemId: 'sys',
          standardIds: ['std'],
          type: 'SURVEILLANCE_1',
          state,
          body: 'Egret Certification',
          endOn: d('2026-10-01'),
          responseDueOn: d('2026-10-12'),
          openNcOwnerIds: ['nc-owner'],
        }),
      ),
      reviews: (['PLANNED', 'HELD', 'CLOSED', 'CANCELLED'] as const).map((state) => ({
        id: state,
        managementSystemId: 'sys',
        standards: ['ISO_9001'],
        plannedOn: d('2026-10-12'),
        heldOn: state === 'HELD' || state === 'CLOSED' ? d('2026-10-12') : null,
        state,
        chairId: 'chair',
      })),
      nonconformities: (['OPEN', 'AWAITING_VERIFICATION', 'CLOSED', 'CANCELLED'] as const).map(
        (state, number) => ({
          id: state,
          number,
          state,
          effectivenessDueOn: d('2026-10-12'),
          approverId: 'nc-approver',
        }),
      ),
    });
    const open = (kind: string) =>
      items
        .filter((i) => i.kind === kind && i.open)
        .map((i) => i.isoSubjectId)
        .sort();
    expect(open('ISO_AUDIT_STARTING')).toEqual(['PLANNED']);
    expect(open('ISO_EXTERNAL_RESPONSE_DUE')).toEqual(['HELD', 'PLANNED']);
    expect(
      items
        .filter(
          (i) =>
            i.kind === 'ISO_MANAGEMENT_REVIEW_DUE' &&
            i.isoSubjectType === 'management_review' &&
            i.open,
        )
        .map((i) => i.isoSubjectId),
    ).toEqual(['PLANNED']);
    expect(open('ISO_EFFECTIVENESS_DUE')).toEqual(['AWAITING_VERIFICATION', 'OPEN']);
  });

  it('names the recipients of the model §7 table', () => {
    const items = planFor({
      documents: [
        {
          id: 'doc',
          code: 'QP-01',
          title: 'Quality policy',
          reviewDueOn: TODAY,
          ownerId: 'doc-owner',
          approverId: 'doc-approver',
        },
      ],
      risks: [
        { id: 'risk', activity: 'Furnace tapping', reviewDueOn: TODAY, ownerId: 'risk-owner' },
      ],
      internalAudits: [
        {
          id: 'audit',
          title: 'Casting line audit',
          state: 'PLANNED',
          plannedStart: TODAY,
          leadAuditorId: 'lead',
          auditorIds: ['aud'],
          auditeeIds: ['auditee'],
        },
      ],
      externalAudits: [
        {
          id: 'ext',
          managementSystemId: 'sys',
          standardIds: ['std'],
          type: 'STAGE_2',
          state: 'HELD',
          body: 'Egret Certification',
          endOn: d('2026-10-01'),
          responseDueOn: TODAY,
          openNcOwnerIds: ['nc-owner'],
        },
      ],
      reviews: [
        {
          id: 'review',
          managementSystemId: 'sys',
          standards: ['ISO_9001'],
          plannedOn: TODAY,
          heldOn: null,
          state: 'PLANNED',
          chairId: 'chair',
        },
      ],
      nonconformities: [
        {
          id: 'nc',
          number: 4,
          state: 'OPEN',
          effectivenessDueOn: TODAY,
          approverId: 'nc-approver',
        },
      ],
    });
    const to = (id: string) => items.find((i) => i.isoSubjectId === id)!.recipientIds;
    expect(to('doc')).toEqual(['doc-owner', 'doc-approver']);
    expect(to('risk')).toEqual(['risk-owner']);
    expect(to('audit')).toEqual(['lead', 'aud', 'auditee']);
    expect(to('ext')).toEqual(['admin', 'nc-owner']);
    expect(to('review')).toEqual(['chair', 'admin']);
    expect(to('nc')).toEqual(['nc-approver']);
    expect(items.find((i) => i.isoSubjectId === 'nc')!.title).toBe('Nonconformity 4');
    expect(items.find((i) => i.isoSubjectId === 'ext')!.title).toBe(
      'Stage 2 audit by Egret Certification',
    );
  });

  it('clips a long action text for the subject line', () => {
    const [item] = planFor({ actions: [action('o', '2026-10-12', 'x'.repeat(500))] });
    expect(item!.title).toHaveLength(120);
  });
});

describe('ISO reminders for certificates and management reviews', () => {
  function certified(fill: (data: IsoReminderData) => void) {
    return setup('on', (data) => {
      data.systems.push({
        id: 'sys',
        name: 'Riverbend quality system',
        status: 'CERTIFIED',
        createdOn: d('2024-01-10'),
        reviewIntervalMonths: 12,
        standards: ['ISO_9001'],
      });
      data.certifications.push({
        id: 'cert',
        managementSystemId: 'sys',
        standardId: 'std-9001',
        standard: 'ISO_9001',
        body: 'Egret Certification',
        issuedOn: d('2025-12-11'),
        expiresOn: d('2028-12-10'),
      });
      fill(data);
    });
  }

  it('warns the client admins 60 days before surveillance 1 falls due', async () => {
    // Surveillance 1 is due 12 months after 11 Dec 2025: 11 Dec 2026, 60 days after 12 Oct 2026.
    const w = certified((data) => {
      data.reviews.push({
        id: 'held',
        managementSystemId: 'sys',
        standards: ['ISO_9001'],
        plannedOn: d('2026-06-01'),
        heldOn: d('2026-06-01'),
        state: 'HELD',
        chairId: 'chair',
      });
    });
    await runIsoReminders(w.h.deps, 'job:iso');
    expect(mailTo(w)).toEqual([
      [
        'meera@example.com',
        'Certification audit due in 60 days: ISO 9001 certificate (Egret Certification)',
      ],
    ]);
  });

  it('stops the surveillance reminder once a held audit meets the cycle date', async () => {
    const w = certified((data) => {
      data.externalAudits.push({
        id: 'surv',
        managementSystemId: 'sys',
        standardIds: ['std-9001'],
        type: 'SURVEILLANCE_1',
        state: 'HELD',
        body: 'Egret Certification',
        endOn: d('2026-10-05'),
        responseDueOn: null,
        openNcOwnerIds: [],
      });
      data.reviews.push({
        id: 'held',
        managementSystemId: 'sys',
        standards: ['ISO_9001'],
        plannedOn: d('2026-06-01'),
        heldOn: d('2026-06-01'),
        state: 'HELD',
        chairId: 'chair',
      });
    });
    expect(await runIsoReminders(w.h.deps, 'job:iso')).toMatchObject({ sent: 0 });
  });

  it('repeats the overdue management review reminder every 30 days', async () => {
    // Last held 11 Sep 2025, every 12 months: due 11 Sep 2026; the first OVERDUE day is 12 Sep.
    const at = async (instantDate: string) => {
      const w = certified((data) => {
        data.certifications.length = 0;
        data.reviews.push({
          id: 'held',
          managementSystemId: 'sys',
          standards: ['ISO_9001'],
          plannedOn: d('2025-09-11'),
          heldOn: d('2025-09-11'),
          state: 'CLOSED',
          chairId: 'chair',
        });
      });
      w.h.at(`${instantDate}T01:30:00.000Z`);
      await runIsoReminders(w.h.deps, 'job:iso');
      return w.h.mailer.sent.map((m) => m.subject);
    };
    expect(await at('2026-09-11')).toEqual([]);
    expect(await at('2026-09-12')).toEqual([
      'Management review overdue 1 day: Riverbend quality system',
    ]);
    expect(await at('2026-09-13')).toEqual([]);
    expect(await at('2026-10-12')).toEqual([
      'Management review overdue 31 days: Riverbend quality system',
    ]);
    expect(await at('2026-11-11')).toEqual([
      'Management review overdue 61 days: Riverbend quality system',
    ]);
  });

  it('sends no management review reminder for a withdrawn system', async () => {
    const w = certified((data) => {
      data.certifications.length = 0;
      data.systems[0]!.status = 'WITHDRAWN';
      data.systems[0]!.createdOn = d('2025-09-11');
    });
    w.h.at('2026-09-12T01:30:00.000Z');
    expect(await runIsoReminders(w.h.deps, 'job:iso')).toMatchObject({ sent: 0 });
  });

  it('warns the client admins 90 days before a certificate expires', async () => {
    const w = certified((data) => {
      data.certifications[0]!.issuedOn = d('2024-01-10');
      data.certifications[0]!.expiresOn = d('2027-01-10');
      data.externalAudits.push(
        ...(['SURVEILLANCE_1', 'SURVEILLANCE_2'] as const).map((type, n) => ({
          id: type,
          managementSystemId: 'sys',
          standardIds: ['std-9001'],
          type,
          state: 'CLOSED' as const,
          body: 'Egret Certification',
          endOn: d(n === 0 ? '2025-01-05' : '2026-01-05'),
          responseDueOn: null,
          openNcOwnerIds: [],
        })),
      );
      data.reviews.push({
        id: 'held',
        managementSystemId: 'sys',
        standards: ['ISO_9001'],
        plannedOn: d('2026-06-01'),
        heldOn: d('2026-06-01'),
        state: 'HELD',
        chairId: 'chair',
      });
    });
    await runIsoReminders(w.h.deps, 'job:iso');
    expect(mailTo(w)).toEqual([
      [
        'meera@example.com',
        'Certificate expires in 90 days: ISO 9001 certificate (Egret Certification)',
      ],
    ]);
  });
});

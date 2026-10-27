import {
  ISO_REMINDER_SCHEDULE,
  type Id,
  type IsoEntityType,
  type IsoNotificationInput,
  type IsoNotificationKind,
  type LocalDate,
} from '@canopy/contracts';
import {
  addDays,
  certificationCycle,
  managementReviewDue,
  planIsoNotifications,
} from '@canopy/engine';
import type { IsoReminderEmail } from '@canopy/notifications';
import { clientDay, sendTimeReached } from './client-day.js';
import { ISO_FEATURE, isoServed } from './iso-switch.js';
import type { ClientRef, IsoReminderData, IsoSendKey, JobDeps, JobReport } from './ports.js';
import { deliver, sendKeyString } from './send.js';

export const ISO_REMINDERS = 'iso-reminders';

/** Accounts whose users the jobs work for (ADR M15-0001 decision 4), as in `servedFirmIds`. */
const SERVED = ['TRIAL', 'ACTIVE'];

/** Longest action text a subject line carries. */
const TITLE_MAX = 120;

const EXTERNAL_AUDIT_LABEL: Record<IsoReminderData['externalAudits'][number]['type'], string> = {
  STAGE_1: 'Stage 1',
  STAGE_2: 'Stage 2',
  SURVEILLANCE_1: 'Surveillance 1',
  SURVEILLANCE_2: 'Surveillance 2',
  RECERTIFICATION: 'Recertification',
  SPECIAL: 'Special',
  TRANSITION: 'Transition',
};

/** One reminder input with what its email needs. */
export interface IsoReminderItem extends IsoNotificationInput {
  title: string;
  /** Path under `/c/{clientId}/iso/`. */
  path: string;
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

function bySystem<T extends { managementSystemId: Id }>(rows: readonly T[]): Map<Id, T[]> {
  const out = new Map<Id, T[]>();
  for (const row of rows)
    out.set(row.managementSystemId, [...(out.get(row.managementSystemId) ?? []), row]);
  return out;
}

const ids = (path: string, id: Id) => `${path}?ids=${id}`;

/**
 * One reminder input per ISO subject, kind and anchor date (docs/iso/model.md §5.3, §7), with the recipients the §7
 * table names. A subject in a state that gets no reminder is passed with `open: false`, so the engine skips it.
 * Pure: the job reads the records, this decides what each one is reminded about.
 */
export function isoReminderInputs(
  data: IsoReminderData,
  asOf: LocalDate,
  settings: { dueSoonDays: number },
): IsoReminderItem[] {
  const admins = data.clientAdminIds;
  const items: IsoReminderItem[] = [];
  const add = (
    kind: IsoNotificationKind,
    isoSubjectType: IsoEntityType,
    isoSubjectId: Id,
    anchorDate: LocalDate,
    open: boolean,
    recipientIds: Id[],
    title: string,
    path: string,
  ) =>
    items.push({ kind, isoSubjectType, isoSubjectId, anchorDate, open, recipientIds, title, path });

  // The list holds open actions only; the subject's approver, else the client admins, hear about an overdue one.
  for (const a of data.actions) {
    const title = clip(a.text);
    add(
      'ISO_ACTION_DUE',
      'iso_action',
      a.id,
      a.dueOn,
      true,
      [a.ownerId],
      title,
      ids('actions', a.id),
    );
    const escalateTo = a.approverId === null ? admins : [a.approverId];
    add(
      'ISO_ACTION_OVERDUE',
      'iso_action',
      a.id,
      a.dueOn,
      true,
      escalateTo,
      title,
      ids('actions', a.id),
    );
  }
  // ACTIVE documents only: an obsolete or superseded one is not read. Only the approver can REVIEW (§4.2).
  for (const d of data.documents) {
    add(
      'ISO_REVIEW_DUE',
      'controlled_document',
      d.id,
      d.reviewDueOn,
      true,
      [d.ownerId, d.approverId],
      `${d.code} ${d.title}`,
      `documents/${d.id}`,
    );
  }
  for (const r of data.risks) {
    add(
      'ISO_REVIEW_DUE',
      'risk_item',
      r.id,
      r.reviewDueOn,
      true,
      [r.ownerId],
      clip(r.activity),
      ids('risks', r.id),
    );
  }
  // An audit that started, was reported, closed or cancelled is no longer "starting".
  for (const a of data.internalAudits) {
    add(
      'ISO_AUDIT_STARTING',
      'internal_audit',
      a.id,
      a.plannedStart,
      a.state === 'PLANNED',
      [a.leadAuditorId, ...a.auditorIds, ...a.auditeeIds],
      a.title,
      ids('audits', a.id),
    );
  }

  const systemName = new Map(data.systems.map((s) => [s.id, s.name]));
  const auditsBySystem = bySystem(data.externalAudits);
  for (const c of data.certifications) {
    const title = `${c.standard.replace('_', ' ')} certificate (${c.body})`;
    const path = ids('certification', c.id);
    if (c.expiresOn !== null) {
      add(
        'ISO_CERTIFICATE_EXPIRING',
        'certification',
        c.id,
        c.expiresOn,
        true,
        admins,
        title,
        path,
      );
    }
    // Every cycle date still unmet; the engine marks one met once a held audit covers it.
    const cycle = certificationCycle(c, auditsBySystem.get(c.managementSystemId) ?? [], asOf);
    for (const item of cycle.items.filter((i) => i.metByAuditId === null)) {
      add('ISO_SURVEILLANCE_DUE', 'certification', c.id, item.dueOn, true, admins, title, path);
    }
  }
  // RESPONDED, CLOSED and CANCELLED audits owe no response.
  for (const a of data.externalAudits) {
    if (a.responseDueOn === null) continue;
    add(
      'ISO_EXTERNAL_RESPONSE_DUE',
      'external_audit',
      a.id,
      a.responseDueOn,
      a.state === 'PLANNED' || a.state === 'HELD',
      [...admins, ...a.openNcOwnerIds],
      `${EXTERNAL_AUDIT_LABEL[a.type]} audit by ${a.body}`,
      'certification',
    );
  }
  for (const r of data.reviews) {
    add(
      'ISO_MANAGEMENT_REVIEW_DUE',
      'management_review',
      r.id,
      r.plannedOn,
      r.state === 'PLANNED',
      [r.chairId, ...admins],
      `Management review, ${systemName.get(r.managementSystemId) ?? 'management system'}`,
      ids('management-reviews', r.id),
    );
  }
  // One input per distinct next due date: the standards of a system often share one.
  const reviewsBySystem = bySystem(data.reviews);
  for (const s of data.systems) {
    const due = managementReviewDue(s, reviewsBySystem.get(s.id) ?? [], asOf, settings);
    for (const nextDueOn of new Set(due.items.map((i) => i.nextDueOn))) {
      add(
        'ISO_MANAGEMENT_REVIEW_DUE',
        'management_system',
        s.id,
        nextDueOn,
        s.status !== 'WITHDRAWN',
        admins,
        s.name,
        'overview',
      );
    }
  }
  // The number only: an NC's description can name people involved in an incident.
  for (const n of data.nonconformities) {
    add(
      'ISO_EFFECTIVENESS_DUE',
      'nonconformity',
      n.id,
      n.effectivenessDueOn,
      n.state !== 'CLOSED' && n.state !== 'CANCELLED',
      [n.approverId],
      `Nonconformity ${n.number}`,
      ids('nonconformities', n.id),
    );
  }
  return items;
}

function isoUrl(appUrl: string, clientId: Id, path: string): string {
  return new URL(`/c/${clientId}/iso/${path}`, appUrl).toString();
}

async function remindClient(
  deps: JobDeps,
  firmId: Id,
  client: ClientRef,
  settings: { dueSoonDays: number },
  requestId: string,
  report: JobReport,
  failures: unknown[],
): Promise<void> {
  const day = clientDay(deps.clock(), client.settings.timeZone);
  if (!sendTimeReached(day, client.settings)) {
    report.clientsNotYetDue = (report.clientsNotYetDue ?? 0) + 1;
    return;
  }
  const asOf = day.today;
  const { items, done, recipients } = await deps.store.withFirm(firmId, requestId, async (tx) => {
    const items = isoReminderInputs(
      await tx.isoReminderData(client.id, deps.clock()),
      asOf,
      settings,
    );
    const done = new Set((await tx.listDoneIsoSends(client.id, asOf)).map(sendKeyString));
    const people = new Set(items.filter((i) => i.open).flatMap((i) => i.recipientIds));
    const recipients = new Map(
      (await tx.recipients([...people], client.id)).map((r) => [r.personId, r]),
    );
    return { items, done, recipients };
  });

  // Several inputs can share a subject and kind (a certificate's cycle dates); one send per key.
  const seen = new Set<string>();
  for (const item of items) {
    for (const planned of planIsoNotifications([item], ISO_REMINDER_SCHEDULE, asOf)) {
      const key: IsoSendKey = {
        clientId: client.id,
        instanceId: null,
        recipientId: planned.recipientId,
        kind: planned.kind,
        sendDate: planned.sendDate,
        isoSubjectType: planned.isoSubjectType,
        isoSubjectId: planned.isoSubjectId,
      };
      const id = sendKeyString(key);
      if (seen.has(id)) continue;
      seen.add(id);
      if (done.has(id)) {
        report.alreadySent = (report.alreadySent ?? 0) + 1;
        continue;
      }
      const person = recipients.get(planned.recipientId) ?? {
        personId: planned.recipientId,
        displayName: '',
        email: null,
        canReceive: false,
      };
      const message: IsoReminderEmail = {
        kind: planned.kind,
        recipientName: person.displayName,
        clientName: client.name,
        title: item.title,
        anchorDate: addDays(asOf, -planned.offsetDays),
        offsetDays: planned.offsetDays,
        url: isoUrl(deps.appUrl, client.id, item.path),
      };
      try {
        await deliver(
          deps,
          firmId,
          requestId,
          key,
          { name: person.displayName, email: person.email, canReceive: person.canReceive },
          message,
          ISO_REMINDERS,
          report,
        );
      } catch (error) {
        failures.push(error);
      }
    }
  }
}

/**
 * Runs every 15 minutes. For each client of a TRIAL or ACTIVE account with the ISO add-on served (`isoManagement` on
 * and its catalogue copied), once the client's local send time has passed today, asks the engine which ISO reminders
 * fall due today (`ISO_REMINDER_SCHEDULE`, docs/iso/model.md §7) and sends each once. Only accounts with the feature
 * are read; the switch is checked again in each account's own transaction. Dedupe is the send log's ISO subject key,
 * so two records due the same day for one person are two emails, and a repeated run sends neither again.
 */
export async function runIsoReminders(deps: JobDeps, requestId: string): Promise<JobReport> {
  const report: JobReport = { firms: 0, clients: 0, sent: 0 };
  const failures: unknown[] = [];
  const firmIds = deps.store.listFirmIdsWithFeature
    ? await deps.store.listFirmIdsWithFeature(ISO_FEATURE)
    : await deps.store.listFirmIds();
  for (const firmId of firmIds) {
    try {
      const served = await deps.store.withFirm(firmId, requestId, async (tx) => {
        if (!SERVED.includes(await tx.accountStatus()) || !(await isoServed(tx))) return null;
        return { clients: await tx.listClients(), settings: await tx.firmSettings() };
      });
      if (served === null) continue;
      report.firms! += 1;
      for (const client of served.clients) {
        report.clients! += 1;
        try {
          await remindClient(deps, firmId, client, served.settings, requestId, report, failures);
        } catch (error) {
          failures.push(error);
        }
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${ISO_REMINDERS}: ${failures.length} send(s) failed`);
  }
  return report;
}

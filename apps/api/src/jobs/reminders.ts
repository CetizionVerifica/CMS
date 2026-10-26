import type { Id } from '@canopy/contracts';
import { planNotifications } from '@canopy/engine';
import type { EmailMessage } from '@canopy/notifications';
import { clientDay, reminderWindow, sendTimeReached } from './client-day.js';
import type { ClientRef, JobDeps, JobReport, Recipient, ReminderCandidate } from './ports.js';
import { deliver, sendKeyString } from './send.js';
import { servedFirmIds } from './accounts.js';
import { offInstanceIds } from './iso-switch.js';

export const REMINDERS = 'reminders';

export function instanceUrl(appUrl: string, clientId: Id, instanceId: Id): string {
  return new URL(`/c/${clientId}/register?instance=${instanceId}`, appUrl).toString();
}

async function remindClient(
  deps: JobDeps,
  firmId: Id,
  client: ClientRef,
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
  const { candidates, done, recipients } = await deps.store.withFirm(
    firmId,
    requestId,
    async (tx) => {
      const listed = await tx.listReminderCandidates(
        client.id,
        reminderWindow(asOf, client.settings),
      );
      const off = await offInstanceIds(
        tx,
        listed.map((c) => c.id),
      );
      const candidates = listed.filter((c) => !off.has(c.id));
      const done = new Set((await tx.listDoneSends(client.id, asOf)).map(sendKeyString));
      const people = new Set(candidates.flatMap((c) => [c.ownerId, c.approverId]));
      const recipients = new Map(
        (await tx.recipients([...people], client.id)).map((r) => [r.personId, r]),
      );
      return { candidates, done, recipients };
    },
  );

  const byId = new Map<Id, ReminderCandidate>(candidates.map((c) => [c.id, c]));
  for (const candidate of candidates) {
    for (const planned of planNotifications(candidate, client.settings.reminders, asOf)) {
      const key = {
        clientId: client.id,
        instanceId: planned.instanceId,
        recipientId: planned.recipientId,
        kind: planned.kind,
        sendDate: planned.sendDate,
      };
      if (done.has(sendKeyString(key))) {
        report.alreadySent = (report.alreadySent ?? 0) + 1;
        continue;
      }
      const instance = byId.get(planned.instanceId)!;
      const person: Recipient = recipients.get(planned.recipientId) ?? {
        personId: planned.recipientId,
        displayName: '',
        email: null,
        canReceive: false,
      };
      const summary = {
        title: instance.title,
        actName: instance.actName,
        unitName: instance.unitName,
        departmentName: instance.departmentName,
        criticality: instance.criticality,
        dueDate: instance.dueDate,
        url: instanceUrl(deps.appUrl, client.id, instance.id),
      };
      const message: EmailMessage =
        planned.kind === 'OWNER_REMINDER'
          ? {
              kind: 'OWNER_REMINDER',
              recipientName: person.displayName,
              clientName: client.name,
              offsetDays: planned.offsetDays,
              sentBack: instance.workflowState === 'SENT_BACK',
              instance: summary,
            }
          : {
              kind: 'APPROVER_ESCALATION',
              recipientName: person.displayName,
              clientName: client.name,
              offsetDays: planned.offsetDays,
              awaitingApproval: instance.workflowState === 'SUBMITTED',
              instance: summary,
            };
      try {
        await deliver(
          deps,
          firmId,
          requestId,
          key,
          { name: person.displayName, email: person.email, canReceive: person.canReceive },
          message,
          REMINDERS,
          report,
        );
      } catch (error) {
        failures.push(error);
      }
    }
  }
}

/**
 * Runs every 15 minutes. For each client whose local send time (default 07:00, Asia/Kolkata unless the client
 * says otherwise) has passed today, asks the engine which owner reminders and approver escalations are due today
 * and sends each once. The engine returns nothing for APPROVED and NOT_APPLICABLE instances, and the candidate
 * query leaves them out too. Instances of STANDARD obligations get none while the ISO add-on is off. Dedupe is
 * the send log's unique key, so overlapping or repeated runs send nothing twice.
 */
export async function runReminders(deps: JobDeps, requestId: string): Promise<JobReport> {
  const report: JobReport = { firms: 0, clients: 0, sent: 0 };
  const failures: unknown[] = [];
  for (const firmId of await servedFirmIds(deps, requestId)) {
    report.firms! += 1;
    const clients = await deps.store.withFirm(firmId, requestId, (tx) => tx.listClients());
    for (const client of clients) {
      report.clients! += 1;
      try {
        await remindClient(deps, firmId, client, requestId, report, failures);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${REMINDERS}: ${failures.length} send(s) failed`);
  }
  return report;
}

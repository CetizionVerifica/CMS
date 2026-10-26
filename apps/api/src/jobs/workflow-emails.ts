import { Id, type WorkflowState } from '@canopy/contracts';
import { daysBetween } from '@canopy/engine';
import type { EmailMessage, InstanceSummary } from '@canopy/notifications';
import { z } from 'zod';
import { clientDay } from './client-day.js';
import type { Consumer } from './consumers.js';
import type {
  JobDeps,
  JobReport,
  OutboxEvent,
  Recipient,
  NoticeInstance,
  SendKey,
} from './ports.js';
import { offInstanceIds } from './iso-switch.js';
import { instanceUrl } from './reminders.js';
import { deliver } from './send.js';

const InstanceData = z.object({ instanceId: Id });
const PersonActor = z.object({ kind: z.literal('PERSON'), personId: Id });

interface WorkflowEmail {
  type: 'instance.submitted' | 'instance.sent_back';
  /** The state the event left the instance in. Once it has moved on, the email would be stale, so none is sent. */
  state: WorkflowState;
  recipient: (i: NoticeInstance) => Id;
  /** Who acted when the event names no person: the owner submits, the approver sends back. */
  defaultActor: (i: NoticeInstance) => Id;
  message: (m: {
    recipientName: string;
    actorName: string;
    clientName: string;
    offsetDays: number;
    instance: InstanceSummary;
    candidate: NoticeInstance;
  }) => EmailMessage;
}

const unknownPerson = (personId: Id): Recipient => ({
  personId,
  displayName: '',
  email: null,
  canReceive: false,
});

/**
 * Emails one person as soon as an instance changes hands, answering the outbox event. The instance is read again
 * first: if it has changed since the event (its version moved on: approved before the email went, resubmitted, or
 * sent back again), nothing is sent. The send log dedupes on the event id and recipient (ADR M9-0001 §13), so a redelivered event sends nothing
 * twice while a second send-back on the same day, a new event, is a new email.
 */
async function sendWorkflowEmail(
  spec: WorkflowEmail,
  deps: JobDeps,
  event: OutboxEvent,
  requestId: string,
): Promise<JobReport> {
  const report: JobReport = { sent: 0 };
  const { instanceId } = InstanceData.parse(event.data);
  const actor = PersonActor.safeParse(event.actor);
  const found = await deps.store.withFirm(event.firmId, requestId, async (tx) => {
    const instance = await tx.findInstance(instanceId);
    // The event names the version it left the instance at: any later change (a resubmit and a second send-back,
    // an approval, a reassignment) makes this email stale, and that later change has its own event if it needs one.
    if (
      !instance ||
      instance.version !== event.aggregateVersion ||
      instance.workflowState !== spec.state
    ) {
      return null;
    }
    // Features are read now, not when the event was queued: a STANDARD instance gets no email once the add-on is off.
    if ((await offInstanceIds(tx, [instance.id])).has(instance.id)) return null;
    const client = (await tx.listClients()).find((c) => c.id === instance.clientId);
    if (!client) return null;
    const actorId = actor.success ? actor.data.personId : spec.defaultActor(instance);
    const people = new Map(
      (await tx.recipients([spec.recipient(instance), actorId], client.id)).map((r) => [
        r.personId,
        r,
      ]),
    );
    return { instance, client, people, actorId };
  });
  if (!found) {
    report.skippedStale = 1;
    return report;
  }
  const { instance, client, people, actorId } = found;
  const recipientId = spec.recipient(instance);
  const person = people.get(recipientId) ?? unknownPerson(recipientId);
  const today = clientDay(deps.clock(), client.settings.timeZone).today;
  const key: SendKey = {
    clientId: client.id,
    instanceId: instance.id,
    recipientId,
    kind: spec.type === 'instance.submitted' ? 'APPROVAL_REQUESTED' : 'SENT_BACK',
    sendDate: today,
    eventId: event.id,
  };
  const message = spec.message({
    recipientName: person.displayName,
    actorName: people.get(actorId)?.displayName ?? '',
    clientName: client.name,
    offsetDays: daysBetween(instance.dueDate, today),
    instance: {
      title: instance.title,
      actName: instance.actName,
      unitName: instance.unitName,
      departmentName: instance.departmentName,
      criticality: instance.criticality,
      dueDate: instance.dueDate,
      url: instanceUrl(deps.appUrl, client.id, instance.id),
    },
    candidate: instance,
  });
  await deliver(
    deps,
    event.firmId,
    requestId,
    key,
    { name: person.displayName, email: person.email, canReceive: person.canReceive },
    message,
    spec.type,
    report,
  );
  return report;
}

const SPECS: WorkflowEmail[] = [
  {
    type: 'instance.submitted',
    state: 'SUBMITTED',
    recipient: (i) => i.approverId,
    defaultActor: (i) => i.ownerId,
    message: (m) => ({
      kind: 'APPROVAL_REQUESTED',
      recipientName: m.recipientName,
      clientName: m.clientName,
      submittedBy: m.actorName || 'The owner',
      notApplicable: m.candidate.pendingKind === 'NA',
      offsetDays: m.offsetDays,
      instance: m.instance,
    }),
  },
  {
    type: 'instance.sent_back',
    state: 'SENT_BACK',
    recipient: (i) => i.ownerId,
    defaultActor: (i) => i.approverId,
    message: (m) => ({
      kind: 'SENT_BACK',
      recipientName: m.recipientName,
      clientName: m.clientName,
      sentBackBy: m.actorName || 'The approver',
      offsetDays: m.offsetDays,
      instance: m.instance,
    }),
  },
];

/** The approver hears about a submission, and the owner about a send-back, without waiting for a reminder. */
export const WORKFLOW_EMAIL_CONSUMERS: readonly Consumer[] = SPECS.map((spec) => ({
  type: spec.type,
  sendsMail: true,
  handle: (deps, event, requestId) => sendWorkflowEmail(spec, deps, event, requestId),
}));

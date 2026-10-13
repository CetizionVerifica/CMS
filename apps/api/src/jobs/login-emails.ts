import { Id } from '@canopy/contracts';
import type { EmailMessage } from '@canopy/notifications';
import { z } from 'zod';
import { clientDay } from './client-day.js';
import type { Consumer } from './consumers.js';
import type { JobDeps, JobReport, LoginTokenIssuer, OutboxEvent, SendKey } from './ports.js';
import { deliver } from './send.js';

/** Send dates for sends that belong to no client use the product's default time zone (root CLAUDE.md rule 4). */
const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/**
 * A sign-in link asked for longer ago than this is not sent: the person has given up or asked again, and M5
 * issues links that last about as long.
 */
export const MAGIC_LINK_MAX_AGE_MINUTES = 15;

const MagicLinkData = z.object({ personId: Id });
const InvitedData = z.object({ personId: Id, inviteId: Id });

function issuer(deps: JobDeps): LoginTokenIssuer {
  if (!deps.issueLoginToken) throw new Error('Sign-in emails need issueLoginToken');
  return deps.issueLoginToken;
}

const minutesUntil = (from: string, to: string) =>
  Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));

/**
 * Emails a one-time sign-in link on `auth.magic_link_requested`. The token is issued only after the send-log
 * claim and the recipient checks pass, and its raw value goes into the link and nowhere else: it is never stored,
 * logged or put in an event (the send log keeps the event id). A redelivered event sends nothing twice.
 */
async function sendMagicLink(
  deps: JobDeps,
  event: OutboxEvent,
  requestId: string,
): Promise<JobReport> {
  const report: JobReport = { sent: 0 };
  const issue = issuer(deps);
  const { personId } = MagicLinkData.parse(event.data);
  const now = deps.clock();
  if (Date.parse(now) - Date.parse(event.occurredAt) > MAGIC_LINK_MAX_AGE_MINUTES * 60_000) {
    report.skippedStale = 1;
    return report;
  }
  const person = await deps.store.withFirm(event.firmId, requestId, (tx) =>
    tx.findPerson(personId),
  );
  if (!person) {
    report.skippedStale = 1;
    return report;
  }
  const key: SendKey = {
    clientId: null,
    instanceId: null,
    recipientId: personId,
    kind: 'MAGIC_LINK',
    sendDate: clientDay(now, DEFAULT_TIME_ZONE).today,
    eventId: event.id,
  };
  await deliver(
    deps,
    event.firmId,
    requestId,
    key,
    { name: person.displayName, email: person.email, canReceive: person.status === 'ACTIVE' },
    async (): Promise<EmailMessage> => {
      const { token, expiresAt } = await issue({
        firmId: event.firmId,
        personId,
        kind: 'MAGIC_LINK',
      });
      const url = new URL('/login/link', deps.appUrl);
      url.searchParams.set('token', token);
      return {
        kind: 'MAGIC_LINK',
        recipientName: person.displayName,
        expiresInMinutes: minutesUntil(deps.clock(), expiresAt),
        url: url.toString(),
      };
    },
    event.type,
    report,
  );
  return report;
}

/**
 * Emails an invitation on `person.invited` to the address the invite names. Nothing is sent once the invite is
 * accepted, revoked, expired or replaced by another for someone else. The token is issued as for sign-in links.
 */
async function sendInvite(
  deps: JobDeps,
  event: OutboxEvent,
  requestId: string,
): Promise<JobReport> {
  const report: JobReport = { sent: 0 };
  const issue = issuer(deps);
  const { personId, inviteId } = InvitedData.parse(event.data);
  const now = deps.clock();
  const found = await deps.store.withFirm(event.firmId, requestId, async (tx) => {
    const invite = await tx.findInvite(inviteId);
    if (
      !invite ||
      invite.personId !== personId ||
      invite.acceptedAt !== null ||
      invite.revokedAt !== null ||
      Date.parse(invite.expiresAt) <= Date.parse(now)
    ) {
      return null;
    }
    return { invite, person: await tx.findPerson(personId) };
  });
  if (!found?.person) {
    report.skippedStale = 1;
    return report;
  }
  const { invite, person } = found;
  const key: SendKey = {
    clientId: invite.clientId,
    instanceId: null,
    recipientId: personId,
    kind: 'INVITE',
    sendDate: clientDay(now, invite.clientTimeZone ?? DEFAULT_TIME_ZONE).today,
    eventId: event.id,
  };
  await deliver(
    deps,
    event.firmId,
    requestId,
    key,
    // The invite is the permission to email: the person is INVITED, not yet ACTIVE.
    { name: person.displayName, email: invite.email, canReceive: true },
    async (): Promise<EmailMessage> => {
      const { token, expiresAt } = await issue({
        firmId: event.firmId,
        personId,
        kind: 'INVITE',
        inviteId,
      });
      return {
        kind: 'INVITE',
        recipientName: person.displayName,
        invitedBy: invite.inviterName || `Your ${invite.firmName} contact`,
        firmName: invite.firmName,
        clientName: invite.clientName,
        role: invite.role,
        expiresInDays: Math.max(1, Math.round(minutesUntil(deps.clock(), expiresAt) / (24 * 60))),
        url: new URL(`/invite/${encodeURIComponent(token)}`, deps.appUrl).toString(),
      };
    },
    event.type,
    report,
  );
  return report;
}

/** A person who asked for a sign-in link, or was invited, gets the email with a fresh one-time link. */
export const LOGIN_EMAIL_CONSUMERS: readonly Consumer[] = [
  { type: 'auth.magic_link_requested', sendsMail: true, handle: sendMagicLink },
  { type: 'person.invited', sendsMail: true, handle: sendInvite },
];

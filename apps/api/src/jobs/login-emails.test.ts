import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONSUMERS } from './consumers.js';
import type { LoginTokenIssuer, OutboxEvent } from './ports.js';
import { APP_URL, harness, person } from './testing/builders.js';
import { memoryClient, memoryFirm, type MemoryInvite } from './testing/memory-store.js';

const TOKEN = 'raw-token-7Qx9_secret';

// 13 Oct 2026, 09:30 UTC (15:00 IST).
function setup() {
  const firm = memoryFirm();
  const client = memoryClient('Kestrel Metals Group');
  const asha = person({ displayName: 'Asha Rao', email: 'asha@example.com' });
  const inviter = person({ displayName: 'Meera Iyer', email: 'meera@example.com' });
  const invitee = person({ displayName: 'Ravi Kumar', email: null, status: 'INVITED' });
  firm.clients.push(client);
  firm.people.push(asha, inviter, invitee);
  const invite: MemoryInvite = {
    id: randomUUID(),
    personId: invitee.id,
    email: 'ravi@example.com',
    role: 'OWNER',
    clientId: client.id,
    createdById: inviter.id,
    expiresAt: '2026-10-20T09:00:00.000Z',
    acceptedAt: null,
    revokedAt: null,
  };
  firm.invites.push(invite);
  const h = harness([firm]);
  h.at('2026-10-13T09:30:00.000Z');
  const issued: Parameters<LoginTokenIssuer>[0][] = [];
  h.deps.issueLoginToken = async (input) => {
    issued.push(input);
    const minutes = input.kind === 'MAGIC_LINK' ? 15 : 7 * 24 * 60;
    return {
      token: TOKEN,
      expiresAt: new Date(Date.parse(h.deps.clock()) + minutes * 60_000).toISOString(),
    };
  };
  return { firm, client, asha, inviter, invitee, invite, h, issued };
}

type World = ReturnType<typeof setup>;

function magicLinkEvent(
  w: World,
  personId = w.asha.id,
  occurredAt = '2026-10-13T09:29:00.000Z',
): OutboxEvent {
  return {
    id: randomUUID(),
    type: 'auth.magic_link_requested',
    schemaVersion: 1,
    occurredAt,
    firmId: w.firm.id,
    clientId: null,
    actor: { kind: 'PERSON', personId },
    requestId: 'req:link',
    aggregate: { type: 'person', id: personId },
    aggregateVersion: 1,
    data: { personId },
  };
}

function invitedEvent(w: World, data: Record<string, unknown> = {}): OutboxEvent {
  return {
    id: randomUUID(),
    type: 'person.invited',
    schemaVersion: 1,
    occurredAt: '2026-10-13T09:29:00.000Z',
    firmId: w.firm.id,
    clientId: w.invite.clientId,
    actor: { kind: 'PERSON', personId: w.inviter.id },
    requestId: 'req:invite',
    aggregate: { type: 'person', id: w.invitee.id },
    aggregateVersion: 2,
    data: {
      personId: w.invitee.id,
      inviteId: w.invite.id,
      role: w.invite.role,
      clientId: w.invite.clientId,
      ...data,
    },
  };
}

const handle = (w: World, e: OutboxEvent) =>
  CONSUMERS.find((c) => c.type === e.type)!.handle(w.h.deps, e, `job:${e.type}:${e.id}`);

describe('sign-in link on auth.magic_link_requested', () => {
  it('issues a token after the claim and emails the link once, keeping the token out of the send log and events', async () => {
    const w = setup();
    const e = magicLinkEvent(w);
    expect(await handle(w, e)).toEqual({ sent: 1 });

    expect(w.issued).toEqual([{ firmId: w.firm.id, personId: w.asha.id, kind: 'MAGIC_LINK' }]);
    const [mail] = w.h.mailer.sent;
    expect(mail!.to).toEqual({ name: 'Asha Rao', email: 'asha@example.com' });
    expect(mail!.subject).toBe('Your sign-in link for PlanetPulse Compliance');
    expect(mail!.text).toContain(`${APP_URL}/login/link?token=${TOKEN}`);
    expect(mail!.text).toContain('expires in 15 minutes');
    expect(mail!.idempotencyKey).toBe(`event:${e.id}:${w.asha.id}`);
    expect(mail!.idempotencyKey).not.toContain(TOKEN);

    const firm = w.h.store.firms[0]!;
    expect(firm.sends).toHaveLength(1);
    expect(firm.sends[0]).toMatchObject({
      clientId: null,
      instanceId: null,
      kind: 'MAGIC_LINK',
      recipientId: w.asha.id,
      sendDate: '2026-10-13',
      eventId: e.id,
    });
    expect(JSON.stringify(firm.sends)).not.toContain(TOKEN);
    expect(JSON.stringify(firm.events)).not.toContain(TOKEN);
    expect(firm.events.at(-1)).toMatchObject({
      type: 'notification.sent',
      clientId: null,
      data: { kind: 'MAGIC_LINK', instanceId: null, sourceEventId: e.id },
    });

    expect(await handle(w, e)).toEqual({ sent: 0, alreadySent: 1 });
    expect(w.issued).toHaveLength(1);
    expect(w.h.mailer.sent).toHaveLength(1);
  });

  it('issues a new token when an earlier attempt failed before it was recorded', async () => {
    const w = setup();
    const e = magicLinkEvent(w);
    w.h.mailer.failNext(1);
    await expect(handle(w, e)).rejects.toThrow();
    expect(await handle(w, e)).toEqual({ sent: 1 });
    expect(w.issued).toHaveLength(2);
    expect(w.h.mailer.sent).toHaveLength(1);
  });

  it('issues no token for a person who is not active or has no address, and records why', async () => {
    const w = setup();
    const disabled = person({ status: 'DISABLED' });
    const noEmail = person({ email: null });
    w.h.store.firms[0]!.people.push(disabled, noEmail);
    expect(await handle(w, magicLinkEvent(w, disabled.id))).toEqual({
      sent: 0,
      failedNOT_ACTIVE: 1,
    });
    expect(await handle(w, magicLinkEvent(w, noEmail.id))).toEqual({
      sent: 0,
      failedNO_EMAIL: 1,
    });
    expect(w.issued).toHaveLength(0);
    expect(w.h.mailer.sent).toHaveLength(0);
  });

  it('skips a request older than 15 minutes, and a person who is gone', async () => {
    const w = setup();
    expect(await handle(w, magicLinkEvent(w, w.asha.id, '2026-10-13T09:14:59.000Z'))).toEqual({
      sent: 0,
      skippedStale: 1,
    });
    expect(await handle(w, magicLinkEvent(w, randomUUID()))).toEqual({
      sent: 0,
      skippedStale: 1,
    });
    expect(w.issued).toHaveLength(0);
    expect(w.h.store.firms[0]!.sends).toHaveLength(0);
  });

  it('throws when no token issuer is configured', async () => {
    const w = setup();
    delete w.h.deps.issueLoginToken;
    await expect(handle(w, magicLinkEvent(w))).rejects.toThrow(
      'Sign-in emails need issueLoginToken',
    );
  });
});

describe('invitation on person.invited', () => {
  it('emails the invited address with an invite token, naming the inviter, client and role', async () => {
    const w = setup();
    const e = invitedEvent(w);
    expect(await handle(w, e)).toEqual({ sent: 1 });

    expect(w.issued).toEqual([
      { firmId: w.firm.id, personId: w.invitee.id, kind: 'INVITE', inviteId: w.invite.id },
    ]);
    const [mail] = w.h.mailer.sent;
    expect(mail!.to).toEqual({ name: 'Ravi Kumar', email: 'ravi@example.com' });
    expect(mail!.subject).toBe('Meera Iyer invited you to PlanetPulse Compliance');
    expect(mail!.text).toContain(
      'as an owner for Kestrel Metals Group, with Heron Compliance Partners',
    );
    expect(mail!.text).toContain('expires in 7 days');
    expect(mail!.text).toContain(`${APP_URL}/invite/${TOKEN}`);
    expect(w.h.store.firms[0]!.sends[0]).toMatchObject({
      clientId: w.client.id,
      kind: 'INVITE',
      eventId: e.id,
    });
    expect(JSON.stringify(w.h.store.firms[0]!.events)).not.toContain(TOKEN);

    expect(await handle(w, e)).toEqual({ sent: 0, alreadySent: 1 });
    expect(w.issued).toHaveLength(1);
  });

  it('invites to a firm role with no client, falling back when the inviter has no name', async () => {
    const w = setup();
    const firm = w.h.store.firms[0]!;
    firm.invites[0] = {
      ...w.invite,
      role: 'CONSULTANT',
      clientId: null,
      createdById: randomUUID(),
    };
    expect(await handle(w, invitedEvent(w, { role: 'CONSULTANT', clientId: null }))).toEqual({
      sent: 1,
    });
    const [mail] = w.h.mailer.sent;
    expect(mail!.subject).toBe(
      'Your Heron Compliance Partners contact invited you to PlanetPulse Compliance',
    );
    expect(mail!.text).toContain('as a consultant for Heron Compliance Partners.');
    expect(w.h.store.firms[0]!.sends[0]).toMatchObject({ clientId: null, sendDate: '2026-10-13' });
  });

  it('sends nothing for an invite that is accepted, revoked, expired, missing or for someone else', async () => {
    const cases: [string, (w: World) => void][] = [
      [
        'accepted',
        (w) => void (w.h.store.firms[0]!.invites[0]!.acceptedAt = '2026-10-13T09:29:30.000Z'),
      ],
      [
        'revoked',
        (w) => void (w.h.store.firms[0]!.invites[0]!.revokedAt = '2026-10-13T09:29:30.000Z'),
      ],
      [
        'expired',
        (w) => void (w.h.store.firms[0]!.invites[0]!.expiresAt = '2026-10-13T09:30:00.000Z'),
      ],
      ['missing', (w) => void (w.h.store.firms[0]!.invites.length = 0)],
      ['someone else', (w) => void (w.h.store.firms[0]!.invites[0]!.personId = w.asha.id)],
      ['person gone', (w) => void w.h.store.firms[0]!.people.splice(2, 1)],
    ];
    for (const [name, change] of cases) {
      const w = setup();
      change(w);
      expect(await handle(w, invitedEvent(w)), name).toEqual({ sent: 0, skippedStale: 1 });
      expect(w.issued, name).toHaveLength(0);
      expect(w.h.mailer.sent, name).toHaveLength(0);
    }
  });
});

function mfaEnrolledEvent(
  w: World,
  personId = w.asha.id,
  via: 'SETTINGS' | 'INVITE' = 'SETTINGS',
  occurredAt = '2026-10-13T19:00:00.000Z',
): OutboxEvent {
  return {
    id: randomUUID(),
    type: 'person.mfa_enrolled',
    schemaVersion: 1,
    occurredAt,
    firmId: w.firm.id,
    clientId: null,
    actor: { kind: 'PERSON', personId },
    requestId: 'req:mfa',
    aggregate: { type: 'person', id: personId },
    aggregateVersion: 3,
    data: { personId, via },
  };
}

describe('MFA notice on person.mfa_enrolled', () => {
  it('tells the person once, naming the India day and how, with no link and no token', async () => {
    const w = setup();
    // 19:00Z on the 13th is already the 14th in India.
    const e = mfaEnrolledEvent(w);
    expect(await handle(w, e)).toEqual({ sent: 1 });
    expect(w.issued).toEqual([]);
    const [mail] = w.h.mailer.sent;
    expect(mail!.to).toEqual({ name: 'Asha Rao', email: 'asha@example.com' });
    expect(mail!.subject).toBe(
      'Two-step sign-in was set up on your PlanetPulse Compliance account',
    );
    expect(mail!.text).toContain('on 14 Oct 2026, from your account settings');
    expect(mail!.text).not.toMatch(/https?:/);
    expect(w.h.store.firms[0]!.sends).toEqual([
      expect.objectContaining({
        clientId: null,
        instanceId: null,
        kind: 'MFA_ENROLLED',
        recipientId: w.asha.id,
        eventId: e.id,
      }),
    ]);
    expect(await handle(w, e)).toEqual({ sent: 0, alreadySent: 1 });
    expect(w.h.mailer.sent).toHaveLength(1);
  });

  it('names the invitation, and still sends a notice delivered days late', async () => {
    const w = setup();
    w.h.at('2026-10-20T09:30:00.000Z');
    expect(await handle(w, mfaEnrolledEvent(w, w.asha.id, 'INVITE'))).toEqual({ sent: 1 });
    expect(w.h.mailer.sent[0]!.text).toContain('while your invitation was accepted');
    expect(w.h.mailer.sent[0]!.text).toContain('on 14 Oct 2026');
  });

  it('sends nothing to a person who is gone or not active, and records why', async () => {
    const w = setup();
    expect(await handle(w, mfaEnrolledEvent(w, w.invitee.id))).toEqual({
      sent: 0,
      failedNO_EMAIL: 1,
    });
    w.h.store.firms[0]!.people[1]!.status = 'DISABLED';
    expect(await handle(w, mfaEnrolledEvent(w, w.inviter.id))).toEqual({
      sent: 0,
      failedNOT_ACTIVE: 1,
    });
    w.h.store.firms[0]!.people.splice(0, 1);
    expect(await handle(w, mfaEnrolledEvent(w))).toEqual({ sent: 0, skippedStale: 1 });
    expect(w.h.mailer.sent).toEqual([]);
  });

  it('is registered only with a mailer, and needs no sign-in tokens', () => {
    expect(CONSUMERS.find((c) => c.type === 'person.mfa_enrolled')).toMatchObject({
      sendsMail: true,
    });
    expect(CONSUMERS.find((c) => c.type === 'person.mfa_enrolled')!.needsLoginTokens).toBeFalsy();
  });
});

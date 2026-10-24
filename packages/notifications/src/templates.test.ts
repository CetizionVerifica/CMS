import type { LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { escapeHtml, formatDate } from './format.js';
import {
  renderEmail,
  type DigestClientSummary,
  type EmailMessage,
  type InstanceSummary,
} from './templates.js';

const instance: InstanceSummary = {
  title: 'Deposit TDS for the month',
  actName: 'Income Tax Act, 1961',
  unitName: 'Plant',
  departmentName: 'Finance',
  criticality: 'SUPER_CRITICAL',
  dueDate: '2026-10-15' as LocalDate,
  url: 'https://app.planetpulse.example/c/abc/register?instance=def',
};

const owner = (offsetDays: number, sentBack = false) =>
  renderEmail({
    kind: 'OWNER_REMINDER',
    recipientName: 'Asha Rao',
    clientName: 'Kestrel Metals Group',
    offsetDays,
    sentBack,
    instance,
  });

const approver = (offsetDays: number, awaitingApproval: boolean) =>
  renderEmail({
    kind: 'APPROVER_ESCALATION',
    recipientName: 'Vikram Shah',
    clientName: 'Kestrel Metals Group',
    offsetDays,
    awaitingApproval,
    instance,
  });

describe('owner reminder', () => {
  it('uses the status wording for the subject and heading', () => {
    expect(owner(-7).subject).toBe('Due in 7 days: Deposit TDS for the month');
    expect(owner(-1).subject).toBe('Due tomorrow: Deposit TDS for the month');
    expect(owner(0).subject).toBe('Due today: Deposit TDS for the month');
    expect(owner(-3).html).toContain('>Due in 3 days</td>');
  });

  it('shows the instance details, a call to action and a plain-text alternative', () => {
    const email = owner(-3);
    expect(email.text).toContain('Hello Asha Rao,');
    expect(email.text).toContain('Act: Income Tax Act, 1961');
    expect(email.text).toContain('Criticality: Super critical');
    expect(email.text).toContain('Due date: 15 Oct 2026 (Due in 3 days)');
    expect(email.text).toContain(
      'Open and submit: https://app.planetpulse.example/c/abc/register?instance=def',
    );
    expect(email.html).toContain(
      'href="https://app.planetpulse.example/c/abc/register?instance=def"',
    );
    expect(email.html).toContain('Open and submit</a>');
  });

  it('asks a sent-back owner to resubmit', () => {
    expect(owner(-3, true).text).toContain('was sent back');
    expect(owner(-3, false).text).toContain('has not been submitted yet');
  });
});

describe('approver escalation', () => {
  it('distinguishes awaiting approval from not submitted', () => {
    expect(approver(1, true).subject).toBe(
      'Awaiting your approval, overdue 1 day: Deposit TDS for the month',
    );
    expect(approver(7, false).subject).toBe(
      'Not submitted, overdue 7 days: Deposit TDS for the month',
    );
    expect(approver(0, false).subject).toBe('Not submitted, due today: Deposit TDS for the month');
    expect(approver(1, true).text).toContain('Review submission:');
    expect(approver(7, false).text).toContain('Please follow up with the owner.');
  });

  it('tones the due date as overdue', () => {
    expect(approver(1, true).html).toMatch(
      /font-weight:600;color:#A8391F">15 Oct 2026 \(Overdue 1 day\)/,
    );
  });

  it('labels each criticality in sentence case', () => {
    for (const [criticality, label] of [
      ['CRITICAL', 'Critical'],
      ['HIGH', 'High'],
      ['MEDIUM', 'Medium'],
      ['LOW', 'Low'],
    ] as const) {
      const email = renderEmail({
        kind: 'APPROVER_ESCALATION',
        recipientName: 'V',
        clientName: 'C',
        offsetDays: 1,
        awaitingApproval: true,
        instance: { ...instance, criticality },
      });
      expect(email.text).toContain(`Criticality: ${label}`);
    }
  });
});

describe('consultant digest', () => {
  const digest = (clients: DigestClientSummary[]) =>
    renderEmail({
      kind: 'CONSULTANT_DIGEST',
      recipientName: 'Meera Iyer',
      asOf: '2026-10-12' as LocalDate,
      fyLabel: '2026-27',
      clients,
    });

  it('lists each client with score and counts', () => {
    const email = digest([
      {
        clientName: 'Kestrel Metals Group',
        score: 51.3,
        overdue: 5,
        dueSoon: 2,
        awaitingApproval: 1,
        url: 'https://app.planetpulse.example/c/a/overview',
      },
      {
        clientName: 'Osprey Textiles Group',
        score: null,
        overdue: 0,
        dueSoon: 0,
        awaitingApproval: 0,
        url: 'https://app.planetpulse.example/c/b/overview',
      },
    ]);
    expect(email.subject).toBe('Weekly digest, 12 Oct 2026: 5 overdue');
    expect(email.text).toContain(
      'your 2 clients stand for FY 2026-27 as of 12 Oct 2026. 5 items are overdue.',
    );
    expect(email.text).toContain(
      'Kestrel Metals Group: score 51.3%, 5 overdue, 2 due soon, 1 awaiting approval.',
    );
    expect(email.text).toContain('Osprey Textiles Group: score No items due');
    expect(email.html).toContain('<th');
    expect(email.html).toContain('href="https://app.planetpulse.example/c/a/overview"');
  });

  it('reads naturally for one client with one overdue item, and for none overdue', () => {
    const one = digest([
      {
        clientName: 'A',
        score: 90,
        overdue: 1,
        dueSoon: 0,
        awaitingApproval: 0,
        url: 'https://x.example/',
      },
    ]);
    expect(one.text).toContain('your client stands');
    expect(one.text).toContain('1 item is overdue.');
    expect(one.text).toContain('score 90.0%');
    const none = digest([
      {
        clientName: 'A',
        score: 100,
        overdue: 0,
        dueSoon: 0,
        awaitingApproval: 0,
        url: 'https://x.example/',
      },
    ]);
    expect(none.text).toContain('Nothing is overdue.');
  });

  it('says so when there are no clients', () => {
    const email = digest([]);
    expect(email.text).toContain('You have no active clients this week.');
    expect(email.html).not.toContain('<th');
  });
});

const approval = (notApplicable: boolean, offsetDays = -2) =>
  renderEmail({
    kind: 'APPROVAL_REQUESTED',
    recipientName: 'Vikram Shah',
    clientName: 'Kestrel Metals Group',
    submittedBy: 'Asha Rao',
    notApplicable,
    offsetDays,
    instance,
  });

const sentBack = (offsetDays = 1) =>
  renderEmail({
    kind: 'SENT_BACK',
    recipientName: 'Asha Rao',
    clientName: 'Kestrel Metals Group',
    sentBackBy: 'Vikram Shah',
    offsetDays,
    instance,
  });

describe('approval requested', () => {
  it('tells the approver who submitted and asks for a decision', () => {
    const email = approval(false);
    expect(email.subject).toBe('Awaiting your approval: Deposit TDS for the month');
    expect(email.text).toContain(
      'Asha Rao submitted this obligation for Kestrel Metals Group. Please review the submission, then approve it or send it back.',
    );
    expect(email.text).toContain('Due date: 15 Oct 2026 (Due in 2 days)');
    expect(email.text).toContain(`Review submission: ${instance.url}`);
    expect(email.html).toContain('Review submission');
    expect(email.text).toContain('because you are the approver');
  });

  it('words a not-applicable request as one', () => {
    const email = approval(true, 3);
    expect(email.subject).toBe('Not applicable request: Deposit TDS for the month');
    expect(email.text).toContain(
      'Asha Rao asked to mark this obligation for Kestrel Metals Group as not applicable.',
    );
    expect(email.text).toContain('(Overdue 3 days)');
  });
});

describe('sent back', () => {
  it('tells the owner who sent it back and asks them to resubmit', () => {
    const email = sentBack();
    expect(email.subject).toBe('Sent back: Deposit TDS for the month');
    expect(email.html).toContain('Sent back to you');
    expect(email.text).toContain(
      "Vikram Shah sent back your submission for Kestrel Metals Group. Please read the approver's comment, then submit it again.",
    );
    expect(email.text).toContain('(Overdue 1 day)');
    expect(email.text).toContain(`Open and resubmit: ${instance.url}`);
    expect(email.text).toContain('because you are the owner');
  });
});

const magicLink = () =>
  renderEmail({
    kind: 'MAGIC_LINK',
    recipientName: 'Asha Rao',
    expiresInMinutes: 15,
    url: 'https://app.planetpulse.example/login/link?token=tok_abc',
  });

const invite = (overrides: Partial<Extract<EmailMessage, { kind: 'INVITE' }>> = {}) =>
  renderEmail({
    kind: 'INVITE',
    recipientName: 'Asha Rao',
    invitedBy: 'Vikram Shah',
    firmName: 'Demo Advisory',
    clientName: 'Kestrel Metals Group',
    role: 'OWNER',
    expiresInDays: 7,
    url: 'https://app.planetpulse.example/invite/tok_abc',
    ...overrides,
  });

const trialEnding = (daysLeft = 7, recipientName = 'Kiran Kestrel') =>
  renderEmail({
    kind: 'TRIAL_ENDING',
    recipientName,
    accountName: 'Kestrel Metals Group',
    trialEndsOn: '2026-11-23' as LocalDate,
    daysLeft,
    url: 'https://app.planetpulse.example/account',
  });

describe('trial ending', () => {
  it('says when the trial ends, what happens then and whom to contact', () => {
    const email = trialEnding(7);
    expect(email.subject).toBe('Your PlanetPulse Compliance trial ends in 7 days');
    expect(email.text).toContain(
      'The PlanetPulse Compliance trial of Kestrel Metals Group ends in 7 days, on 23 Nov 2026. After that day nobody in the account can sign in until it moves to a paid plan. Your registers and evidence stay as they are.',
    );
    expect(email.text).toContain('contact PlanetPulse before the trial ends');
    expect(email.text).toContain('Open your account: https://app.planetpulse.example/account');
    expect(email.html).toContain('href="https://app.planetpulse.example/account"');
    expect(email.text).toContain('because you are an account admin of Kestrel Metals Group');
  });

  it('says "tomorrow" the day before, and greets an admin with no name', () => {
    const email = trialEnding(1, '');
    expect(email.subject).toBe('Your PlanetPulse Compliance trial ends tomorrow');
    expect(email.text).toContain('ends tomorrow, on 23 Nov 2026');
    expect(email.text.startsWith('Hello,\n')).toBe(true);
  });
});

describe('sign-in link', () => {
  it('carries the link, says it works once and when it expires', () => {
    const email = magicLink();
    expect(email.subject).toBe('Your sign-in link for PlanetPulse Compliance');
    expect(email.text).toContain('It works once and expires in 15 minutes.');
    expect(email.text).toContain(
      'Sign in: https://app.planetpulse.example/login/link?token=tok_abc',
    );
    expect(email.html).toContain('href="https://app.planetpulse.example/login/link?token=tok_abc"');
    expect(email.text).toContain("If it wasn't you, ignore it");
  });

  it('greets without a name when none is on file', () => {
    const email = renderEmail({
      kind: 'MAGIC_LINK',
      recipientName: '',
      expiresInMinutes: 15,
      url: 'https://x.example/l',
    });
    expect(email.text.startsWith('Hello,\n')).toBe(true);
  });
});

describe('invitation', () => {
  it('names who invited, the role and the client with its firm', () => {
    const email = invite();
    expect(email.subject).toBe('Vikram Shah invited you to PlanetPulse Compliance');
    expect(email.text).toContain(
      'Vikram Shah invited you to PlanetPulse Compliance as an owner for Kestrel Metals Group, with Demo Advisory. Set a password to accept. The link expires in 7 days.',
    );
    expect(email.text).toContain(
      'Accept invitation: https://app.planetpulse.example/invite/tok_abc',
    );
  });

  it('names the firm for a firm role, and greets an invitee with no name', () => {
    const email = invite({
      clientName: null,
      role: 'CONSULTANT',
      recipientName: '',
      expiresInDays: 1,
    });
    expect(email.text).toContain(
      'as a consultant for Demo Advisory. Set a password to accept. The link expires in 1 day.',
    );
    expect(email.text.startsWith('Hello,\n')).toBe(true);
  });

  it('labels every role in plain words', () => {
    expect(invite({ role: 'APPROVER' }).text).toContain('as an approver for');
    expect(invite({ role: 'CLIENT_ADMIN' }).text).toContain('as a client admin for');
    expect(invite({ role: 'VIEWER' }).text).toContain('as a viewer for');
    expect(invite({ role: 'FIRM_ADMIN', clientName: null }).text).toContain('as a firm admin for');
  });

  it('escapes the inviter and client names', () => {
    const email = invite({ invitedBy: '<b>V</b>', clientName: 'A & B' });
    expect(email.html).not.toContain('<b>V</b>');
    expect(email.html).toContain('A &amp; B');
  });
});

describe('every email', () => {
  const all = [
    owner(-3),
    owner(0, true),
    approver(1, true),
    approver(7, false),
    approval(false),
    approval(true),
    sentBack(),
    magicLink(),
    invite(),
    trialEnding(),
  ];

  it('escapes names and titles so imported text cannot inject markup', () => {
    const email = renderEmail({
      kind: 'OWNER_REMINDER',
      recipientName: '<img src=x onerror=alert(1)>',
      clientName: 'A & B "Group"',
      offsetDays: 0,
      sentBack: false,
      instance: { ...instance, title: '<script>alert(1)</script>' },
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(email.html).toContain('A &amp; B &quot;Group&quot;');
    const approvalEmail = renderEmail({
      kind: 'APPROVAL_REQUESTED',
      recipientName: 'V',
      clientName: 'C',
      submittedBy: '<b>Asha</b>',
      notApplicable: false,
      offsetDays: 0,
      instance,
    });
    expect(approvalEmail.html).not.toContain('<b>Asha</b>');
    expect(approvalEmail.html).toContain('&lt;b&gt;Asha&lt;/b&gt;');
  });

  it('refuses a non-http link', () => {
    expect(
      () =>
        owner(0) &&
        renderEmail({
          kind: 'OWNER_REMINDER',
          recipientName: 'A',
          clientName: 'B',
          offsetDays: 0,
          sentBack: false,
          instance: { ...instance, url: 'javascript:alert(1)' },
        }),
    ).toThrow('http(s)');
  });

  it('carries the client-facing product name only', () => {
    for (const email of all) {
      expect(email.html).toContain('PlanetPulse Compliance');
      expect(email.text).toContain('PlanetPulse Compliance');
      expect(`${email.subject}${email.html}${email.text}`.toLowerCase()).not.toContain('canopy');
    }
  });

  it('is a complete HTML document with a language and a preheader', () => {
    for (const email of all) {
      expect(email.html.startsWith('<!doctype html>')).toBe(true);
      expect(email.html).toContain('<html lang="en">');
      expect(email.html).toContain('display:none');
    }
  });
});

describe('format helpers', () => {
  it('formats dates as "7 Oct 2026" without time zone shifts', () => {
    expect(formatDate('2026-10-07' as LocalDate)).toBe('7 Oct 2026');
    expect(formatDate('2027-03-31' as LocalDate)).toBe('31 Mar 2027');
    expect(formatDate('2028-02-29' as LocalDate)).toBe('29 Feb 2028');
  });

  it('escapes the five HTML specials', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

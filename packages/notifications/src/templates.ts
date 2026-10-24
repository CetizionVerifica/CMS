import type { Criticality, LocalDate, Role } from '@canopy/contracts';
import { EMAIL_COLORS as c, PRODUCT_NAME } from './brand.js';
import { days, escapeHtml, formatDate, safeUrl } from './format.js';
import { detailsTable, renderLayout } from './layout.js';

/** A rendered email. `text` is the plain-text alternative every message carries. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The instance an owner reminder or approver escalation is about. Names only, no evidence or comments. */
export interface InstanceSummary {
  title: string;
  actName: string;
  unitName: string;
  departmentName: string;
  criticality: Criticality;
  dueDate: LocalDate;
  /** Link to the instance in the register. */
  url: string;
}

export interface OwnerReminderEmail {
  kind: 'OWNER_REMINDER';
  recipientName: string;
  clientName: string;
  /** Days relative to the due date, from the engine: 0 = due today, -3 = due in 3 days. Never positive. */
  offsetDays: number;
  /** True when the approver sent it back and it is the owner's turn again. */
  sentBack: boolean;
  instance: InstanceSummary;
}

export interface ApproverEscalationEmail {
  kind: 'APPROVER_ESCALATION';
  recipientName: string;
  clientName: string;
  /** Days past the due date, from the engine (0 = due today). Never negative. */
  offsetDays: number;
  /** SUBMITTED: waiting for the approver. Otherwise the owner has not submitted yet. */
  awaitingApproval: boolean;
  instance: InstanceSummary;
}

export interface DigestClientSummary {
  clientName: string;
  /** Compliance score from the engine, or null for "No items due". */
  score: number | null;
  overdue: number;
  dueSoon: number;
  awaitingApproval: number;
  /** Link to the client overview. */
  url: string;
}

export interface ConsultantDigestEmail {
  kind: 'CONSULTANT_DIGEST';
  recipientName: string;
  /** The day the digest is for, in the clients' time zone. */
  asOf: LocalDate;
  /** Financial year the scores cover, e.g. "2026-27". */
  fyLabel: string;
  clients: DigestClientSummary[];
}

/** Sent to the approver as soon as an owner submits, or asks to mark the obligation not applicable. */
export interface ApprovalRequestedEmail {
  kind: 'APPROVAL_REQUESTED';
  recipientName: string;
  clientName: string;
  /** Display name of the person who submitted, usually the owner. */
  submittedBy: string;
  /** True when the owner asks to mark it not applicable rather than complied. */
  notApplicable: boolean;
  /** Days relative to the due date on the day it is sent: negative before, positive overdue. */
  offsetDays: number;
  instance: InstanceSummary;
}

/** Sent to the owner as soon as the approver sends a submission back. */
export interface SentBackEmail {
  kind: 'SENT_BACK';
  recipientName: string;
  clientName: string;
  /** Display name of the approver who sent it back. */
  sentBackBy: string;
  /** Days relative to the due date on the day it is sent: negative before, positive overdue. */
  offsetDays: number;
  instance: InstanceSummary;
}

/**
 * A one-time sign-in link. `url` carries the raw token: render it into the message only, never into a log or the
 * send log.
 */
export interface MagicLinkEmail {
  kind: 'MAGIC_LINK';
  recipientName: string;
  /** Minutes until the link stops working. */
  expiresInMinutes: number;
  url: string;
}

/** An invitation to set a password and join. `url` carries the raw token, as for `MagicLinkEmail`. */
export interface InviteEmail {
  kind: 'INVITE';
  /** Empty when the invitee has no name on file yet. */
  recipientName: string;
  invitedBy: string;
  firmName: string;
  /** The client the role is for, or null for a firm role. */
  clientName: string | null;
  role: Role;
  /** Days until the link stops working. */
  expiresInDays: number;
  url: string;
}

/**
 * To an account admin while the account is in its trial (ADR M9-0003): the trial's last day and where to see the
 * account. The account stops working after that day until PlanetPulse moves it to a paid plan.
 */
export interface TrialEndingEmail {
  kind: 'TRIAL_ENDING';
  recipientName: string;
  accountName: string;
  /** The trial's last day. */
  trialEndsOn: LocalDate;
  /** Days from today to `trialEndsOn`: 7, or 1 for the day before. */
  daysLeft: number;
  /** The account page in the app. */
  url: string;
}

export type EmailMessage =
  | OwnerReminderEmail
  | ApproverEscalationEmail
  | ConsultantDigestEmail
  | ApprovalRequestedEmail
  | SentBackEmail
  | MagicLinkEmail
  | InviteEmail
  | TrialEndingEmail;

export const CRITICALITY_LABEL: Record<Criticality, string> = {
  SUPER_CRITICAL: 'Super critical',
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/** Status wording from packages/ui/spec/status-language.md. */
function dueLabel(offsetDays: number): string {
  if (offsetDays < -1) return `Due in ${days(-offsetDays)}`;
  if (offsetDays === -1) return 'Due tomorrow';
  if (offsetDays === 0) return 'Due today';
  return `Overdue ${days(offsetDays)}`;
}

function instanceRows(
  i: InstanceSummary,
  offsetDays: number,
): [string, string, ('crit' | 'warn')?][] {
  const critical = i.criticality === 'SUPER_CRITICAL' || i.criticality === 'CRITICAL';
  return [
    ['Obligation', i.title],
    ['Act', i.actName],
    ['Unit', i.unitName],
    ['Department', i.departmentName],
    ['Criticality', CRITICALITY_LABEL[i.criticality], critical ? 'crit' : undefined],
    [
      'Due date',
      `${formatDate(i.dueDate)} (${dueLabel(offsetDays)})`,
      offsetDays > 0 ? 'crit' : 'warn',
    ],
  ];
}

function textRows(rows: [string, string, unknown?][]): string {
  return rows.map(([label, value]) => `${label}: ${value}`).join('\n');
}

function paragraph(text: string): string {
  return `<p style="margin:0">${escapeHtml(text)}</p>`;
}

function textEmail(lines: (string | null)[]): string {
  return lines.filter((l) => l !== null).join('\n\n') + '\n';
}

function renderOwnerReminder(m: OwnerReminderEmail): RenderedEmail {
  const status = dueLabel(m.offsetDays);
  const intro = m.sentBack
    ? `Your submission for ${m.clientName} was sent back. Please review the approver's comments and submit it again.`
    : `This obligation for ${m.clientName} is assigned to you and has not been submitted yet.`;
  const rows = instanceRows(m.instance, m.offsetDays);
  const greeting = `Hello ${m.recipientName},`;
  const footer = `You get this reminder because you are the owner of this obligation in ${PRODUCT_NAME}.`;
  return {
    subject: `${status}: ${m.instance.title}`,
    html: renderLayout({
      preheader: `${status}. ${m.instance.actName}, ${m.instance.unitName}.`,
      heading: status,
      blocks: [paragraph(greeting), paragraph(intro), detailsTable(rows)],
      cta: { label: 'Open and submit', url: m.instance.url },
      footer,
    }),
    text: textEmail([
      greeting,
      intro,
      textRows(rows),
      `Open and submit: ${safeUrl(m.instance.url)}`,
      footer,
    ]),
  };
}

function renderApproverEscalation(m: ApproverEscalationEmail): RenderedEmail {
  const status = dueLabel(m.offsetDays);
  const intro = m.awaitingApproval
    ? `This obligation for ${m.clientName} is waiting for your approval and its due date has passed.`
    : `This obligation for ${m.clientName} has not been submitted by its owner, and you are its approver.`;
  const ask = m.awaitingApproval
    ? 'Please approve it or send it back.'
    : 'Please follow up with the owner.';
  const rows = instanceRows(m.instance, m.offsetDays);
  const greeting = `Hello ${m.recipientName},`;
  const cta = m.awaitingApproval ? 'Review submission' : 'Open obligation';
  const footer = `You get this escalation because you are the approver of this obligation in ${PRODUCT_NAME}.`;
  return {
    subject: `${m.awaitingApproval ? 'Awaiting your approval' : 'Not submitted'}, ${status.toLowerCase()}: ${m.instance.title}`,
    html: renderLayout({
      preheader: `${status}. ${m.instance.actName}, ${m.instance.unitName}.`,
      heading: m.awaitingApproval ? 'Awaiting your approval' : 'Not submitted yet',
      blocks: [paragraph(greeting), paragraph(`${intro} ${ask}`), detailsTable(rows)],
      cta: { label: cta, url: m.instance.url },
      footer,
    }),
    text: textEmail([
      greeting,
      `${intro} ${ask}`,
      textRows(rows),
      `${cta}: ${safeUrl(m.instance.url)}`,
      footer,
    ]),
  };
}

function renderApprovalRequested(m: ApprovalRequestedEmail): RenderedEmail {
  const heading = m.notApplicable ? 'Not applicable request' : 'Awaiting your approval';
  const intro = m.notApplicable
    ? `${m.submittedBy} asked to mark this obligation for ${m.clientName} as not applicable. Please review the reason, then approve it or send it back.`
    : `${m.submittedBy} submitted this obligation for ${m.clientName}. Please review the submission, then approve it or send it back.`;
  const rows = instanceRows(m.instance, m.offsetDays);
  const greeting = `Hello ${m.recipientName},`;
  const cta = 'Review submission';
  const footer = `You get this email because you are the approver of this obligation in ${PRODUCT_NAME}.`;
  return {
    subject: `${heading}: ${m.instance.title}`,
    html: renderLayout({
      preheader: `${heading}. ${m.instance.actName}, ${m.instance.unitName}.`,
      heading,
      blocks: [paragraph(greeting), paragraph(intro), detailsTable(rows)],
      cta: { label: cta, url: m.instance.url },
      footer,
    }),
    text: textEmail([
      greeting,
      intro,
      textRows(rows),
      `${cta}: ${safeUrl(m.instance.url)}`,
      footer,
    ]),
  };
}

function renderSentBack(m: SentBackEmail): RenderedEmail {
  const intro = `${m.sentBackBy} sent back your submission for ${m.clientName}. Please read the approver's comment, then submit it again.`;
  const rows = instanceRows(m.instance, m.offsetDays);
  const greeting = `Hello ${m.recipientName},`;
  const cta = 'Open and resubmit';
  const footer = `You get this email because you are the owner of this obligation in ${PRODUCT_NAME}.`;
  return {
    subject: `Sent back: ${m.instance.title}`,
    html: renderLayout({
      preheader: `Sent back to you. ${m.instance.actName}, ${m.instance.unitName}.`,
      heading: 'Sent back to you',
      blocks: [paragraph(greeting), paragraph(intro), detailsTable(rows)],
      cta: { label: cta, url: m.instance.url },
      footer,
    }),
    text: textEmail([
      greeting,
      intro,
      textRows(rows),
      `${cta}: ${safeUrl(m.instance.url)}`,
      footer,
    ]),
  };
}

export const ROLE_LABEL: Record<Role, string> = {
  FIRM_ADMIN: 'firm admin',
  CONSULTANT: 'consultant',
  CLIENT_ADMIN: 'client admin',
  APPROVER: 'approver',
  OWNER: 'owner',
  VIEWER: 'viewer',
};

function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

function renderMagicLink(m: MagicLinkEmail): RenderedEmail {
  const greeting = m.recipientName ? `Hello ${m.recipientName},` : 'Hello,';
  const intro = `Use this link to sign in to ${PRODUCT_NAME}. It works once and expires in ${m.expiresInMinutes} minutes.`;
  const footer =
    "You get this email because someone asked for a sign-in link for your address. If it wasn't you, ignore it; nothing changes.";
  return {
    subject: `Your sign-in link for ${PRODUCT_NAME}`,
    html: renderLayout({
      preheader: `Sign in to ${PRODUCT_NAME}. The link expires in ${m.expiresInMinutes} minutes.`,
      heading: 'Sign in',
      blocks: [paragraph(greeting), paragraph(intro)],
      cta: { label: 'Sign in', url: m.url },
      footer,
    }),
    text: textEmail([greeting, intro, `Sign in: ${safeUrl(m.url)}`, footer]),
  };
}

function renderInvite(m: InviteEmail): RenderedEmail {
  const where = m.clientName ? `${m.clientName}, with ${m.firmName}` : m.firmName;
  const role = ROLE_LABEL[m.role];
  const greeting = m.recipientName ? `Hello ${m.recipientName},` : 'Hello,';
  const intro = `${m.invitedBy} invited you to ${PRODUCT_NAME} as ${article(role)} ${role} for ${where}. Set a password to accept. The link expires in ${days(m.expiresInDays)}.`;
  const footer = `You get this email because ${m.invitedBy} entered your address in ${PRODUCT_NAME}. If you don't expect it, ignore it.`;
  return {
    subject: `${m.invitedBy} invited you to ${PRODUCT_NAME}`,
    html: renderLayout({
      preheader: `Join ${where} on ${PRODUCT_NAME}.`,
      heading: "You're invited",
      blocks: [paragraph(greeting), paragraph(intro)],
      cta: { label: 'Accept invitation', url: m.url },
      footer,
    }),
    text: textEmail([greeting, intro, `Accept invitation: ${safeUrl(m.url)}`, footer]),
  };
}

function renderTrialEnding(m: TrialEndingEmail): RenderedEmail {
  const when = m.daysLeft === 1 ? 'tomorrow' : `in ${days(m.daysLeft)}`;
  const greeting = m.recipientName ? `Hello ${m.recipientName},` : 'Hello,';
  const intro = `The ${PRODUCT_NAME} trial of ${m.accountName} ends ${when}, on ${formatDate(m.trialEndsOn)}. After that day nobody in the account can sign in until it moves to a paid plan. Your registers and evidence stay as they are.`;
  const ask = 'To keep working without a break, contact PlanetPulse before the trial ends.';
  const footer = `You get this email because you are an account admin of ${m.accountName} in ${PRODUCT_NAME}.`;
  return {
    subject: `Your ${PRODUCT_NAME} trial ends ${when}`,
    html: renderLayout({
      preheader: `The trial of ${m.accountName} ends on ${formatDate(m.trialEndsOn)}.`,
      heading: `Your trial ends ${when}`,
      blocks: [paragraph(greeting), paragraph(intro), paragraph(ask)],
      cta: { label: 'Open your account', url: m.url },
      footer,
    }),
    text: textEmail([greeting, intro, ask, `Open your account: ${safeUrl(m.url)}`, footer]),
  };
}

function scoreLabel(score: number | null): string {
  return score === null ? 'No items due' : `${score.toFixed(1)}%`;
}

function renderConsultantDigest(m: ConsultantDigestEmail): RenderedEmail {
  const font = "font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const greeting = `Hello ${m.recipientName},`;
  const totalOverdue = m.clients.reduce((n, client) => n + client.overdue, 0);
  const intro =
    m.clients.length === 0
      ? 'You have no active clients this week.'
      : `Here is where your ${m.clients.length === 1 ? 'client stands' : `${m.clients.length} clients stand`} for FY ${m.fyLabel} as of ${formatDate(m.asOf)}. ${totalOverdue === 0 ? 'Nothing is overdue.' : `${totalOverdue} ${totalOverdue === 1 ? 'item is' : 'items are'} overdue.`}`;
  const cell = `padding:8px 8px 8px 0;${font};font-size:13px;border-top:1px solid ${c.line}`;
  const head = `padding:0 8px 6px 0;${font};font-size:12px;color:${c.muted};text-align:left`;
  const num = 'text-align:right;font-variant-numeric:tabular-nums';
  const table =
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">` +
    `<tr><th style="${head}">Client</th><th style="${head};${num}">Score</th><th style="${head};${num}">Overdue</th><th style="${head};${num}">Due soon</th><th style="${head};${num}">Awaiting approval</th></tr>` +
    m.clients
      .map(
        (client) =>
          `<tr><td style="${cell}"><a href="${escapeHtml(safeUrl(client.url))}" style="color:${c.forest};font-weight:600">${escapeHtml(client.clientName)}</a></td>` +
          `<td style="${cell};${num};color:${c.ink}">${scoreLabel(client.score)}</td>` +
          `<td style="${cell};${num};color:${client.overdue > 0 ? c.critInk : c.ink};${client.overdue > 0 ? 'font-weight:600' : ''}">${client.overdue}</td>` +
          `<td style="${cell};${num};color:${c.ink}">${client.dueSoon}</td>` +
          `<td style="${cell};${num};color:${c.ink}">${client.awaitingApproval}</td></tr>`,
      )
      .join('') +
    '</table>';
  const text = m.clients
    .map(
      (client) =>
        `${client.clientName}: score ${scoreLabel(client.score)}, ${client.overdue} overdue, ${client.dueSoon} due soon, ${client.awaitingApproval} awaiting approval. ${safeUrl(client.url)}`,
    )
    .join('\n');
  const footer = `You get this weekly digest because you are a consultant for these clients in ${PRODUCT_NAME}.`;
  return {
    subject: `Weekly digest, ${formatDate(m.asOf)}: ${totalOverdue} overdue`,
    html: renderLayout({
      preheader: intro,
      heading: 'Your weekly digest',
      blocks: [paragraph(greeting), paragraph(intro), ...(m.clients.length > 0 ? [table] : [])],
      cta: null,
      footer,
    }),
    text: textEmail([greeting, intro, m.clients.length > 0 ? text : null, footer]),
  };
}

/** Renders any notification email. Pure: same input, same output. */
export function renderEmail(message: EmailMessage): RenderedEmail {
  switch (message.kind) {
    case 'OWNER_REMINDER':
      return renderOwnerReminder(message);
    case 'APPROVER_ESCALATION':
      return renderApproverEscalation(message);
    case 'CONSULTANT_DIGEST':
      return renderConsultantDigest(message);
    case 'APPROVAL_REQUESTED':
      return renderApprovalRequested(message);
    case 'SENT_BACK':
      return renderSentBack(message);
    case 'MAGIC_LINK':
      return renderMagicLink(message);
    case 'INVITE':
      return renderInvite(message);
    case 'TRIAL_ENDING':
      return renderTrialEnding(message);
  }
}

import type { LocalDate } from '@canopy/contracts';
import { EMAIL_COLORS as c, escapeHtml, formatDate } from '@canopy/notifications';
import type { Renewal } from '@canopy/db';

/** The days ahead the operator's digest looks, for subscriptions and trials alike (ADR M15-0005). */
export const OPERATOR_DIGEST_DAYS = 14;

export interface OperatorDigestEmail {
  subject: string;
  html: string;
  text: string;
}

const WHAT: Record<Renewal['kind'], string> = {
  TRIAL: 'Trial ends',
  SUBSCRIPTION: 'Subscription ends',
};

/**
 * The operator's daily email: every account whose trial or latest subscription ends in the next
 * `OPERATOR_DIGEST_DAYS` days, soonest first, as the console's Renewals page lists them. Account names and dates only:
 * no customer's people, usage or data. Pure: same input, same output.
 */
export function renderOperatorDigest(
  operatorName: string,
  today: LocalDate,
  due: readonly Renewal[],
): OperatorDigestEmail {
  const count = `${due.length} ${due.length === 1 ? 'account' : 'accounts'}`;
  const intro = `${count} ${due.length === 1 ? 'needs' : 'need'} renewing in the next ${OPERATOR_DIGEST_DAYS} days, as of ${formatDate(today)}.`;
  const after = 'Open Renewals in the operator console to convert, extend or record a payment.';
  const footer = 'You get this email because you are a PlanetPulse operator.';
  const line = (r: Renewal) =>
    `${r.name}: ${WHAT[r.kind].toLowerCase()} on ${formatDate(r.endsOn as LocalDate)} (plan ${r.planCode})`;
  const font = "font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const cell = `padding:8px 8px 8px 0;${font};font-size:13px;color:${c.ink};border-top:1px solid ${c.line}`;
  const head = `padding:0 8px 6px 0;${font};font-size:12px;color:${c.muted};text-align:left`;
  const p = (text: string) =>
    `<p style="margin:0 0 12px;${font};font-size:14px;color:${c.ink}">${escapeHtml(text)}</p>`;
  const rows = due
    .map(
      (r) =>
        `<tr><td style="${cell};font-weight:600">${escapeHtml(r.name)}</td>` +
        `<td style="${cell}">${WHAT[r.kind]}</td>` +
        `<td style="${cell}">${escapeHtml(formatDate(r.endsOn as LocalDate))}</td>` +
        `<td style="${cell}">${escapeHtml(r.planCode)}</td></tr>`,
    )
    .join('');
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Renewals due</title></head>' +
    `<body style="margin:0;padding:24px;background:${c.mist}">` +
    `<div style="max-width:600px;margin:0 auto;padding:24px;background:${c.surface};border:1px solid ${c.line}">` +
    `<h1 style="margin:0 0 16px;${font};font-size:20px;color:${c.forest}">Renewals due</h1>` +
    p(`Hello ${operatorName},`) +
    p(intro) +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 12px">' +
    `<tr><th style="${head}">Account</th><th style="${head}">What</th><th style="${head}">On</th><th style="${head}">Plan</th></tr>` +
    rows +
    '</table>' +
    p(after) +
    `<p style="margin:16px 0 0;${font};font-size:12px;color:${c.muted}">${escapeHtml(footer)}</p>` +
    '</div></body></html>';
  return {
    subject: `Renewals due, ${formatDate(today)}: ${count}`,
    html,
    text:
      [`Hello ${operatorName},`, intro, due.map(line).join('\n'), after, footer].join('\n\n') +
      '\n',
  };
}

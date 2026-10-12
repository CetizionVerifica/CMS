import { EMAIL_COLORS as c, PRODUCT_NAME } from './brand.js';
import { escapeHtml, safeUrl } from './format.js';

export interface LayoutInput {
  /** Hidden preview line most mail clients show next to the subject. */
  preheader: string;
  heading: string;
  /** Body blocks, already rendered HTML. */
  blocks: string[];
  cta: { label: string; url: string } | null;
  /** Why the recipient gets this email. */
  footer: string;
}

/**
 * Table-based single-column layout: a forest header band with the product name, a white card, and a muted footer.
 * Inline styles only, max width 600px, so it renders the same in Outlook, Gmail and phone clients.
 */
export function renderLayout(input: LayoutInput): string {
  const font = "font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const cta = input.cta
    ? `<tr><td style="padding:8px 32px 32px"><a href="${escapeHtml(safeUrl(input.cta.url))}" style="display:inline-block;background:${c.forest};color:${c.onForest};${font};font-size:15px;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:8px">${escapeHtml(input.cta.label)}</a></td></tr>`
    : '';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(input.heading)}</title></head>`,
    `<body style="margin:0;padding:0;background:${c.mist}">`,
    `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(input.preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.mist}"><tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${c.surface};border:1px solid ${c.line};border-radius:12px;overflow:hidden">`,
    `<tr><td style="background:${c.forest};padding:16px 32px;${font};font-size:16px;font-weight:700;color:${c.onForest}">${PRODUCT_NAME}</td></tr>`,
    `<tr><td style="padding:28px 32px 8px;${font};font-size:20px;font-weight:700;color:${c.ink}">${escapeHtml(input.heading)}</td></tr>`,
    ...input.blocks.map(
      (block) =>
        `<tr><td style="padding:8px 32px;${font};font-size:15px;line-height:1.5;color:${c.ink}">${block}</td></tr>`,
    ),
    cta,
    '</table>',
    `<p style="max-width:600px;margin:16px auto 0;${font};font-size:12px;line-height:1.5;color:${c.muted}">${escapeHtml(input.footer)}</p>`,
    '</td></tr></table></body></html>',
  ].join('\n');
}

/** A two-column label/value table for instance details. */
export function detailsTable(
  rows: [label: string, value: string, tone?: 'crit' | 'warn'][],
): string {
  const font = "font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const body = rows
    .map(([label, value, tone]) => {
      const color = tone === 'crit' ? c.critInk : tone === 'warn' ? c.warnInk : c.ink;
      const weight = tone ? 'font-weight:600;' : '';
      return `<tr><td style="padding:6px 12px 6px 0;${font};font-size:13px;color:${c.muted};white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 0;${font};font-size:14px;${weight}color:${color}">${escapeHtml(value)}</td></tr>`;
    })
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid ${c.line};border-bottom:1px solid ${c.line}">${body}</table>`;
}

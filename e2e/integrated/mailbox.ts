import { readdirSync, readFileSync } from 'node:fs';

import { MAILBOX_DIR } from './stack.js';

// Reads what the stand-in mail server (fake-smtp.ts) received, decoded to plain text as a mail app would show it.

export interface Mail {
  readonly to: readonly string[];
  readonly subject: string;
  /** Every text part, decoded (quoted-printable or base64). */
  readonly text: string;
}

function decodeQuotedPrintable(body: string): string {
  const bytes = body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

/** One MIME part's headers (lower-cased names, folded lines joined) and decoded body. */
function part(raw: string): { headers: Record<string, string>; body: string } {
  const split = raw.indexOf('\r\n\r\n');
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split + 4) : '';
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const encoding = (headers['content-transfer-encoding'] ?? '7bit').toLowerCase();
  const decoded =
    encoding === 'base64'
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
      : encoding === 'quoted-printable'
        ? decodeQuotedPrintable(body)
        : Buffer.from(body, 'latin1').toString('utf8');
  return { headers, body: decoded };
}

function parse(to: string[], raw: string): Mail {
  const top = part(raw);
  const boundaries = [...raw.matchAll(/boundary="?([^";\r\n]+)"?/gi)].map((m) => m[1]!);
  let texts: string[];
  if (boundaries.length === 0) {
    texts = [top.body];
  } else {
    const pieces = raw.split(
      new RegExp(
        `\\r\\n--(?:${boundaries.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:--)?`,
      ),
    );
    texts = pieces
      .slice(1)
      .map((piece) => part(piece.replace(/^\r\n/, '')))
      .filter((p) => (p.headers['content-type'] ?? '').toLowerCase().startsWith('text/'))
      .map((p) => p.body);
  }
  return { to, subject: top.headers.subject ?? '', text: texts.join('\n') };
}

/** Every message received so far, oldest first. */
export function inbox(): Mail[] {
  let files: string[];
  try {
    files = readdirSync(MAILBOX_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return files.sort().map((name) => {
    const { to, raw } = JSON.parse(readFileSync(new URL(name, MAILBOX_DIR), 'utf8')) as {
      to: string[];
      raw: string;
    };
    return parse(to, raw);
  });
}

/** The newest message to `address`, or undefined. */
export const latestTo = (address: string): Mail | undefined =>
  inbox()
    .filter((mail) => mail.to.includes(address.toLowerCase()))
    .at(-1);

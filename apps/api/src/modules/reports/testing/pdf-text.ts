import { inflateSync } from 'node:zlib';

/** Text drawn in a pdf-lib PDF: inflate each content stream and decode its hex strings. */
export function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const parts: string[] = [];
  let at = 0;
  for (;;) {
    const start = raw.indexOf('stream\n', at);
    if (start < 0) break;
    const end = raw.indexOf('\nendstream', start);
    const body = raw.subarray(start + 7, end);
    at = end + 10;
    let text: string;
    try {
      text = inflateSync(body).toString('latin1');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/<([0-9A-Fa-f]+)> Tj/g)) {
      parts.push(Buffer.from(match[1]!, 'hex').toString('latin1'));
    }
  }
  return parts.join(' ');
}

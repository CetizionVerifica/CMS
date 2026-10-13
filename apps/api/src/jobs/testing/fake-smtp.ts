import { createServer, type Server, type Socket } from 'node:net';

/** One message as the fake server received it. */
export interface ReceivedMail {
  /** The AUTH PLAIN credentials, decoded ("\0user\0pass"), or null without AUTH. */
  auth: string | null;
  from: string;
  to: string[];
  /** The raw DATA section: headers and MIME body, dot-unstuffed. */
  data: string;
}

export interface FakeSmtp {
  port: number;
  received: ReceivedMail[];
  /** Makes the next `n` RCPT commands answer 451 (temporary failure). */
  failNextRecipients(n: number): void;
  close(): Promise<void>;
}

/**
 * A minimal SMTP server for tests, on 127.0.0.1 and a free port: EHLO with AUTH PLAIN, MAIL, RCPT, DATA, RSET, QUIT.
 * No TLS (it does not offer STARTTLS), so the client sends in plain text.
 */
export async function startFakeSmtp(): Promise<FakeSmtp> {
  const received: ReceivedMail[] = [];
  let failures = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let inData = false;
    let current: ReceivedMail = { auth: null, from: '', to: [], data: '' };
    let auth: string | null = null;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 fake-smtp ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end).replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push({ ...current, auth });
          current = { auth: null, from: '', to: [], data: '' };
          reply('250 queued');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          reply('250-fake-smtp');
          reply('250 AUTH PLAIN');
        } else if (verb === 'AUTH') {
          auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
          reply('235 accepted');
        } else if (verb === 'MAIL') {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          reply('250 ok');
        } else if (verb === 'RCPT') {
          if (failures > 0) {
            failures -= 1;
            reply('451 try again later');
          } else {
            current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
            reply('250 ok');
          }
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else {
          current = { auth: null, from: '', to: [], data: '' };
          reply('250 ok');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    received,
    failNextRecipients: (n) => void (failures = n),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

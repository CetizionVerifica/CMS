import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

import { MAILBOX_DIR, SMTP_PORT } from './stack.js';

// A stand-in for the mail server on the integrated run (SMTP_URL), so the API's email jobs (M9) send for real and the
// journeys can read what was sent, as a person reads their inbox: the owner's invite link above all. It speaks just
// enough SMTP for nodemailer (EHLO, MAIL, RCPT, DATA, RSET, NOOP, QUIT), offers no STARTTLS, and keeps each message as
// a JSON file in MAILBOX_DIR (mailbox.ts reads them). The run's own mail only: links in it are this run's tokens.
rmSync(MAILBOX_DIR, { recursive: true, force: true });
mkdirSync(MAILBOX_DIR, { recursive: true });
let received = 0;

const server = createServer((socket) => {
  let buffered = '';
  let inData = false;
  let to: string[] = [];
  let lines: string[] = [];
  const reply = (line: string) => socket.write(`${line}\r\n`);
  reply('220 localhost stand-in SMTP');
  socket.setEncoding('latin1');
  socket.on('data', (data: string) => {
    buffered += data;
    let end: number;
    while ((end = buffered.indexOf('\r\n')) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          received += 1;
          const file = `${String(received).padStart(4, '0')}-${Date.now()}.json`;
          writeFileSync(
            new URL(file, MAILBOX_DIR),
            JSON.stringify({ to, raw: lines.join('\r\n') }),
          );
          to = [];
          lines = [];
          reply('250 2.0.0 Ok: queued');
        } else {
          // SMTP dot-stuffing: a leading dot was doubled by the sender.
          lines.push(line.startsWith('..') ? line.slice(1) : line);
        }
        continue;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO') {
        reply('250-localhost');
        reply('250-SIZE 52428800');
        reply('250 8BITMIME');
      } else if (verb === 'HELO') reply('250 localhost');
      else if (verb === 'MAIL') {
        to = [];
        reply('250 2.1.0 Ok');
      } else if (verb === 'RCPT') {
        const address = /<([^>]*)>/.exec(line)?.[1];
        if (address) to.push(address.toLowerCase());
        reply('250 2.1.5 Ok');
      } else if (verb === 'DATA') {
        inData = true;
        lines = [];
        reply('354 End data with <CR><LF>.<CR><LF>');
      } else if (verb === 'RSET') {
        to = [];
        reply('250 2.0.0 Ok');
      } else if (verb === 'NOOP') reply('250 2.0.0 Ok');
      else if (verb === 'QUIT') {
        reply('221 2.0.0 Bye');
        socket.end();
      } else reply('502 5.5.2 Command not recognised');
    }
  });
  socket.on('error', () => socket.destroy());
});

server.listen(SMTP_PORT, '127.0.0.1');

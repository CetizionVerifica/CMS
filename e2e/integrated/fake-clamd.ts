import { createServer } from 'node:net';

import { CLAMD_PORT, EICAR } from './stack.js';

// A stand-in for ClamAV's daemon on the integrated run, so the API's evidence scan job (M9, CLAMAV_HOST) runs against
// the run's real storage. It speaks clamd's INSTREAM: "zINSTREAM\0", then chunks each prefixed with a 4-byte
// big-endian length, then a zero length. A stream holding EICAR's test string is reported FOUND, as clamd would;
// anything else is OK. clamd's own protocol handling is covered by the API's unit tests (clamav-scanner.test.ts).
const COMMAND = Buffer.from('zINSTREAM\0');

const server = createServer((socket) => {
  let buffered = Buffer.alloc(0);
  let commandSeen = false;
  const content: Buffer[] = [];
  socket.on('data', (data) => {
    buffered = Buffer.concat([buffered, data]);
    if (!commandSeen) {
      if (buffered.length < COMMAND.length) return;
      if (!buffered.subarray(0, COMMAND.length).equals(COMMAND)) {
        socket.end('UNKNOWN COMMAND\0');
        return;
      }
      commandSeen = true;
      buffered = buffered.subarray(COMMAND.length);
    }
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length === 0) {
        const file = Buffer.concat(content).toString('latin1');
        socket.end(file.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        return;
      }
      if (buffered.length < 4 + length) return;
      content.push(buffered.subarray(4, 4 + length));
      buffered = buffered.subarray(4 + length);
    }
  });
  socket.on('error', () => socket.destroy());
});

server.listen(CLAMD_PORT, '127.0.0.1');

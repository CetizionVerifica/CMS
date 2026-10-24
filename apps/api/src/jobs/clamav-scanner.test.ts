import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAMAV_DEFAULT_PORT,
  CLAMAV_DEFAULT_TIMEOUT_MS,
  clamAvConfigFromEnv,
  clamAvScanner,
  parseClamdReply,
} from './clamav-scanner.js';

/** EICAR's test string: every scanner reports it, and it is harmless. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

interface Received {
  command: string;
  /** Lengths of the chunks the scanner sent, in order. */
  chunks: number[];
  bytes: Buffer;
}

/**
 * A stand-in for clamd's INSTREAM: reads "zINSTREAM\0", then length-prefixed chunks until a zero length, and answers
 * with `answer(bytes)`. With `limit`, it answers the size-limit error and closes once more than that has arrived.
 */
function fakeClamd(options: {
  answer?: (bytes: Buffer) => string;
  limit?: number;
  silent?: boolean;
}): Promise<{ port: number; server: Server; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    const entry: Received = { command: '', chunks: [], bytes: Buffer.alloc(0) };
    received.push(entry);
    let done = false;
    socket.on('error', () => {});
    socket.on('data', (data: Buffer) => {
      if (done) return;
      buffer = Buffer.concat([buffer, data]);
      if (!entry.command) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        entry.command = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          done = true;
          if (!options.silent) socket.end(`${options.answer?.(entry.bytes) ?? 'stream: OK'}\0`);
          return;
        }
        if (buffer.length < 4 + length) return;
        entry.chunks.push(length);
        entry.bytes = Buffer.concat([entry.bytes, buffer.subarray(4, 4 + length)]);
        buffer = buffer.subarray(4 + length);
        if (options.limit !== undefined && entry.bytes.length > options.limit) {
          done = true;
          socket.end('INSTREAM size limit exceeded. ERROR\0');
          return;
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as AddressInfo).port, server, received }),
    ),
  );
}

async function* chunksOf(...parts: (string | Buffer)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function scannerAt(options: Parameters<typeof fakeClamd>[0], timeoutMs = 2000) {
  const fake = await fakeClamd(options);
  servers.push(fake.server);
  return { ...fake, scanner: clamAvScanner({ host: '127.0.0.1', port: fake.port, timeoutMs }) };
}

describe('clamAvScanner', () => {
  it('streams the file to INSTREAM in length-prefixed chunks and reads a clean answer', async () => {
    const { scanner, received } = await scannerAt({});
    const big = Buffer.alloc(150 * 1024, 7);
    await expect(scanner.scan(chunksOf('%PDF-1.7 ', big))).resolves.toEqual({ status: 'CLEAN' });
    expect(received[0]!.command).toBe('zINSTREAM');
    // No chunk is over 64 KiB, and every byte arrives in order.
    expect(Math.max(...received[0]!.chunks)).toBeLessThanOrEqual(64 * 1024);
    expect(received[0]!.bytes.equals(Buffer.concat([Buffer.from('%PDF-1.7 '), big]))).toBe(true);
  });

  it('reports what clamd found', async () => {
    const { scanner } = await scannerAt({
      answer: (bytes) =>
        bytes.includes(Buffer.from('EICAR')) ? 'stream: Eicar-Test-Signature FOUND' : 'stream: OK',
    });
    await expect(scanner.scan(chunksOf(EICAR))).resolves.toEqual({
      status: 'INFECTED',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('marks a file over clamd’s stream limit FAILED, even though clamd closes before the end', async () => {
    const { scanner } = await scannerAt({ limit: 100 * 1024 });
    const content = chunksOf(...Array.from({ length: 40 }, () => Buffer.alloc(64 * 1024, 1)));
    await expect(scanner.scan(content)).resolves.toEqual({ status: 'FAILED' });
  });

  it('stops reading the file once clamd has answered', async () => {
    const { scanner } = await scannerAt({ limit: 10 });
    let pulled = 0;
    async function* slow(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 1000; i++) {
        pulled += 1;
        await new Promise((r) => setTimeout(r, 1));
        yield Buffer.alloc(1024, 2);
      }
    }
    await expect(scanner.scan(slow())).resolves.toEqual({ status: 'FAILED' });
    expect(pulled).toBeLessThan(1000);
  });

  it('throws when clamd cannot be reached, so the file is tried again', async () => {
    const { port, server } = await fakeClamd({});
    await new Promise((r) => server.close(r));
    const scanner = clamAvScanner({ host: '127.0.0.1', port, timeoutMs: 1000 });
    await expect(scanner.scan(chunksOf('x'))).rejects.toThrow();
  });

  it('throws when clamd does not answer in time', async () => {
    const { scanner } = await scannerAt({ silent: true }, 200);
    await expect(scanner.scan(chunksOf('x'))).rejects.toThrow('clamd did not answer in time');
  });

  it('throws when clamd closes without an answer', async () => {
    const { scanner } = await scannerAt({ answer: () => '' });
    await expect(scanner.scan(chunksOf('x'))).rejects.toThrow('Unexpected clamd reply');
  });
});

describe('parseClamdReply', () => {
  it('reads OK, FOUND and ERROR answers', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ status: 'CLEAN' });
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      status: 'INFECTED',
      signature: 'Win.Test.EICAR_HDB-1',
    });
    expect(parseClamdReply('INSTREAM size limit exceeded. ERROR\0')).toEqual({ status: 'FAILED' });
    expect(parseClamdReply('stream: Heuristics.Limits.Exceeded.MaxScanSize ERROR')).toEqual({
      status: 'FAILED',
    });
  });

  it('throws on anything else, without echoing it', () => {
    expect(() => parseClamdReply('UNKNOWN COMMAND')).toThrow('Unexpected clamd reply');
  });
});

describe('clamAvConfigFromEnv', () => {
  it('is off without a host', () => {
    expect(clamAvConfigFromEnv({})).toBeNull();
    expect(clamAvConfigFromEnv({ CLAMAV_HOST: '  ' })).toBeNull();
  });

  it('defaults the port and timeout', () => {
    expect(clamAvConfigFromEnv({ CLAMAV_HOST: 'clamav' })).toEqual({
      host: 'clamav',
      port: CLAMAV_DEFAULT_PORT,
      timeoutMs: CLAMAV_DEFAULT_TIMEOUT_MS,
    });
    expect(
      clamAvConfigFromEnv({
        CLAMAV_HOST: 'clamav',
        CLAMAV_PORT: '3311',
        CLAMAV_TIMEOUT_MS: '5000',
      }),
    ).toEqual({ host: 'clamav', port: 3311, timeoutMs: 5000 });
  });

  it('refuses half-set or malformed settings', () => {
    expect(() => clamAvConfigFromEnv({ CLAMAV_PORT: '3310' })).toThrow('without CLAMAV_HOST');
    expect(() => clamAvConfigFromEnv({ CLAMAV_HOST: 'clamav', CLAMAV_PORT: 'x' })).toThrow(
      'CLAMAV_PORT',
    );
    expect(() => clamAvConfigFromEnv({ CLAMAV_HOST: 'clamav', CLAMAV_PORT: '70000' })).toThrow(
      'CLAMAV_PORT',
    );
    expect(() => clamAvConfigFromEnv({ CLAMAV_HOST: 'clamav', CLAMAV_TIMEOUT_MS: '0' })).toThrow(
      'CLAMAV_TIMEOUT_MS',
    );
  });
});

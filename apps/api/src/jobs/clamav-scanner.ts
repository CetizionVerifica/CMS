import { connect, type Socket } from 'node:net';
import type { Scanner, ScanVerdict } from './ports.js';

/**
 * ClamAV's daemon over TCP (clamd INSTREAM), the default scanner. Configured from `CLAMAV_HOST`, with `CLAMAV_PORT`
 * (3310) and `CLAMAV_TIMEOUT_MS` (120000). clamd's `StreamMaxLength` must be at least 26M, above the 25 MiB evidence
 * limit; a file over it comes back FAILED.
 */
export interface ClamAvConfig {
  host: string;
  port: number;
  timeoutMs: number;
}

export const CLAMAV_DEFAULT_PORT = 3310;
export const CLAMAV_DEFAULT_TIMEOUT_MS = 120_000;
/** clamd reads the stream in chunks, each prefixed with its length. */
const CHUNK_BYTES = 64 * 1024;

function positiveInt(name: string, value: string, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new Error(`${name} must be a whole number from 1 to ${max}`);
  return n;
}

/** Null when no scanner is set. Throws when a port or timeout is set without a host, or is not a number. */
export function clamAvConfigFromEnv(env: Record<string, string | undefined>): ClamAvConfig | null {
  const host = env.CLAMAV_HOST?.trim();
  const port = env.CLAMAV_PORT?.trim();
  const timeout = env.CLAMAV_TIMEOUT_MS?.trim();
  if (!host) {
    if (port || timeout)
      throw new Error('CLAMAV_PORT or CLAMAV_TIMEOUT_MS is set without CLAMAV_HOST');
    return null;
  }
  return {
    host,
    port: port ? positiveInt('CLAMAV_PORT', port, 65_535) : CLAMAV_DEFAULT_PORT,
    timeoutMs: timeout
      ? positiveInt('CLAMAV_TIMEOUT_MS', timeout, 3_600_000)
      : CLAMAV_DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Reads clamd's one-line answer. "stream: OK" is clean and "stream: <signature> FOUND" infected. "… ERROR" is about
 * this file (over the size limit, or a scan limit such as an archive bomb), so it is FAILED rather than tried again.
 * Anything else throws, so the file is tried again.
 */
export function parseClamdReply(raw: string): ScanVerdict {
  const reply = raw.replace(/\0+$/, '').trim();
  if (reply === 'stream: OK') return { status: 'CLEAN' };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { status: 'INFECTED', signature: found[1]! };
  if (reply.endsWith(' ERROR')) return { status: 'FAILED' };
  throw new Error('Unexpected clamd reply');
}

function write(socket: Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) =>
    socket.write(data, (error) => (error ? reject(error) : resolve())),
  );
}

export function clamAvScanner(config: ClamAvConfig): Scanner {
  return {
    async scan(content) {
      const socket = connect({ host: config.host, port: config.port });
      let received = '';
      const answered = () => received.includes('\0');
      const reply = new Promise<string>((resolve, reject) => {
        socket.on('data', (data: Buffer) => {
          received += data.toString('utf8');
          if (answered()) resolve(received);
        });
        socket.on('end', () => resolve(received));
        socket.on('close', () => resolve(received));
        // clamd may answer and close before the whole file is sent (size limit): the answer wins over the broken pipe.
        socket.on('error', (error) => (answered() ? resolve(received) : reject(error)));
      });
      reply.catch(() => {});
      socket.setTimeout(config.timeoutMs, () =>
        socket.destroy(new Error('clamd did not answer in time')),
      );
      const send = async (data: Buffer) => {
        try {
          await write(socket, data);
        } catch (error) {
          if (!answered()) throw error;
        }
      };
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
        await send(Buffer.from('zINSTREAM\0'));
        stream: for await (const chunk of content) {
          for (let at = 0; at < chunk.length; at += CHUNK_BYTES) {
            if (answered()) break stream;
            const part = chunk.subarray(at, at + CHUNK_BYTES);
            const length = Buffer.alloc(4);
            length.writeUInt32BE(part.length);
            await send(Buffer.concat([length, part]));
          }
        }
        if (!answered()) await send(Buffer.alloc(4));
        return parseClamdReply(await reply);
      } finally {
        socket.destroy();
      }
    },
  };
}

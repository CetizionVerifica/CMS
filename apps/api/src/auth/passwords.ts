import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (Node's built-in; no dependency). Stored form:
 * `scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>`, so parameters can be raised later and old hashes
 * still verify. Passwords are never logged or stored in clear.
 */

const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }) {
  const options: ScryptOptions = { ...params, maxmem: 128 * params.N * params.r * 2 };
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

const STORED = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/;

/** True when `password` matches `stored`. A malformed or unknown stored value never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = STORED.exec(stored);
  if (!match) return false;
  const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (N > 2 ** 20 || r > 32 || p > 16) return false;
  const expected = Buffer.from(match[5]!, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, Buffer.from(match[4]!, 'base64url'), { N, r, p });
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * Spends the same time as a real check when there is no account or no password, so response times do not
 * reveal which emails exist.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummyHash);
  return false;
}

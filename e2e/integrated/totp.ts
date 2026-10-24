import { createHmac } from 'node:crypto';

// RFC 6238 codes for the seeded firm users' known secret (6 digits, 30-second steps, HMAC-SHA1), as an authenticator
// app would show them. The API refuses a step it already accepted, so `nextUnusedCode` waits out a used one.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase()) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

const usedSteps = new Map<string, number>();

/** A code for the current step, after waiting for the next step if this account already used the current one. */
export async function nextUnusedCode(account: string, secret: string): Promise<string> {
  let step = Math.floor(Date.now() / 30_000);
  if ((usedSteps.get(account) ?? -1) >= step) {
    await new Promise((resolve) => setTimeout(resolve, (step + 1) * 30_000 - Date.now() + 200));
    step += 1;
  }
  usedSteps.set(account, step);
  return totp(secret, step);
}

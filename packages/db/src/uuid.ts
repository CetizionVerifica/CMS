import { randomBytes } from 'node:crypto';

/** A UUIDv7 (RFC 9562), as `canopy_uuid_v7()` makes them: 48-bit Unix milliseconds, then random bits. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a lower-case UUIDv7, the only ids callers may choose (they keep id order = creation order). */
export function isUuidV7(id: string): boolean {
  return V7.test(id);
}

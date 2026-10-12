import { describe, expect, it } from 'vitest';
import { isUuidV7, uuidv7 } from '../src/uuid.js';

describe('uuidv7', () => {
  it('makes version 7 ids that start with the time and sort by it', () => {
    const at = Date.UTC(2026, 9, 12, 3, 0, 0);
    const id = uuidv7(at);
    expect(isUuidV7(id)).toBe(true);
    expect(id.replace(/-/g, '').slice(0, 12)).toBe(at.toString(16).padStart(12, '0'));
    expect(uuidv7(at) < uuidv7(at + 1)).toBe(true);
    expect(uuidv7()).not.toBe(uuidv7());
  });

  it('accepts only lower-case version 7 ids', () => {
    expect(isUuidV7('01920000-0000-4000-8000-000000000001')).toBe(false);
    expect(isUuidV7(uuidv7().toUpperCase())).toBe(false);
    expect(isUuidV7('not a uuid')).toBe(false);
  });
});

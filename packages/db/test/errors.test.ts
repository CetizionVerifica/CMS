import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DbError, rethrow, validate } from '../src/errors.js';

describe('rethrow', () => {
  it.each([
    ['23505', 'DUPLICATE'],
    ['23503', 'NOT_FOUND'],
    ['23514', 'VALIDATION'],
    ['23502', 'VALIDATION'],
    ['22P02', 'VALIDATION'],
    ['42501', 'FORBIDDEN'],
  ])('maps SQLSTATE %s to %s, naming the constraint only', (sqlstate, code) => {
    const pg = Object.assign(new Error('duplicate key value (name)=(Surajit Dasgupta)'), {
      code: sqlstate,
      table: 'person',
      constraint: 'person_email_key',
    });
    const wrapped = Object.assign(new Error('Failed query'), { cause: pg });
    try {
      rethrow(wrapped);
    } catch (e) {
      expect(e).toBeInstanceOf(DbError);
      expect((e as DbError).code).toBe(code);
      expect((e as DbError).message).toBe(`${code} (person.person_email_key)`);
      expect((e as DbError).message).not.toContain('Surajit');
      return;
    }
    throw new Error('did not throw');
  });

  it('passes other errors through unchanged', () => {
    const other = Object.assign(new Error('connection reset'), { code: '08006' });
    expect(() => rethrow(other)).toThrow(other);
    const plain = new Error('boom');
    expect(() => rethrow(plain)).toThrow(plain);
    const dbError = new DbError('NOT_FOUND', 'Not found');
    expect(() => rethrow(dbError)).toThrow(dbError);
  });

  it('omits an unknown table and constraint', () => {
    expect(() => rethrow({ code: '23505' })).toThrow(/^DUPLICATE$/);
  });
});

describe('validate', () => {
  it('returns parsed data, or VALIDATION naming fields but not values', () => {
    const schema = z.strictObject({ email: z.email() });
    expect(validate(schema, { email: 'a@example.com' })).toEqual({ email: 'a@example.com' });
    try {
      validate(schema, { email: 'secret-not-an-email' });
    } catch (e) {
      expect((e as DbError).code).toBe('VALIDATION');
      expect((e as DbError).message).toBe('Invalid input: email');
      return;
    }
    throw new Error('did not throw');
  });

  it('names the root for a non-object', () => {
    expect(() => validate(z.string(), 1)).toThrow('Invalid input: (root)');
  });
});

import { describe, expect, it } from 'vitest';
import { testApp } from '../testing/world.js';

/**
 * M6's 500 log goes through M5's loggableError (auth/log-error.ts, which tests the redaction itself).
 * The shape `pg` gives a unique violation: the values are in `detail`.
 */
function uniqueViolation(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "person_email_key"'),
    {
      code: '23505',
      detail: 'Key (firm_id, email)=(f1, asha.rao@example.com) already exists.',
      table: 'person',
      constraint: 'person_email_key',
      schema: 'public',
      routine: '_bt_check_unique',
    },
  );
}

describe('the M6 error handler', () => {
  it('logs a 500 without the row values a Postgres error carries', async () => {
    const { app, store, call } = testApp();
    const logged: unknown[] = [];
    app.addHook('onRequest', async (request) => {
      request.log.error = ((obj: unknown) => void logged.push(obj)) as typeof request.log.error;
    });
    store.transaction = async () => {
      throw new Error('Failed query: select 1\nparams: asha.rao@example.com', {
        cause: uniqueViolation(),
      });
    };
    const res = await call('firmAdmin', 'GET', '/clients');
    expect(res.status).toBe(500);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      err: { message: 'Failed query: select 1', cause: { code: '23505', table: 'person' } },
    });
    expect(JSON.stringify(logged)).not.toContain('asha.rao@example.com');
    expect(JSON.stringify(res.body)).not.toContain('asha.rao@example.com');
  });
});

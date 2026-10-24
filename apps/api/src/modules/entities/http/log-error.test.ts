import { describe, expect, it } from 'vitest';
import { testApp } from '../testing/world.js';
import { loggableError } from './log-error.js';

/** The shape `pg` gives a unique violation: the values are in `detail`. */
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

describe('loggableError', () => {
  it('logs a Postgres error by its code and names, never its detail or message', () => {
    const logged = loggableError(uniqueViolation());
    expect(logged).toMatchObject({
      type: 'Error',
      code: '23505',
      table: 'person',
      constraint: 'person_email_key',
      routine: '_bt_check_unique',
    });
    expect(logged.message).toBeUndefined();
    expect(JSON.stringify(logged)).not.toContain('asha.rao@example.com');
  });

  it('drops a failed query parameters and follows the cause to the Postgres error', () => {
    const error = new Error(
      'Failed query: insert into "person" ("email") values ($1)\nparams: asha.rao@example.com',
      { cause: uniqueViolation() },
    );
    const logged = loggableError(error);
    expect(logged.message).toBe('Failed query: insert into "person" ("email") values ($1)');
    expect(logged.cause).toMatchObject({ code: '23505', constraint: 'person_email_key' });
    expect(logged.stack).toMatch(/^\s+at /);
    expect(JSON.stringify(logged)).not.toContain('asha.rao@example.com');
  });

  it('keeps an application error message and code, and stops following causes', () => {
    let error: Error = new Error('root');
    for (let i = 0; i < 10; i++) error = new Error(`level ${i}`, { cause: error });
    const logged = loggableError(Object.assign(new Error('boom'), { code: 'ERR_X', cause: error }));
    expect(logged).toMatchObject({ type: 'Error', message: 'boom', code: 'ERR_X' });
    let depth = 0;
    for (let at = logged.cause; at; at = at.cause) depth++;
    expect(depth).toBe(5);
  });

  it('logs only the type of a thrown non-error', () => {
    expect(loggableError('asha.rao@example.com')).toEqual({ type: 'string' });
  });
});

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

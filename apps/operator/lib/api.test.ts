import { describe, expect, it, vi } from 'vitest';

import {
  createOperatorClient,
  errorMessage,
  fieldErrors,
  isOperatorApiError,
  OperatorApiError,
  queryString,
} from './api';
import { account, apiError, fakeApi, ME } from './test/fake-api';

describe('queryString', () => {
  it('leaves out empty values and refuses objects', () => {
    expect(queryString({ status: 'TRIAL', q: '', kind: undefined, limit: 50 })).toBe(
      '?status=TRIAL&limit=50',
    );
    expect(queryString(undefined)).toBe('');
    expect(() => queryString({ a: { b: 1 } })).toThrow(/scalar/);
  });
});

describe('the operator client', () => {
  it('reads with no CSRF token and parses the answer with the contract', async () => {
    const api = fakeApi({ 'GET /accounts/{id}': { body: account() } });
    const client = createOperatorClient({
      fetch: api.fetch,
      csrfToken: () => 'tok-0000000000000001',
    });
    const read = await client.call('getAccount', { params: { id: account().id } });
    expect(read.name).toBe('Kestrel Metals Group');
    expect(api.sent[0]!.path).toBe(`/accounts/${account().id}`);
    expect(api.sent[0]!.headers.get('x-csrf-token')).toBeNull();
  });

  it('sends the CSRF token and the Idempotency-Key on writes', async () => {
    const api = fakeApi({ 'POST /accounts': { status: 201, body: account() } });
    const client = createOperatorClient({
      fetch: api.fetch,
      csrfToken: () => 'tok-0000000000000001',
    });
    await client.call('createAccount', {
      body: {
        name: 'Osprey Textiles Group',
        kind: 'CONSULTANCY',
        planCode: 'BUSINESS',
        legalName: 'Osprey Textiles Group LLP',
        owner: { displayName: 'Ravi Nair', email: 'ravi@osprey.example' },
      },
      idempotencyKey: 'key-1',
    });
    const [sent] = api.sent;
    expect(sent!.headers.get('x-csrf-token')).toBe('tok-0000000000000001');
    expect(sent!.headers.get('idempotency-key')).toBe('key-1');
    expect(sent!.headers.get('content-type')).toBe('application/json');
  });

  it('accepts an empty 202 and needs every path parameter', async () => {
    const api = fakeApi({ 'POST /accounts/{id}/owner-invite': { status: 202 } });
    const client = createOperatorClient({ fetch: api.fetch });
    await expect(
      client.call('resendOwnerInvite', { params: { id: account().id } }),
    ).resolves.toBeNull();
    await expect(client.call('resendOwnerInvite')).rejects.toThrow(/Missing path parameter id/);
  });

  it('turns an error body into its code, and a 401 into a sign-in prompt except at sign-in', async () => {
    const onSignedOut = vi.fn();
    const api = fakeApi({
      'GET /accounts': apiError(401, 'UNAUTHENTICATED', 'Sign in again.'),
      'POST /auth/login': apiError(
        401,
        'UNAUTHENTICATED',
        'Email, password or code is not correct.',
      ),
    });
    const client = createOperatorClient({ fetch: api.fetch, onSignedOut });
    const error = await client.call('listAccounts').catch((e: unknown) => e);
    expect(isOperatorApiError(error, 'UNAUTHENTICATED')).toBe(true);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    await client
      .call('operatorLogin', {
        body: { email: 'ops@planetpulse.example', password: 'x', code: '123456' },
      })
      .catch(() => undefined);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('reports a body that is not a contract error, a broken answer and no answer at all', async () => {
    const api = fakeApi({
      'GET /plans': { status: 502, body: 'bad gateway' },
      'GET /me': { body: { ...ME, csrfToken: 'short' } },
    });
    const client = createOperatorClient({ fetch: api.fetch });
    await expect(client.call('listPlans')).rejects.toMatchObject({ code: 'UNKNOWN', status: 502 });
    await expect(client.call('operatorMe')).rejects.toThrow(
      /Unexpected response from GET \/me: csrfToken/,
    );
    const down = createOperatorClient({ fetch: () => Promise.reject(new TypeError('offline')) });
    await expect(down.call('listPlans')).rejects.toMatchObject({ status: 0, code: 'UNKNOWN' });
  });
});

describe('error text', () => {
  it('explains a stale version and passes other messages through', () => {
    expect(errorMessage(new OperatorApiError(409, 'STALE_VERSION', 'x'))).toMatch(/Reload it/);
    expect(errorMessage(new OperatorApiError(409, 'INVALID_TRANSITION', 'Not from here.'))).toBe(
      'Not from here.',
    );
    expect(errorMessage(new Error('boom'))).toBe('Something went wrong. Try again.');
  });

  it('maps validation issues to fields by path, first message wins', () => {
    const error = new OperatorApiError(400, 'VALIDATION', 'Check the form.', {
      issues: [
        { path: ['body', 'owner', 'email'], message: 'Invalid email' },
        { path: ['body', 'owner', 'email'], message: 'Second' },
        { path: ['body', 'reason'], message: 'Required' },
        { path: [], message: 'Whole body' },
      ],
    });
    expect(fieldErrors(error)).toEqual({ 'owner.email': 'Invalid email', reason: 'Required' });
    expect(fieldErrors(new OperatorApiError(409, 'STALE_VERSION', 'x'))).toEqual({});
  });
});

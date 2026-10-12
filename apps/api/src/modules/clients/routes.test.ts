import { ApiErrorResponse, ClientSettingsView, DEFAULT_CLIENT_SETTINGS } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ids, testApp } from '../entities/testing/world.js';

const error = (body: unknown) => ApiErrorResponse.parse(body).error;

describe('clients', () => {
  it('lists only the clients an actor can see', async () => {
    const { call } = testApp();
    const names = async (actor: Parameters<typeof call>[0]) =>
      ((await call(actor, 'GET', '/clients')).body as { items: { name: string }[] }).items.map(
        (c) => c.name,
      );
    expect(await names('firmAdmin')).toEqual(['Aditya Group', 'Bharat Mills']);
    expect(await names('consultant')).toEqual(['Aditya Group']);
    expect(await names('owner')).toEqual(['Aditya Group']);
    expect(await names('otherFirmAdmin')).toEqual(['Xeno Holdings']);
  });

  it('searches and pages with an opaque cursor', async () => {
    const { call } = testApp();
    const first = await call('firmAdmin', 'GET', '/clients?limit=1&count=true');
    const page1 = first.body as { items: { name: string }[]; nextCursor: string; total: number };
    expect(page1.items.map((c) => c.name)).toEqual(['Aditya Group']);
    expect(page1.total).toBe(2);
    const second = await call('firmAdmin', 'GET', `/clients?limit=1&cursor=${page1.nextCursor}`);
    expect(second.body).toMatchObject({ items: [{ name: 'Bharat Mills' }], nextCursor: null });
    const found = await call('firmAdmin', 'GET', '/clients?q=bhar');
    expect((found.body as { items: unknown[] }).items).toHaveLength(1);
    const bad = await call('firmAdmin', 'GET', '/clients?cursor=nonsense');
    expect(bad.status).toBe(400);
    expect(error(bad.body).code).toBe('VALIDATION');
  });

  it('creates a client with default settings and announces it', async () => {
    const { call, store } = testApp();
    const res = await call('firmAdmin', 'POST', '/clients', { name: 'Chola Foods' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Chola Foods',
      version: 1,
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    expect(store.events.map((e) => e.type)).toEqual(['client.created']);
    expect(store.audits[0]).toMatchObject({ action: 'CREATE', entityType: 'client' });
  });

  it('rejects unknown fields and bad values with VALIDATION issues', async () => {
    const { call } = testApp();
    const res = await call('firmAdmin', 'POST', '/clients', { name: '', firmId: ids.clientA });
    expect(res.status).toBe(400);
    const e = error(res.body);
    expect(e.code).toBe('VALIDATION');
    expect(JSON.stringify(e.details)).toContain('body');
  });

  it('rejects a malformed JSON body as VALIDATION', async () => {
    const { app } = testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients',
      headers: { 'x-test-actor': 'firmAdmin', 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(res.statusCode).toBe(400);
    expect(error(res.json()).code).toBe('VALIDATION');
  });

  it('echoes a well-formed X-Request-Id', async () => {
    const { app } = testApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients',
      headers: { 'x-test-actor': 'firmAdmin', 'x-request-id': 'abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('answers 409 STALE_VERSION with the current version', async () => {
    const { call } = testApp();
    await call('firmAdmin', 'PATCH', `/clients/${ids.clientA}`, { version: 1, name: 'One' });
    const res = await call('firmAdmin', 'PATCH', `/clients/${ids.clientA}`, {
      version: 1,
      name: 'Two',
    });
    expect(res.status).toBe(409);
    expect(error(res.body)).toMatchObject({
      code: 'STALE_VERSION',
      details: { currentVersion: 2 },
    });
  });

  it('does not audit an update that changes nothing', async () => {
    const { call, store } = testApp();
    const res = await call('consultant', 'PATCH', `/clients/${ids.clientA}`, {
      version: 1,
      name: 'Aditya Group',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 1 });
    expect(store.audits).toEqual([]);
  });

  it('archives with a reason, hides the client and restores it', async () => {
    const { call, store } = testApp();
    const archived = await call('firmAdmin', 'POST', `/clients/${ids.clientA}/archive`, {
      version: 1,
      reason: 'Contract ended',
    });
    expect(archived.body).toMatchObject({ version: 2 });
    expect(store.audits.at(-1)).toMatchObject({ action: 'ARCHIVE', reason: 'Contract ended' });
    expect((await call('firmAdmin', 'GET', `/clients/${ids.clientA}`)).status).toBe(404);
    const restored = await call('firmAdmin', 'POST', `/clients/${ids.clientA}/restore`, {
      version: 2,
    });
    expect(restored.body).toMatchObject({ archivedAt: null, version: 3 });
    expect(store.audits.at(-1)).toMatchObject({ action: 'RESTORE' });
  });

  it('hides another client from a consultant as 404, not 403', async () => {
    const { call } = testApp();
    const res = await call('consultant', 'GET', `/clients/${ids.clientB}`);
    expect(res.status).toBe(404);
  });

  describe('settings', () => {
    it('lets a client admin change reminders only', async () => {
      const { call } = testApp();
      const reminders = { ...DEFAULT_CLIENT_SETTINGS.reminders, ownerDaysBefore: [10] };
      const ok = await call('clientAdmin', 'PUT', `/clients/${ids.clientA}/settings`, {
        version: 1,
        reminders,
      });
      expect(ClientSettingsView.parse(ok.body).settings).toEqual({
        ...DEFAULT_CLIENT_SETTINGS,
        reminders,
      });
      const denied = await call('clientAdmin', 'PUT', `/clients/${ids.clientA}/settings`, {
        version: 2,
        settings: DEFAULT_CLIENT_SETTINGS,
      });
      expect(denied.status).toBe(403);
      expect(error(denied.body)).toMatchObject({
        code: 'FORBIDDEN',
        details: { action: 'client.settings' },
      });
    });

    it('needs exactly one of settings and reminders', async () => {
      const { call } = testApp();
      const res = await call('consultant', 'PUT', `/clients/${ids.clientA}/settings`, {
        version: 1,
      });
      expect(res.status).toBe(400);
    });

    it('announces a settings change for the jobs', async () => {
      const { call, store } = testApp();
      await call('consultant', 'PUT', `/clients/${ids.clientA}/settings`, {
        version: 1,
        settings: { ...DEFAULT_CLIENT_SETTINGS, timeZone: 'Asia/Dubai' },
      });
      expect(store.events.at(-1)).toMatchObject({
        type: 'client.updated',
        data: { clientId: ids.clientA, changed: ['settings'] },
      });
    });
  });
});

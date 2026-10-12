import { DEFAULT_CLIENT_SETTINGS, ENDPOINTS, type Client } from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { canSeeClient, isFirmStaff } from '../entities/http/access.js';
import { forbidden, notFound } from '../entities/http/errors.js';
import { pageOf } from '../entities/http/page.js';
import { mount, type M6Deps } from '../entities/http/route.js';
import { emit } from '../entities/events.js';
import type { Tx } from '../entities/store.js';
import { auditedInsert, auditedUpdate, getLive, instantOf } from '../entities/write.js';

/** Clients and client settings (docs/contracts/endpoints.md §3). */
export function clientRoutes(app: FastifyInstance, deps: M6Deps): void {
  const { store } = deps;
  const now = () => instantOf((deps.now ?? (() => new Date()))());

  /** The client, if the actor may see it; archived clients are 404 except to restore. */
  async function visibleClient(tx: Tx, ctx: Parameters<typeof canSeeClient>[0], id: string) {
    if (!canSeeClient(ctx, id)) throw notFound();
    const client = await tx.clients.get(id);
    if (!client) throw notFound();
    return client;
  }

  async function changed(tx: Tx, client: Client, fields: string[]) {
    await emit(
      tx,
      { type: 'client.updated', data: { clientId: client.id, changed: fields } },
      { type: 'client', id: client.id, version: client.version },
      client.id,
    );
  }

  mount(app, deps, ENDPOINTS.listClients, async (call) => {
    const { query, ctx } = call;
    // Firm staff list from the firm; a client role is checked in each client it belongs to.
    for (const clientId of isFirmStaff(ctx) ? [null] : ctx.clientIds) {
      call.authorize({ type: 'client', clientId });
    }
    return store.transaction(ctx, (tx) =>
      pageOf(tx.clients, query, {
        orderBy: 'name',
        where: { id: ctx.clientIds },
        ...(query.q ? { search: { text: query.q, fields: ['name'] as const } } : {}),
      }),
    );
  });

  mount(app, deps, ENDPOINTS.createClient, async (call) => {
    call.authorize({ type: 'client', clientId: null });
    const { body, ctx } = call;
    return store.transaction(ctx, async (tx) => {
      const client = await auditedInsert(
        tx,
        tx.clients,
        'client',
        { name: body.name, settings: body.settings ?? DEFAULT_CLIENT_SETTINGS },
        (row) => row.id,
      );
      await emit(
        tx,
        { type: 'client.created', data: { clientId: client.id, changed: ['name', 'settings'] } },
        { type: 'client', id: client.id, version: client.version },
        client.id,
      );
      return client;
    });
  });

  mount(app, deps, ENDPOINTS.getClient, async (call) => {
    const clientId = call.params.clientId as string;
    call.authorize({ type: 'client', clientId });
    return store.transaction(call.ctx, (tx) => getLive(tx.clients, clientId));
  });

  mount(app, deps, ENDPOINTS.updateClient, async (call) => {
    const clientId = call.params.clientId as string;
    call.authorize({ type: 'client', clientId });
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.clients, clientId);
      const client = await auditedUpdate({
        tx,
        repo: tx.clients,
        entityType: 'client',
        row,
        version: body.version,
        patch: { name: body.name },
        clientId,
      });
      if (client !== row) await changed(tx, client, ['name']);
      return client;
    });
  });

  mount(app, deps, ENDPOINTS.archiveClient, async (call) => {
    const clientId = call.params.clientId as string;
    call.authorize({ type: 'client', clientId });
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.clients, clientId);
      const client = await auditedUpdate({
        tx,
        repo: tx.clients,
        entityType: 'client',
        row,
        version: body.version,
        patch: { archivedAt: now() },
        clientId,
        action: 'ARCHIVE',
        reason: body.reason,
      });
      await changed(tx, client, ['archivedAt']);
      return client;
    });
  });

  mount(app, deps, ENDPOINTS.restoreClient, async (call) => {
    const clientId = call.params.clientId as string;
    call.authorize({ type: 'client', clientId });
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await visibleClient(tx, call.ctx, clientId);
      const client = await auditedUpdate({
        tx,
        repo: tx.clients,
        entityType: 'client',
        row,
        version: body.version,
        patch: { archivedAt: null },
        clientId,
        action: 'RESTORE',
      });
      if (client !== row) await changed(tx, client, ['archivedAt']);
      return client;
    });
  });

  mount(app, deps, ENDPOINTS.getClientSettings, async (call) => {
    const clientId = call.params.clientId as string;
    call.authorize({ type: 'client', clientId });
    return store.transaction(call.ctx, async (tx) => {
      const client = await getLive(tx.clients, clientId);
      return { clientId, version: client.version, settings: client.settings };
    });
  });

  mount(app, deps, ENDPOINTS.putClientSettings, async (call) => {
    const clientId = call.params.clientId as string;
    const roles = call.authorize({ type: 'client', clientId });
    const { body } = call;
    // A client admin may change only the reminder settings (endpoints.md §3).
    const firmSide = roles.includes('FIRM_ADMIN') || roles.includes('CONSULTANT');
    if (body.settings !== undefined && !firmSide) throw forbidden('client.settings');
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.clients, clientId);
      const settings = body.settings ?? { ...row.settings, reminders: body.reminders! };
      const client = await auditedUpdate({
        tx,
        repo: tx.clients,
        entityType: 'client',
        row,
        version: body.version,
        patch: { settings },
        clientId,
      });
      if (client !== row) await changed(tx, client, ['settings']);
      return { clientId, version: client.version, settings: client.settings };
    });
  });
}

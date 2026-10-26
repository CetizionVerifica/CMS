import type { AuditEvent, ENDPOINTS, EvidenceView, RequestContext } from '@canopy/contracts';
import {
  auditEvents,
  clients,
  evidence,
  tenantFromRequest,
  type Database,
  type Page,
  type TenantTx,
} from '@canopy/db';
import type { z } from 'zod';
import { loadInstance, toApiError } from '../instances/access.js';
import { instanceResource } from '../instances/allowed-actions.js';
import { listKinds } from '../instances/iso-switch.js';
import { unitScope } from '../instances/scope.js';
import type { Actor } from '../instances/service.js';
import { exclusiveTo, requireCursor, scopedUnits, uploadWindow } from './bounds.js';

/**
 * M7's read side of the trail (endpoints.md §4): the evidence vault and the audit trail of a client and of
 * one instance. With the ISO add-on off the vault leaves STANDARD instances' evidence out and an instance's trail
 * answers 403 for a STANDARD instance; the client trail is not gated (docs/iso/plan.md §4.4). Reads write nothing. Lists are newest first, paged by cursor, without a total (ADR 0004 §15).
 * Evidence is listed as metadata only; downloads go through `GET /evidence/{id}/download-url`, which is audited.
 */

type VaultQuery = z.infer<(typeof ENDPOINTS)['evidenceVault']['query']>;
type ClientAuditQuery = z.infer<(typeof ENDPOINTS)['clientAudit']['query']>;
type InstanceAuditQuery = z.infer<(typeof ENDPOINTS)['instanceAudit']['query']>;

export interface AuditServiceOptions {
  readonly db: Database;
}

export function createAuditService(options: AuditServiceOptions) {
  const { db } = options;

  function inTenant<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return db.withTenant(tenantFromRequest(ctx), fn).catch(toApiError);
  }

  return {
    /** GET /clients/{clientId}/evidence: APPROVER and OWNER see only their units. */
    async vault(actor: Actor, clientId: string, query: VaultQuery): Promise<Page<EvidenceView>> {
      actor.authorize('evidence.read', { type: 'client', clientId });
      const after = requireCursor(query.cursor);
      const kinds = await listKinds(actor.ctx, query.source);
      return inTenant(actor.ctx, async (tx) => {
        const client = await clients.require(tx, clientId);
        const unitIds = scopedUnits(query.unitId, unitScope(actor.ctx, clientId));
        return evidence.vault(tx, clientId, {
          ...(unitIds === undefined ? {} : { unitIds }),
          ...(query.actId === undefined ? {} : { actIds: query.actId }),
          ...(query.departmentId === undefined ? {} : { departmentIds: query.departmentId }),
          ...(query.scanStatus === undefined ? {} : { scanStatus: query.scanStatus }),
          ...(query.q === undefined ? {} : { q: query.q }),
          ...kinds,
          ...uploadWindow(query, client.settings.timeZone),
          after,
          limit: query.limit,
        });
      });
    },

    /** GET /clients/{clientId}/audit: the whole client's trail, for the roles that see the whole client. */
    async clientTrail(
      actor: Actor,
      clientId: string,
      query: ClientAuditQuery,
    ): Promise<Page<AuditEvent>> {
      // APPROVER and OWNER hold `audit.read` only on instance resources, so a client resource refuses them.
      actor.authorize('audit.read', { type: 'client', clientId });
      const after = requireCursor(query.cursor);
      return inTenant(actor.ctx, (tx) =>
        auditEvents.query(tx, {
          clientId,
          ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
          ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
          ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
          ...(query.action === undefined ? {} : { action: query.action }),
          ...(query.from === undefined ? {} : { from: query.from }),
          ...(query.to === undefined ? {} : { to: exclusiveTo(query.to) }),
          after,
          limit: query.limit,
        }),
      );
    },

    /** GET /instances/{id}/audit: one instance's history, its evidence events included. */
    async instanceTrail(
      actor: Actor,
      id: string,
      query: InstanceAuditQuery,
    ): Promise<Page<AuditEvent>> {
      const after = requireCursor(query.cursor);
      return inTenant(actor.ctx, async (tx) => {
        const instance = await loadInstance(tx, actor.ctx, id);
        actor.authorize('audit.read', instanceResource(instance));
        return auditEvents.query(tx, {
          clientId: instance.clientId,
          entityType: 'instance',
          entityId: instance.id,
          after,
          limit: query.limit,
        });
      });
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;

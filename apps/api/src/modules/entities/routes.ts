import { ENDPOINTS, type Id, type Unit } from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { unitScope } from './http/access.js';
import { HttpError, invalid } from './http/errors.js';
import { pageOf } from './http/page.js';
import { mount, type M6Deps } from './http/route.js';
import { emit } from './events.js';
import { mergeInto } from './merge.js';
import type { Tx } from './store.js';
import { auditedInsert, auditedUpdate, getLive, instantOf } from './write.js';

const PLAN_NOUN = { companies: ['company', 'companies'], units: ['unit', 'units'] } as const;

/** Companies, units, locations and departments (docs/contracts/endpoints.md §3). */
export function entityRoutes(app: FastifyInstance, deps: M6Deps): void {
  const { store } = deps;
  const clock = () => (deps.now ?? (() => new Date()))();

  const search = (q: string | undefined, fields: readonly string[]) =>
    q ? { search: { text: q, fields } } : {};

  async function liveClient(tx: Tx, clientId: Id) {
    await getLive(tx.clients, clientId);
  }

  /** A company of `clientId` that is not archived; 400 when it belongs elsewhere. */
  async function companyOf(tx: Tx, clientId: Id, companyId: Id) {
    const company = await tx.companies.get(companyId);
    if (!company || company.archivedAt !== null || company.clientId !== clientId) {
      throw invalid('Unknown company for this client.', ['body', 'companyId']);
    }
  }

  async function liveLocation(tx: Tx, locationId: Id) {
    const location = await tx.locations.get(locationId);
    if (!location || location.archivedAt !== null) {
      throw invalid('Unknown location.', ['body', 'locationId']);
    }
  }

  /** 403 PLAN_LIMIT_REACHED when one more would pass the plan's limit; holds the usage lock to commit. */
  async function withinPlan(tx: Tx, limit: 'companies' | 'units') {
    const { max, used } = await tx.planAllowance(limit);
    if (max !== null && used >= max) {
      throw new HttpError(
        'PLAN_LIMIT_REACHED',
        `Your plan allows ${max} ${max === 1 ? PLAN_NOUN[limit][0] : PLAN_NOUN[limit][1]}. Contact PlanetPulse to upgrade.`,
        { limit, max, used },
      );
    }
  }

  function unitEvent(tx: Tx, type: 'unit.created' | 'unit.updated' | 'unit.archived', unit: Unit) {
    return emit(
      tx,
      {
        type,
        data: { unitId: unit.id, companyId: unit.companyId, locationId: unit.locationId },
      },
      { type: 'unit', id: unit.id, version: unit.version },
      unit.clientId,
    );
  }

  // ---------- companies ----------

  mount(app, deps, ENDPOINTS.listCompanies, async (call) => {
    const clientId = call.params.clientId as Id;
    call.authorize({ type: 'company', clientId });
    return store.transaction(call.ctx, async (tx) => {
      await liveClient(tx, clientId);
      return pageOf(tx.companies, call.query, {
        orderBy: 'name',
        where: { clientId },
        ...search(call.query.q, ['name']),
      });
    });
  });

  mount(app, deps, ENDPOINTS.createCompany, async (call) => {
    const clientId = call.params.clientId as Id;
    call.authorize({ type: 'company', clientId });
    return store.transaction(call.ctx, async (tx) => {
      await liveClient(tx, clientId);
      await withinPlan(tx, 'companies');
      return auditedInsert(
        tx,
        tx.companies,
        'company',
        { clientId, name: call.body.name },
        () => clientId,
      );
    });
  });

  mount(app, deps, ENDPOINTS.updateCompany, async (call) => {
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.companies, call.params.id as Id);
      call.authorize({ type: 'company', clientId: row.clientId });
      return auditedUpdate({
        tx,
        repo: tx.companies,
        entityType: 'company',
        row,
        version: call.body.version,
        patch: { name: call.body.name },
        clientId: row.clientId,
      });
    });
  });

  mount(app, deps, ENDPOINTS.archiveCompany, async (call) => {
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.companies, call.params.id as Id);
      call.authorize({ type: 'company', clientId: row.clientId });
      const units = await tx.units.findAll({ companyId: row.id });
      if (units.length > 0) {
        throw invalid('Archive or move the units of this company first.', ['params', 'id']);
      }
      return auditedUpdate({
        tx,
        repo: tx.companies,
        entityType: 'company',
        row,
        version: call.body.version,
        patch: { archivedAt: instantOf(clock()) },
        clientId: row.clientId,
        action: 'ARCHIVE',
        reason: call.body.reason,
      });
    });
  });

  // ---------- units ----------

  mount(app, deps, ENDPOINTS.listUnits, async (call) => {
    const clientId = call.params.clientId as Id;
    call.authorize({ type: 'unit', clientId });
    // Owners and approvers limited to some units see only those (endpoints.md §1).
    const units = unitScope(call.ctx, clientId);
    return store.transaction(call.ctx, async (tx) => {
      await liveClient(tx, clientId);
      return pageOf(tx.units, call.query, {
        orderBy: 'name',
        where: {
          clientId,
          ...(call.query.companyId ? { companyId: call.query.companyId } : {}),
          ...(units ? { id: units } : {}),
        },
        ...search(call.query.q, ['name']),
      });
    });
  });

  mount(app, deps, ENDPOINTS.createUnit, async (call) => {
    const clientId = call.params.clientId as Id;
    call.authorize({ type: 'unit', clientId });
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      await liveClient(tx, clientId);
      await companyOf(tx, clientId, body.companyId);
      await liveLocation(tx, body.locationId);
      await withinPlan(tx, 'units');
      const unit = await auditedInsert(
        tx,
        tx.units,
        'unit',
        { clientId, companyId: body.companyId, name: body.name, locationId: body.locationId },
        () => clientId,
      );
      await unitEvent(tx, 'unit.created', unit);
      return unit;
    });
  });

  mount(app, deps, ENDPOINTS.updateUnit, async (call) => {
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.units, call.params.id as Id);
      call.authorize({ type: 'unit', clientId: row.clientId, unitId: row.id });
      if (body.companyId !== undefined) await companyOf(tx, row.clientId, body.companyId);
      if (body.locationId !== undefined) await liveLocation(tx, body.locationId);
      const unit = await auditedUpdate({
        tx,
        repo: tx.units,
        entityType: 'unit',
        row,
        version: body.version,
        patch: { companyId: body.companyId, name: body.name, locationId: body.locationId },
        clientId: row.clientId,
      });
      if (unit !== row) await unitEvent(tx, 'unit.updated', unit);
      return unit;
    });
  });

  mount(app, deps, ENDPOINTS.archiveUnit, async (call) => {
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.units, call.params.id as Id);
      call.authorize({ type: 'unit', clientId: row.clientId, unitId: row.id });
      const assignments = await tx.assignments.findAll({ unitId: row.id });
      if (assignments.length > 0) {
        throw invalid('Archive the assignments of this unit first.', ['params', 'id']);
      }
      const unit = await auditedUpdate({
        tx,
        repo: tx.units,
        entityType: 'unit',
        row,
        version: call.body.version,
        patch: { archivedAt: instantOf(clock()) },
        clientId: row.clientId,
        action: 'ARCHIVE',
        reason: call.body.reason,
      });
      await unitEvent(tx, 'unit.archived', unit);
      return unit;
    });
  });

  // ---------- locations (firm-wide) ----------

  mount(app, deps, ENDPOINTS.listLocations, async (call) => {
    call.authorize({ type: 'location', clientId: null });
    const { query } = call;
    return store.transaction(call.ctx, (tx) =>
      pageOf(tx.locations, query, {
        orderBy: 'country',
        where: {
          ...(query.countryCode ? { countryCode: query.countryCode } : {}),
          ...(query.stateCode ? { stateCode: query.stateCode } : {}),
        },
        ...search(query.q, ['country', 'state', 'city']),
      }),
    );
  });

  mount(app, deps, ENDPOINTS.createLocation, async (call) => {
    call.authorize({ type: 'location', clientId: null });
    const { body } = call;
    if ((body.state === null) !== (body.stateCode === null)) {
      throw invalid('Give the state and its code together.', ['body', 'stateCode']);
    }
    return store.transaction(call.ctx, (tx) =>
      auditedInsert(tx, tx.locations, 'location', body, () => null),
    );
  });

  // ---------- departments ----------

  mount(app, deps, ENDPOINTS.listDepartments, async (call) => {
    const clientId = call.params.clientId as Id;
    call.authorize({ type: 'department', clientId });
    return store.transaction(call.ctx, async (tx) => {
      await liveClient(tx, clientId);
      return pageOf(tx.departments, call.query, {
        orderBy: 'name',
        where: { clientId },
        ...search(call.query.q, ['name']),
      });
    });
  });

  mount(app, deps, ENDPOINTS.createDepartment, async (call) => {
    const clientId = call.params.clientId as Id;
    call.authorize({ type: 'department', clientId });
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      await liveClient(tx, clientId);
      return auditedInsert(
        tx,
        tx.departments,
        'department',
        { clientId, name: body.name, aliases: body.aliases },
        () => clientId,
      );
    });
  });

  mount(app, deps, ENDPOINTS.updateDepartment, async (call) => {
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const row = await getLive(tx.departments, call.params.id as Id);
      call.authorize({ type: 'department', clientId: row.clientId });
      return auditedUpdate({
        tx,
        repo: tx.departments,
        entityType: 'department',
        row,
        version: body.version,
        patch: { name: body.name, aliases: body.aliases },
        clientId: row.clientId,
      });
    });
  });

  mount(app, deps, ENDPOINTS.mergeDepartments, async (call) => {
    const { body } = call;
    return store.transaction(call.ctx, async (tx) => {
      const target = await getLive(tx.departments, call.params.id as Id);
      call.authorize({ type: 'department', clientId: target.clientId });
      return mergeInto({
        tx,
        repo: tx.departments,
        entityType: 'department',
        target,
        version: body.version,
        sourceIds: body.sourceIds,
        clientId: target.clientId,
        now: clock(),
        sameScope: (source) => source.clientId === target.clientId,
        moveReferences: async (sourceId, targetId) => {
          for (const a of await tx.assignments.findAll({ departmentId: sourceId })) {
            await auditedUpdate({
              tx,
              repo: tx.assignments,
              entityType: 'assignment',
              row: a,
              version: a.version,
              patch: { departmentId: targetId },
              clientId: a.clientId,
              action: 'MERGE_ALIAS',
            });
          }
        },
      });
    });
  });
}

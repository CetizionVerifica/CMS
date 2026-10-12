// M6 endpoints: clients, entities, people, memberships, the library and assignments.
import { DEFAULT_CLIENT_SETTINGS } from '../../defaults.js';
import type { Role } from '../../enums.js';
import {
  type Actor,
  audit,
  checkVersion,
  diff,
  fresh,
  fyRange,
  hasRole,
  libraryIsFiltered,
  live,
  matches,
  MockError,
  notFound,
  paginate,
  touch,
  visibleClientIds,
} from '../core.js';
import { actorOf, type HandlerContext, type EndpointId, type PartialHandlers } from '../handler.js';
import { periodsIn, previewPeriods } from '../periods.js';
import { type FirmData, type InstanceRecord, isFirmRole, type Row } from '../store.js';

type Ctx = HandlerContext<EndpointId>;

const byName = <T extends { name: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.name.localeCompare(b.name));

function find<K extends keyof FirmData>(
  actor: Actor,
  collection: K,
  id: string | undefined,
): Row<K> {
  const rows = actor.firm.data[collection] as unknown as (Row<K> & {
    id: string;
    archivedAt?: string | null;
  })[];
  const row = rows.find((r) => r.id === id && (r.archivedAt ?? null) === null);
  if (row === undefined) throw notFound();
  return row;
}

/** 400 VALIDATION for a body field that names something the firm does not have. */
function unknownRef(field: string, what: string): MockError {
  return new MockError('VALIDATION', `Unknown ${what}`, {
    issues: [{ path: [field], message: `Unknown ${what}` }],
  });
}

function ref<K extends keyof FirmData>(
  actor: Actor,
  collection: K,
  id: string,
  field: string,
  clientId?: string,
): Row<K> {
  const rows = actor.firm.data[collection] as unknown as (Row<K> & {
    id: string;
    archivedAt?: string | null;
    clientId?: string | null;
  })[];
  const row = rows.find(
    (r) =>
      r.id === id &&
      (r.archivedAt ?? null) === null &&
      (clientId === undefined || r.clientId === clientId),
  );
  if (row === undefined) throw unknownRef(field, collection.replace(/s$/, ''));
  return row;
}

function noDuplicateName(
  rows: { id: string; name: string; archivedAt: string | null }[],
  name: string,
  exceptId?: string,
): void {
  const clash = rows.find(
    (r) =>
      r.archivedAt === null && r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash !== undefined) {
    throw new MockError('DUPLICATE', `"${name}" already exists`, {
      field: 'name',
      existingId: clash.id,
    });
  }
}

/** Applies a PATCH body (minus `version`) to a row, bumps its version and writes an UPDATE audit event. */
function patch<T extends { id: string; version: number; updatedAt: string }>(
  ctx: Ctx,
  row: T,
  changes: Record<string, unknown>,
  entityType: Row<'auditEvents'>['entityType'],
  clientId: string | null,
): T {
  const actor = actorOf(ctx);
  const { version, ...fields } = changes as { version: number } & Record<string, unknown>;
  checkVersion(row, version);
  const before = { ...row } as Record<string, unknown>;
  Object.assign(row, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
  touch(row, ctx.clock);
  audit(ctx, actor, {
    action: 'UPDATE',
    entityType,
    entityId: row.id,
    clientId,
    ...diff(before, row as Record<string, unknown>),
  });
  return row;
}

function archive<
  T extends { id: string; version: number; updatedAt: string; archivedAt: string | null },
>(
  ctx: Ctx,
  row: T,
  body: { version: number; reason: string },
  entityType: Row<'auditEvents'>['entityType'],
  clientId: string | null,
): T {
  checkVersion(row, body.version);
  row.archivedAt = ctx.clock.now();
  touch(row, ctx.clock);
  audit(ctx, actorOf(ctx), {
    action: 'ARCHIVE',
    entityType,
    entityId: row.id,
    clientId,
    reason: body.reason,
  });
  return row;
}

/** The client a person-scoped call acts in: one the person belongs to that the actor can see. */
function personScope(actor: Actor, personId: string): string | null {
  const d = actor.firm.data;
  const clients = new Set<string>([
    ...d.memberships
      .filter((m) => m.personId === personId && m.clientId !== null)
      .map((m) => m.clientId!),
    ...d.instances
      .filter((i) => i.ownerId === personId || i.approverId === personId)
      .map((i) => i.clientId),
    ...d.assignments
      .filter((a) => a.defaultOwnerId === personId || a.defaultApproverId === personId)
      .map((a) => a.clientId),
  ]);
  const visible = visibleClientIds(actor).filter((id) => clients.has(id));
  if (visible.length > 0) return visible[0]!;
  if (hasRole(actor, null, ['FIRM_ADMIN', 'CONSULTANT'])) return null;
  throw notFound();
}

/** People who belong to a client: members, and owners or approvers of its work. */
function clientPeople(d: FirmData, clientId: string): Row<'people'>[] {
  const ids = new Set<string>([
    ...d.memberships
      .filter((m) => m.clientId === clientId && m.archivedAt === null)
      .map((m) => m.personId),
    ...d.assignments
      .filter((a) => a.clientId === clientId)
      .flatMap((a) => [a.defaultOwnerId, a.defaultApproverId]),
    ...d.instances.filter((i) => i.clientId === clientId).flatMap((i) => [i.ownerId, i.approverId]),
  ]);
  return live(d.people).filter((p) => ids.has(p.id));
}

/** Library rows a client-only actor may see: those used by assignments in their clients. */
function usedObligationIds(actor: Actor): Set<string> {
  const clients = new Set(visibleClientIds(actor));
  return new Set(
    actor.firm.data.assignments
      .filter((a) => clients.has(a.clientId) && a.archivedAt === null)
      .map((a) => a.obligationId),
  );
}

/** Instances for each period of the client's current FY (the real API generates them with the engine). */
function generateInstances(ctx: Ctx, assignment: Row<'assignments'>): InstanceRecord[] {
  const actor = actorOf(ctx);
  const d = actor.firm.data;
  const client = d.clients.find((c) => c.id === assignment.clientId)!;
  const obligation = d.obligations.find((o) => o.id === assignment.obligationId)!;
  const today = ctx.clock.today();
  const startMonth = client.settings.fyStartMonth;
  const startYear =
    Number(today.slice(5, 7)) >= startMonth
      ? Number(today.slice(0, 4))
      : Number(today.slice(0, 4)) - 1;
  const fy = fyRange(`${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`, startMonth);
  const from = assignment.activeFrom > fy.from ? assignment.activeFrom : fy.from;
  const to =
    assignment.activeTo !== null && assignment.activeTo < fy.to ? assignment.activeTo : fy.to;
  if (from > to) return [];
  // Every period of the FY that overlaps the active range, including the last one, which falls due after the FY.
  const periods = periodsIn(obligation.recurrenceRule, startYear, startMonth).filter(
    (p) => p.periodEnd >= from && p.periodStart <= to,
  );
  return periods.map((period) => ({
    ...fresh(ctx, d.firm.id),
    clientId: assignment.clientId,
    unitId: assignment.unitId,
    assignmentId: assignment.id,
    ...period,
    workflowState: 'OPEN' as const,
    pendingKind: null,
    completedOn: null,
    naReason: null,
    ownerId: assignment.defaultOwnerId,
    approverId: assignment.defaultApproverId,
    submittedAt: null,
    approvedAt: null,
    dueDateOverridden: false,
  }));
}

function createAssignment(
  ctx: Ctx,
  clientId: string,
  body: {
    unitId: string;
    obligationId: string;
    departmentId: string;
    defaultOwnerId: string;
    defaultApproverId: string;
    activeFrom: string;
    activeTo: string | null;
  },
): Row<'assignments'> {
  const actor = actorOf(ctx);
  const d = actor.firm.data;
  ref(actor, 'units', body.unitId, 'unitId', clientId);
  ref(actor, 'obligations', body.obligationId, 'obligationId');
  ref(actor, 'departments', body.departmentId, 'departmentId', clientId);
  ref(actor, 'people', body.defaultOwnerId, 'defaultOwnerId');
  ref(actor, 'people', body.defaultApproverId, 'defaultApproverId');
  const clash = d.assignments.find(
    (a) =>
      a.archivedAt === null &&
      a.unitId === body.unitId &&
      a.obligationId === body.obligationId &&
      a.departmentId === body.departmentId,
  );
  if (clash !== undefined) {
    throw new MockError(
      'DUPLICATE',
      'This obligation is already assigned to that unit and department',
      {
        field: 'obligationId',
        existingId: clash.id,
      },
    );
  }
  const assignment: Row<'assignments'> = {
    ...fresh(ctx, d.firm.id),
    clientId,
    ...body,
    applicability: 'APPLICABLE',
    naReason: null,
  };
  d.assignments.push(assignment);
  const instances = generateInstances(ctx, assignment);
  d.instances.push(...instances);
  audit(ctx, actor, {
    action: 'CREATE',
    entityType: 'assignment',
    entityId: assignment.id,
    clientId,
    after: { obligationId: body.obligationId, unitId: body.unitId, instances: instances.length },
  });
  return assignment;
}

/** Merge sources into a target: archive the sources and keep their names as aliases. */
function mergeNamed<
  T extends {
    id: string;
    name: string;
    aliases: string[];
    version: number;
    updatedAt: string;
    archivedAt: string | null;
  },
>(
  ctx: Ctx,
  rows: T[],
  target: T,
  body: { version: number; sourceIds: string[] },
  entityType: Row<'auditEvents'>['entityType'],
  clientId: string | null,
  repoint: (sourceId: string) => void,
): T {
  checkVersion(target, body.version);
  for (const sourceId of body.sourceIds) {
    const source = rows.find(
      (r) => r.id === sourceId && r.archivedAt === null && r.id !== target.id,
    );
    if (source === undefined) throw unknownRef('sourceIds', entityType);
    target.aliases = [...new Set([...target.aliases, source.name, ...source.aliases])];
    source.archivedAt = ctx.clock.now();
    touch(source, ctx.clock);
    repoint(source.id);
  }
  touch(target, ctx.clock);
  audit(ctx, actorOf(ctx), {
    action: 'MERGE_ALIAS',
    entityType,
    entityId: target.id,
    clientId,
    after: { mergedIds: body.sourceIds },
  });
  return target;
}

const FIRM_ROLE_ADMIN: Role[] = ['FIRM_ADMIN'];

export const entityHandlers: PartialHandlers<
  | 'listClients'
  | 'createClient'
  | 'getClient'
  | 'updateClient'
  | 'archiveClient'
  | 'restoreClient'
  | 'getClientSettings'
  | 'putClientSettings'
  | 'listCompanies'
  | 'createCompany'
  | 'updateCompany'
  | 'archiveCompany'
  | 'listUnits'
  | 'createUnit'
  | 'updateUnit'
  | 'archiveUnit'
  | 'listLocations'
  | 'createLocation'
  | 'listDepartments'
  | 'createDepartment'
  | 'updateDepartment'
  | 'mergeDepartments'
  | 'listFirmPeople'
  | 'listClientPeople'
  | 'createClientPerson'
  | 'updatePerson'
  | 'mergePeople'
  | 'listMemberships'
  | 'createMembership'
  | 'updateMembership'
  | 'archiveMembership'
  | 'listActs'
  | 'createAct'
  | 'updateAct'
  | 'mergeActs'
  | 'listCategories'
  | 'createCategory'
  | 'updateCategory'
  | 'mergeCategories'
  | 'listObligations'
  | 'createObligation'
  | 'getObligation'
  | 'updateObligation'
  | 'archiveObligation'
  | 'previewRule'
  | 'pushObligation'
  | 'listAssignments'
  | 'createAssignment'
  | 'bulkCreateAssignments'
  | 'updateAssignment'
  | 'setAssignmentApplicability'
  | 'archiveAssignment'
> = {
  // ---------- clients ----------

  listClients(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: null });
    const ids = visibleClientIds(actor);
    const rows = byName(
      actor.firm.data.clients.filter((c) => ids.includes(c.id) && matches(ctx.query.q, c.name)),
    );
    return paginate(rows, ctx.query);
  },

  createClient(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: null });
    noDuplicateName(actor.firm.data.clients, ctx.body.name);
    const client = {
      ...fresh(ctx, actor.firm.data.firm.id),
      name: ctx.body.name,
      settings: ctx.body.settings ?? DEFAULT_CLIENT_SETTINGS,
    };
    actor.firm.data.clients.push(client);
    audit(ctx, actor, {
      action: 'CREATE',
      entityType: 'client',
      entityId: client.id,
      clientId: client.id,
      after: { name: client.name },
    });
    return client;
  },

  getClient(ctx) {
    ctx.authorize({ clientId: ctx.params.clientId! });
    return find(actorOf(ctx), 'clients', ctx.params.clientId);
  },

  updateClient(ctx) {
    const client = find(actorOf(ctx), 'clients', ctx.params.clientId);
    ctx.authorize({ clientId: client.id });
    noDuplicateName(actorOf(ctx).firm.data.clients, ctx.body.name, client.id);
    return patch(ctx, client, ctx.body, 'client', client.id);
  },

  archiveClient(ctx) {
    const client = find(actorOf(ctx), 'clients', ctx.params.clientId);
    ctx.authorize({ clientId: client.id });
    return archive(ctx, client, ctx.body, 'client', client.id);
  },

  restoreClient(ctx) {
    const actor = actorOf(ctx);
    const client = actor.firm.data.clients.find(
      (c) => c.id === ctx.params.clientId && c.archivedAt !== null,
    );
    if (client === undefined || !hasRole(actor, null, FIRM_ROLE_ADMIN)) throw notFound();
    checkVersion(client, ctx.body.version);
    client.archivedAt = null;
    touch(client, ctx.clock);
    ctx.authorize({ clientId: client.id });
    audit(ctx, actor, {
      action: 'RESTORE',
      entityType: 'client',
      entityId: client.id,
      clientId: client.id,
    });
    return client;
  },

  getClientSettings(ctx) {
    const client = find(actorOf(ctx), 'clients', ctx.params.clientId);
    ctx.authorize({ clientId: client.id });
    return { clientId: client.id, version: client.version, settings: client.settings };
  },

  putClientSettings(ctx) {
    const actor = actorOf(ctx);
    const client = find(actor, 'clients', ctx.params.clientId);
    ctx.authorize({ clientId: client.id });
    if (
      ctx.body.settings !== undefined &&
      !hasRole(actor, client.id, ['FIRM_ADMIN', 'CONSULTANT'])
    ) {
      throw new MockError('FORBIDDEN', 'A client admin may change only reminders', {
        action: 'client.settings',
      });
    }
    checkVersion(client, ctx.body.version);
    const before = client.settings;
    client.settings = ctx.body.settings ?? { ...client.settings, reminders: ctx.body.reminders! };
    touch(client, ctx.clock);
    audit(ctx, actor, {
      action: 'UPDATE',
      entityType: 'client',
      entityId: client.id,
      clientId: client.id,
      before: { settings: before },
      after: { settings: client.settings },
    });
    return { clientId: client.id, version: client.version, settings: client.settings };
  },

  // ---------- companies, units, locations ----------

  listCompanies(ctx) {
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const rows = live(actorOf(ctx).firm.data.companies).filter(
      (c) => c.clientId === clientId && matches(ctx.query.q, c.name),
    );
    return paginate(byName(rows), ctx.query);
  },

  createCompany(ctx) {
    const actor = actorOf(ctx);
    const clientId = find(actor, 'clients', ctx.params.clientId).id;
    ctx.authorize({ clientId });
    noDuplicateName(
      actor.firm.data.companies.filter((c) => c.clientId === clientId),
      ctx.body.name,
    );
    const company = { ...fresh(ctx, actor.firm.data.firm.id), clientId, name: ctx.body.name };
    actor.firm.data.companies.push(company);
    audit(ctx, actor, {
      action: 'CREATE',
      entityType: 'company',
      entityId: company.id,
      clientId,
      after: { name: company.name },
    });
    return company;
  },

  updateCompany(ctx) {
    const actor = actorOf(ctx);
    const company = find(actor, 'companies', ctx.params.id);
    ctx.authorize({ clientId: company.clientId });
    noDuplicateName(
      actor.firm.data.companies.filter((c) => c.clientId === company.clientId),
      ctx.body.name,
      company.id,
    );
    return patch(ctx, company, ctx.body, 'company', company.clientId);
  },

  archiveCompany(ctx) {
    const company = find(actorOf(ctx), 'companies', ctx.params.id);
    ctx.authorize({ clientId: company.clientId });
    return archive(ctx, company, ctx.body, 'company', company.clientId);
  },

  listUnits(ctx) {
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const rows = live(actorOf(ctx).firm.data.units).filter(
      (u) =>
        u.clientId === clientId &&
        (ctx.query.companyId === undefined || u.companyId === ctx.query.companyId) &&
        matches(ctx.query.q, u.name),
    );
    return paginate(byName(rows), ctx.query);
  },

  createUnit(ctx) {
    const actor = actorOf(ctx);
    const clientId = find(actor, 'clients', ctx.params.clientId).id;
    ctx.authorize({ clientId });
    ref(actor, 'companies', ctx.body.companyId, 'companyId', clientId);
    ref(actor, 'locations', ctx.body.locationId, 'locationId');
    noDuplicateName(
      actor.firm.data.units.filter((u) => u.companyId === ctx.body.companyId),
      ctx.body.name,
    );
    const unit = { ...fresh(ctx, actor.firm.data.firm.id), clientId, ...ctx.body };
    actor.firm.data.units.push(unit);
    audit(ctx, actor, {
      action: 'CREATE',
      entityType: 'unit',
      entityId: unit.id,
      clientId,
      after: { name: unit.name },
    });
    return unit;
  },

  updateUnit(ctx) {
    const actor = actorOf(ctx);
    const unit = find(actor, 'units', ctx.params.id);
    ctx.authorize({ clientId: unit.clientId });
    if (ctx.body.companyId !== undefined)
      ref(actor, 'companies', ctx.body.companyId, 'companyId', unit.clientId);
    if (ctx.body.locationId !== undefined)
      ref(actor, 'locations', ctx.body.locationId, 'locationId');
    return patch(ctx, unit, ctx.body, 'unit', unit.clientId);
  },

  archiveUnit(ctx) {
    const unit = find(actorOf(ctx), 'units', ctx.params.id);
    ctx.authorize({ clientId: unit.clientId });
    return archive(ctx, unit, ctx.body, 'unit', unit.clientId);
  },

  listLocations(ctx) {
    ctx.authorize({ clientId: null });
    const q = ctx.query;
    const rows = live(actorOf(ctx).firm.data.locations).filter(
      (l) =>
        (q.countryCode === undefined || l.countryCode === q.countryCode) &&
        (q.stateCode === undefined || l.stateCode === q.stateCode) &&
        matches(q.q, l.country, l.state, l.city),
    );
    return paginate(rows, q);
  },

  createLocation(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: null });
    const { id, firmId, createdAt, updatedAt, archivedAt } = fresh(ctx, actor.firm.data.firm.id);
    const location = { id, firmId, createdAt, updatedAt, archivedAt, ...ctx.body };
    actor.firm.data.locations.push(location);
    audit(ctx, actor, {
      action: 'CREATE',
      entityType: 'location',
      entityId: location.id,
      clientId: null,
      after: ctx.body,
    });
    return location;
  },

  // ---------- departments ----------

  listDepartments(ctx) {
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const rows = live(actorOf(ctx).firm.data.departments).filter(
      (dep) => dep.clientId === clientId && matches(ctx.query.q, dep.name, ...dep.aliases),
    );
    return paginate(byName(rows), ctx.query);
  },

  createDepartment(ctx) {
    const actor = actorOf(ctx);
    const clientId = find(actor, 'clients', ctx.params.clientId).id;
    ctx.authorize({ clientId });
    noDuplicateName(
      actor.firm.data.departments.filter((dep) => dep.clientId === clientId),
      ctx.body.name,
    );
    const department = { ...fresh(ctx, actor.firm.data.firm.id), clientId, ...ctx.body };
    actor.firm.data.departments.push(department);
    audit(ctx, actor, {
      action: 'CREATE',
      entityType: 'department',
      entityId: department.id,
      clientId,
      after: { name: department.name },
    });
    return department;
  },

  updateDepartment(ctx) {
    const actor = actorOf(ctx);
    const department = find(actor, 'departments', ctx.params.id);
    ctx.authorize({ clientId: department.clientId });
    if (ctx.body.name !== undefined) {
      noDuplicateName(
        actor.firm.data.departments.filter((dep) => dep.clientId === department.clientId),
        ctx.body.name,
        department.id,
      );
    }
    return patch(ctx, department, ctx.body, 'department', department.clientId);
  },

  mergeDepartments(ctx) {
    const actor = actorOf(ctx);
    const target = find(actor, 'departments', ctx.params.id);
    ctx.authorize({ clientId: target.clientId });
    const rows = actor.firm.data.departments.filter((dep) => dep.clientId === target.clientId);
    return mergeNamed(ctx, rows, target, ctx.body, 'department', target.clientId, (sourceId) => {
      for (const a of actor.firm.data.assignments)
        if (a.departmentId === sourceId) a.departmentId = target.id;
    });
  },

  // ---------- people and memberships ----------

  listFirmPeople(ctx) {
    ctx.authorize({ clientId: null });
    const rows = live(actorOf(ctx).firm.data.people).filter((p) =>
      matches(ctx.query.q, p.displayName, p.email),
    );
    return paginate(
      [...rows].sort((a, b) => a.displayName.localeCompare(b.displayName)),
      ctx.query,
    );
  },

  listClientPeople(ctx) {
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const rows = clientPeople(actorOf(ctx).firm.data, clientId).filter((p) =>
      matches(ctx.query.q, p.displayName, p.email),
    );
    return paginate(
      [...rows].sort((a, b) => a.displayName.localeCompare(b.displayName)),
      ctx.query,
    );
  },

  createClientPerson(ctx) {
    const actor = actorOf(ctx);
    const clientId = find(actor, 'clients', ctx.params.clientId).id;
    ctx.authorize({ clientId });
    const email = ctx.body.email;
    const clash =
      email === null
        ? undefined
        : actor.firm.data.people.find((p) => p.email?.toLowerCase() === email.toLowerCase());
    if (clash !== undefined)
      throw new MockError('DUPLICATE', 'Someone already has this email', {
        field: 'email',
        existingId: clash.id,
      });
    const person = {
      ...fresh(ctx, actor.firm.data.firm.id),
      displayName: ctx.body.displayName,
      nameNormalized: ctx.body.displayName.toLowerCase().replace(/\s+/g, ' '),
      email,
      // With an email the person is ready to invite; POST /invites sends the link.
      status: email === null ? ('UNCLAIMED' as const) : ('INVITED' as const),
    };
    actor.firm.data.people.push(person);
    audit(ctx, actor, {
      action: 'CREATE',
      entityType: 'person',
      entityId: person.id,
      clientId,
      after: { displayName: person.displayName },
    });
    return person;
  },

  updatePerson(ctx) {
    const actor = actorOf(ctx);
    const person = find(actor, 'people', ctx.params.id);
    ctx.authorize({ clientId: personScope(actor, person.id) });
    const { email, ...rest } = ctx.body;
    if (email !== undefined && person.status === 'UNCLAIMED' && email !== null) {
      throw new MockError('VALIDATION', 'Invite an unclaimed person to give them an email', {
        issues: [{ path: ['email'], message: 'Use POST /invites' }],
      });
    }
    const updated = patch(
      ctx,
      person,
      { ...rest, ...(email === undefined ? {} : { email }) },
      'person',
      null,
    );
    if (rest.displayName !== undefined)
      updated.nameNormalized = rest.displayName.toLowerCase().replace(/\s+/g, ' ');
    return updated;
  },

  mergePeople(ctx) {
    const actor = actorOf(ctx);
    const target = find(actor, 'people', ctx.params.id);
    ctx.authorize({ clientId: personScope(actor, target.id) });
    checkVersion(target, ctx.body.version);
    const d = actor.firm.data;
    for (const sourceId of ctx.body.sourceIds) {
      const source = d.people.find(
        (p) => p.id === sourceId && p.archivedAt === null && p.id !== target.id,
      );
      if (source === undefined) throw unknownRef('sourceIds', 'person');
      for (const i of d.instances) {
        if (i.ownerId === sourceId) i.ownerId = target.id;
        if (i.approverId === sourceId) i.approverId = target.id;
      }
      for (const a of d.assignments) {
        if (a.defaultOwnerId === sourceId) a.defaultOwnerId = target.id;
        if (a.defaultApproverId === sourceId) a.defaultApproverId = target.id;
      }
      for (const m of d.memberships)
        if (m.personId === sourceId && m.archivedAt === null) m.archivedAt = ctx.clock.now();
      source.archivedAt = ctx.clock.now();
      touch(source, ctx.clock);
    }
    touch(target, ctx.clock);
    audit(ctx, actor, {
      action: 'MERGE_ALIAS',
      entityType: 'person',
      entityId: target.id,
      clientId: null,
      after: { mergedIds: ctx.body.sourceIds },
    });
    return target;
  },

  listMemberships(ctx) {
    const actor = actorOf(ctx);
    const person = find(actor, 'people', ctx.params.id);
    ctx.authorize({ clientId: personScope(actor, person.id) });
    const visible = new Set(visibleClientIds(actor));
    const firmLevel = hasRole(actor, null, ['FIRM_ADMIN', 'CONSULTANT']);
    return {
      items: live(actor.firm.data.memberships).filter(
        (m) =>
          m.personId === person.id && (m.clientId === null ? firmLevel : visible.has(m.clientId)),
      ),
    };
  },

  createMembership(ctx) {
    const actor = actorOf(ctx);
    const person = find(actor, 'people', ctx.params.id);
    ctx.authorize({ clientId: ctx.body.clientId });
    if (isFirmRole(ctx.body.role) && !hasRole(actor, null, FIRM_ROLE_ADMIN)) {
      throw new MockError('FORBIDDEN', 'Only a firm admin grants firm roles', {
        action: 'membership.create',
      });
    }
    if (ctx.body.clientId !== null) ref(actor, 'clients', ctx.body.clientId, 'clientId');
    const membership = { ...fresh(ctx, actor.firm.data.firm.id), personId: person.id, ...ctx.body };
    actor.firm.data.memberships.push(membership);
    audit(ctx, actor, {
      action: 'MEMBERSHIP_CHANGE',
      entityType: 'membership',
      entityId: membership.id,
      clientId: membership.clientId,
      after: { role: membership.role },
    });
    return membership;
  },

  updateMembership(ctx) {
    const actor = actorOf(ctx);
    const membership = find(actor, 'memberships', ctx.params.id);
    ctx.authorize({ clientId: membership.clientId });
    if (isFirmRole(membership.role) && !hasRole(actor, null, FIRM_ROLE_ADMIN)) {
      throw new MockError('FORBIDDEN', 'Only a firm admin changes firm roles', {
        action: 'membership.update',
      });
    }
    const updated = patch(ctx, membership, ctx.body, 'membership', membership.clientId);
    return updated;
  },

  archiveMembership(ctx) {
    const actor = actorOf(ctx);
    const membership = find(actor, 'memberships', ctx.params.id);
    ctx.authorize({ clientId: membership.clientId });
    if (isFirmRole(membership.role) && !hasRole(actor, null, FIRM_ROLE_ADMIN)) {
      throw new MockError('FORBIDDEN', 'Only a firm admin removes firm roles', {
        action: 'membership.archive',
      });
    }
    return archive(ctx, membership, ctx.body, 'membership', membership.clientId);
  },

  // ---------- library ----------

  listActs(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: null });
    let rows = live(actor.firm.data.acts).filter((a) =>
      matches(ctx.query.q, a.name, a.shortName, ...a.aliases),
    );
    if (libraryIsFiltered(actor)) {
      const used = usedObligationIds(actor);
      const actIds = new Set(
        actor.firm.data.obligations.filter((o) => used.has(o.id)).map((o) => o.actId),
      );
      rows = rows.filter((a) => actIds.has(a.id));
    }
    return paginate(byName(rows), ctx.query);
  },

  createAct(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: null });
    noDuplicateName(actor.firm.data.acts, ctx.body.name);
    const act = { ...fresh(ctx, actor.firm.data.firm.id), ...ctx.body };
    actor.firm.data.acts.push(act);
    audit(ctx, actor, {
      action: 'CREATE',
      entityType: 'act',
      entityId: act.id,
      clientId: null,
      after: { name: act.name },
    });
    return act;
  },

  updateAct(ctx) {
    const actor = actorOf(ctx);
    const act = find(actor, 'acts', ctx.params.id);
    ctx.authorize({ clientId: null });
    const merged = {
      ...act,
      ...Object.fromEntries(Object.entries(ctx.body).filter(([, v]) => v !== undefined)),
    };
    if ((merged.jurisdiction === 'STATE') !== (merged.stateCode !== null)) {
      throw new MockError(
        'VALIDATION',
        'A STATE jurisdiction needs a stateCode; CENTRAL has none',
        { issues: [{ path: ['stateCode'], message: 'Does not match jurisdiction' }] },
      );
    }
    return patch(ctx, act, ctx.body, 'act', null);
  },

  mergeActs(ctx) {
    const actor = actorOf(ctx);
    const target = find(actor, 'acts', ctx.params.id);
    ctx.authorize({ clientId: null });
    return mergeNamed(ctx, actor.firm.data.acts, target, ctx.body, 'act', null, (sourceId) => {
      for (const o of actor.firm.data.obligations) if (o.actId === sourceId) o.actId = target.id;
    });
  },

  listCategories(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: null });
    let rows = live(actor.firm.data.categories).filter((c) =>
      matches(ctx.query.q, c.name, ...c.aliases),
    );
    if (libraryIsFiltered(actor)) {
      const used = usedObligationIds(actor);
      const ids = new Set(
        actor.firm.data.obligations.filter((o) => used.has(o.id)).map((o) => o.categoryId),
      );
      rows = rows.filter((c) => ids.has(c.id));
    }
    return paginate(byName(rows), ctx.query);
  },

  createCategory(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: null });
    noDuplicateName(actor.firm.data.categories, ctx.body.name);
    const category = { ...fresh(ctx, actor.firm.data.firm.id), ...ctx.body };
    actor.firm.data.categories.push(category);
    audit(ctx, actor, {
      action: 'CREATE',
      entityType: 'category',
      entityId: category.id,
      clientId: null,
      after: { name: category.name },
    });
    return category;
  },

  updateCategory(ctx) {
    const actor = actorOf(ctx);
    const category = find(actor, 'categories', ctx.params.id);
    ctx.authorize({ clientId: null });
    if (ctx.body.name !== undefined)
      noDuplicateName(actor.firm.data.categories, ctx.body.name, category.id);
    return patch(ctx, category, ctx.body, 'category', null);
  },

  mergeCategories(ctx) {
    const actor = actorOf(ctx);
    const target = find(actor, 'categories', ctx.params.id);
    ctx.authorize({ clientId: null });
    return mergeNamed(
      ctx,
      actor.firm.data.categories,
      target,
      ctx.body,
      'category',
      null,
      (sourceId) => {
        for (const o of actor.firm.data.obligations)
          if (o.categoryId === sourceId) o.categoryId = target.id;
      },
    );
  },

  listObligations(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: null });
    const q = ctx.query;
    const used = libraryIsFiltered(actor) ? usedObligationIds(actor) : null;
    const inList = <T>(list: T[] | undefined, value: T) =>
      list === undefined || list.includes(value);
    const rows = live(actor.firm.data.obligations).filter(
      (o) =>
        (used === null || used.has(o.id)) &&
        inList(q.actId, o.actId) &&
        inList(q.categoryId, o.categoryId) &&
        inList(q.domain, o.domain) &&
        inList(q.criticality, o.criticality) &&
        (q.jurisdiction === undefined || o.jurisdiction === q.jurisdiction) &&
        (q.stateCode === undefined || o.stateCode === q.stateCode) &&
        (q.ruleStatus === undefined || o.ruleStatus === q.ruleStatus) &&
        matches(q.q, o.title, o.externalRef),
    );
    return paginate(
      [...rows].sort((a, b) => (a.externalRef ?? a.title).localeCompare(b.externalRef ?? b.title)),
      q,
    );
  },

  createObligation(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: null });
    ref(actor, 'acts', ctx.body.actId, 'actId');
    ref(actor, 'categories', ctx.body.categoryId, 'categoryId');
    const obligation = { ...fresh(ctx, actor.firm.data.firm.id), ...ctx.body, libraryVersion: 1 };
    actor.firm.data.obligations.push(obligation);
    audit(ctx, actor, {
      action: 'CREATE',
      entityType: 'obligation',
      entityId: obligation.id,
      clientId: null,
      after: { title: obligation.title },
    });
    return obligation;
  },

  getObligation(ctx) {
    const actor = actorOf(ctx);
    const obligation = find(actor, 'obligations', ctx.params.id);
    ctx.authorize({ clientId: null });
    if (libraryIsFiltered(actor) && !usedObligationIds(actor).has(obligation.id)) throw notFound();
    return obligation;
  },

  updateObligation(ctx) {
    const actor = actorOf(ctx);
    const obligation = find(actor, 'obligations', ctx.params.id);
    ctx.authorize({ clientId: null });
    if (ctx.body.actId !== undefined) ref(actor, 'acts', ctx.body.actId, 'actId');
    if (ctx.body.categoryId !== undefined)
      ref(actor, 'categories', ctx.body.categoryId, 'categoryId');
    const merged = {
      ...obligation,
      ...Object.fromEntries(Object.entries(ctx.body).filter(([, v]) => v !== undefined)),
    };
    if ((merged.jurisdiction === 'STATE') !== (merged.stateCode !== null)) {
      throw new MockError(
        'VALIDATION',
        'A STATE jurisdiction needs a stateCode; CENTRAL has none',
        { issues: [{ path: ['stateCode'], message: 'Does not match jurisdiction' }] },
      );
    }
    const updated = patch(ctx, obligation, ctx.body, 'obligation', null);
    updated.libraryVersion += 1;
    return updated;
  },

  archiveObligation(ctx) {
    const obligation = find(actorOf(ctx), 'obligations', ctx.params.id);
    ctx.authorize({ clientId: null });
    return archive(ctx, obligation, ctx.body, 'obligation', null);
  },

  previewRule(ctx) {
    ctx.authorize({ clientId: null });
    const { rule, from, to, fyStartMonth } = ctx.body;
    return { items: previewPeriods(rule, from, to, fyStartMonth) };
  },

  pushObligation(ctx) {
    const actor = actorOf(ctx);
    const obligation = find(actor, 'obligations', ctx.params.id);
    ctx.authorize({ clientId: null });
    const visible = new Set(visibleClientIds(actor));
    for (const clientId of ctx.body.clientIds)
      if (!visible.has(clientId)) throw unknownRef('clientIds', 'client');
    const assignments = live(actor.firm.data.assignments).filter(
      (a) => a.obligationId === obligation.id && ctx.body.clientIds.includes(a.clientId),
    );
    const ids = new Set(assignments.map((a) => a.id));
    const today = ctx.clock.today();
    const instances = actor.firm.data.instances.filter(
      (i) =>
        ids.has(i.assignmentId) &&
        i.dueDate >= today &&
        (i.workflowState === 'OPEN' || i.workflowState === 'SENT_BACK'),
    );
    return {
      libraryVersion: obligation.libraryVersion,
      assignmentsUpdated: assignments.length,
      instancesUpdated: instances.length,
    };
  },

  // ---------- assignments ----------

  listAssignments(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const me = (r: string | undefined) => (r === 'me' ? actor.person.id : r);
    const inList = <T>(list: T[] | undefined, value: T) =>
      list === undefined || list.includes(value);
    const rows = live(actor.firm.data.assignments).filter(
      (a) =>
        a.clientId === clientId &&
        inList(q.unitId, a.unitId) &&
        inList(q.departmentId, a.departmentId) &&
        inList(q.obligationId, a.obligationId) &&
        inList(q.applicability, a.applicability) &&
        (q.ownerId === undefined || a.defaultOwnerId === me(q.ownerId)) &&
        (q.approverId === undefined || a.defaultApproverId === me(q.approverId)),
    );
    return paginate(rows, q);
  },

  createAssignment(ctx) {
    const clientId = find(actorOf(ctx), 'clients', ctx.params.clientId).id;
    ctx.authorize({ clientId });
    return createAssignment(ctx, clientId, ctx.body);
  },

  bulkCreateAssignments(ctx) {
    const clientId = find(actorOf(ctx), 'clients', ctx.params.clientId).id;
    ctx.authorize({ clientId });
    return {
      results: ctx.body.items.map((item, index) => {
        try {
          return { index, ok: true, item: createAssignment(ctx, clientId, item) };
        } catch (error) {
          if (!(error instanceof MockError)) throw error;
          return { index, ok: false, error: { code: error.code, message: error.message } };
        }
      }),
    };
  },

  updateAssignment(ctx) {
    const actor = actorOf(ctx);
    const assignment = find(actor, 'assignments', ctx.params.id);
    ctx.authorize({ clientId: assignment.clientId });
    const { applyToOpen, ...changes } = ctx.body;
    if (changes.departmentId !== undefined)
      ref(actor, 'departments', changes.departmentId, 'departmentId', assignment.clientId);
    if (changes.defaultOwnerId !== undefined)
      ref(actor, 'people', changes.defaultOwnerId, 'defaultOwnerId');
    if (changes.defaultApproverId !== undefined)
      ref(actor, 'people', changes.defaultApproverId, 'defaultApproverId');
    const updated = patch(ctx, assignment, changes, 'assignment', assignment.clientId);
    if (applyToOpen === true) {
      for (const i of actor.firm.data.instances) {
        if (
          i.assignmentId !== assignment.id ||
          (i.workflowState !== 'OPEN' && i.workflowState !== 'SENT_BACK')
        )
          continue;
        const before = { ownerId: i.ownerId, approverId: i.approverId };
        i.ownerId = assignment.defaultOwnerId;
        i.approverId = assignment.defaultApproverId;
        touch(i, ctx.clock);
        audit(ctx, actor, {
          action: 'REASSIGN',
          entityType: 'instance',
          entityId: i.id,
          clientId: i.clientId,
          before,
          after: { ownerId: i.ownerId, approverId: i.approverId },
        });
      }
    }
    return updated;
  },

  setAssignmentApplicability(ctx) {
    const actor = actorOf(ctx);
    const assignment = find(actor, 'assignments', ctx.params.id);
    ctx.authorize({ clientId: assignment.clientId });
    checkVersion(assignment, ctx.body.version);
    const before = { applicability: assignment.applicability };
    assignment.applicability = ctx.body.applicability;
    assignment.naReason = ctx.body.applicability === 'NOT_APPLICABLE' ? ctx.body.reason : null;
    touch(assignment, ctx.clock);
    audit(ctx, actor, {
      action: 'APPLICABILITY_CHANGE',
      entityType: 'assignment',
      entityId: assignment.id,
      clientId: assignment.clientId,
      before,
      after: { applicability: assignment.applicability },
      reason: ctx.body.reason,
    });
    return assignment;
  },

  archiveAssignment(ctx) {
    const assignment = find(actorOf(ctx), 'assignments', ctx.params.id);
    ctx.authorize({ clientId: assignment.clientId });
    return archive(ctx, assignment, ctx.body, 'assignment', assignment.clientId);
  },
};

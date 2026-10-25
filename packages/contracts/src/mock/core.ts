// Shared pieces of the mock API: errors, the signed-in actor and role scope, lookups, register rows, paging.
import type { z } from 'zod';
import type { ERROR_DETAILS } from '../api/error-details.js';
import type { Endpoint } from '../api/endpoints.js';
import type { RegisterQuery } from '../api/workflow.js';
import {
  type ActivitySource,
  type ActKind,
  type DerivedStatus,
  INSTANCE_EDIT_STATES,
  type InstanceAction,
  type Role,
} from '../enums.js';
import type { ErrorCode } from '../errors.js';
import type { InstanceDetail, InstanceRow } from '../schemas/work.js';
import type { ScoreResult } from '../schemas/scores.js';
import { daysBetween, deriveStatus, score, type ScoredInstance, statusIds } from './derive.js';
import {
  activeMemberships,
  type FirmState,
  type InstanceRecord,
  isClientRole,
  type MembershipRecord,
  type PersonRecord,
  type Row,
  type Session,
} from './store.js';

/** Version reported in mock ScoreResults. */
export const MOCK_ENGINE_VERSION = 'mock-1';

// ---------- errors ----------

type DetailsOf<C extends ErrorCode> = (typeof ERROR_DETAILS)[C] extends z.ZodType
  ? z.input<(typeof ERROR_DETAILS)[C]>
  : undefined;

/** Thrown by handlers; the server turns it into the error envelope with the code's HTTP status. */
export class MockError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: C, message: string, details?: DetailsOf<C>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const notFound = () => new MockError('NOT_FOUND', 'Not found');

// ---------- clock ----------

export interface Clock {
  /** Today in the client time zone (the mock uses one zone for every client). */
  today(): string;
  /** Current UTC instant, ending in "Z". */
  now(): string;
}

/** A clock pinned to `today` (mock instants fall at 12:00 IST that day), or the real clock. */
export function makeClock(today?: string): Clock {
  if (today !== undefined) {
    return { today: () => today, now: () => `${today}T06:30:00Z` };
  }
  return {
    today: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()),
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

// ---------- actor and scope ----------

export interface Actor {
  session: Session;
  firm: FirmState;
  person: PersonRecord;
  /** Live memberships. */
  memberships: MembershipRecord[];
  /** VIEWER memberships past `expiresAt`, for ACCESS_EXPIRED. */
  expired: MembershipRecord[];
  /** The account's features for this request: the firm's, or the `X-Mock-Features` header's when it is sent. */
  features: string[];
}

export function actorFor(
  firm: FirmState,
  session: Session,
  person: PersonRecord,
  now: string,
  features: string[] = firm.features,
): Actor {
  const memberships = activeMemberships(firm, person.id, now);
  const expired = firm.data.memberships.filter(
    (m) =>
      m.personId === person.id &&
      m.archivedAt === null &&
      m.expiresAt !== null &&
      m.expiresAt <= now,
  );
  return { session, firm, person, memberships, expired, features: [...features] };
}

/** Clients the actor may see: all for FIRM_ADMIN, listed ones for CONSULTANT, membership clients otherwise. */
export function visibleClientIds(actor: Actor): string[] {
  const live = actor.firm.data.clients.filter((c) => c.archivedAt === null).map((c) => c.id);
  const ids = new Set<string>();
  for (const m of actor.memberships) {
    if (m.role === 'FIRM_ADMIN') live.forEach((id) => ids.add(id));
    else if (m.role === 'CONSULTANT') m.consultantClientIds!.forEach((id) => ids.add(id));
    else ids.add(m.clientId!);
  }
  return live.filter((id) => ids.has(id));
}

/**
 * The actor's memberships that act within `clientId` (all of them when null), optionally within one unit, and
 * within at least one of `unitIds` when given (a record over several units, docs/iso/plan.md §3.3).
 */
export function membershipsFor(
  actor: Actor,
  clientId: string | null,
  unitId?: string,
  unitIds?: readonly string[],
): MembershipRecord[] {
  return actor.memberships.filter((m) => {
    if (clientId === null) return true;
    if (m.role === 'FIRM_ADMIN') return true;
    if (m.role === 'CONSULTANT') return m.consultantClientIds!.includes(clientId);
    if (m.clientId !== clientId) return false;
    if (m.unitIds === null) return true;
    if (unitIds !== undefined && !unitIds.some((id) => m.unitIds!.includes(id))) return false;
    return unitId === undefined || m.unitIds.includes(unitId);
  });
}

export const hasRole = (actor: Actor, clientId: string | null, roles: Role[], unitId?: string) =>
  membershipsFor(actor, clientId, unitId).some((m) => roles.includes(m.role));

/** What a request touches, for the role check. */
export interface Scope {
  clientId: string | null;
  unitId?: string;
  /** A record over several units: a unit-scoped membership needs one of them (`Resource.unitIds`). */
  unitIds?: readonly string[];
  ownerId?: string;
  approverId?: string;
  /** Bulk endpoints: an `own` role passes here and each item is checked on its own. */
  ownPerItem?: boolean;
}

/**
 * The endpoints.md role check: NOT_FOUND when the actor cannot see the client or unit, ACCESS_EXPIRED for an
 * expired VIEWER, FORBIDDEN when no role allows the endpoint (or an `own` role is not the instance's).
 */
export function authorize(actor: Actor, ep: Endpoint, scope: Scope): void {
  const action = ep.actions[0] ?? 'session.use';
  if (scope.clientId !== null && !visibleClientIds(actor).includes(scope.clientId)) {
    const expired = actor.expired.find((m) => m.clientId === scope.clientId);
    if (expired !== undefined) {
      throw new MockError('ACCESS_EXPIRED', 'Your access to this client has expired', {
        expiredAt: expired.expiresAt!,
      });
    }
    throw notFound();
  }
  const inScope = membershipsFor(actor, scope.clientId, scope.unitId, scope.unitIds);
  if (inScope.length === 0) throw notFound();
  const allowed = inScope.some((m) => {
    const access = ep.roles[m.role];
    if (access === undefined) return false;
    if (access !== 'own' || scope.ownPerItem === true) return true;
    if (m.role === 'OWNER') return scope.ownerId === actor.person.id;
    if (m.role === 'APPROVER') return scope.approverId === actor.person.id;
    return false;
  });
  if (!allowed) throw new MockError('FORBIDDEN', `Not allowed: ${action}`, { action });
}

// ---------- the ISO add-on's off switch and the Law/ISO source (docs/iso/plan.md §4.4-4.6) ----------

/** The ISO add-on's feature flag. */
export const ISO_FEATURE = 'isoManagement';

/** Whether the account has the ISO add-on for this request (`Actor.features`). */
export const hasIso = (actor: Actor): boolean => actor.features.includes(ISO_FEATURE);

/** 403 FEATURE_NOT_ENABLED, as the `/iso` routes answer while the add-on is off. */
export function isoNotEnabled(): MockError<'FEATURE_NOT_ENABLED'> {
  return new MockError('FEATURE_NOT_ENABLED', 'This add-on is not turned on', {
    feature: ISO_FEATURE,
  });
}

/** An act's kind; an act without one is a STATUTE (`Act.kind`). */
export const actKind = (act: { kind?: ActKind | undefined }): ActKind => act.kind ?? 'STATUTE';

/** The kind of the act an obligation belongs to. */
export function obligationKind(firm: FirmState, obligation: { actId: string }): ActKind {
  return actKind(firm.data.acts.find((a) => a.id === obligation.actId)!);
}

/** The kind of the act behind an assignment. */
export function assignmentKind(firm: FirmState, assignment: { obligationId: string }): ActKind {
  return obligationKind(
    firm,
    firm.data.obligations.find((o) => o.id === assignment.obligationId)!,
  );
}

/** The kind of the act behind an instance: STANDARD for an ISO activity. */
export function instanceKind(firm: FirmState, instance: { assignmentId: string }): ActKind {
  return assignmentKind(
    firm,
    firm.data.assignments.find((a) => a.id === instance.assignmentId)!,
  );
}

/** Ids of the firm's assignments on obligations of STANDARD acts, archived ones included. */
export function standardAssignmentIds(firm: FirmState): Set<string> {
  const acts = new Set(firm.data.acts.filter((a) => actKind(a) === 'STANDARD').map((a) => a.id));
  const obligations = new Set(
    firm.data.obligations.filter((o) => acts.has(o.actId)).map((o) => o.id),
  );
  return new Set(
    firm.data.assignments.filter((a) => obligations.has(a.obligationId)).map((a) => a.id),
  );
}

/**
 * Whether a list shows an item of a `kind` act for `source`: with the ISO add-on off only STATUTE items, whatever
 * `source` says; with it on, `LAW` = STATUTE, `ISO` = STANDARD, and both when `source` is absent (plan §4.4, §4.6).
 */
export function inSource(actor: Actor, kind: ActKind, source?: ActivitySource): boolean {
  if (!hasIso(actor)) return kind === 'STATUTE';
  return source === undefined || (source === 'ISO') === (kind === 'STANDARD');
}

/**
 * Off hides and refuses, it never deletes: a core route that names an item of a STANDARD act (the act, its
 * obligations, their assignments and instances, and the instances' comments, evidence and audit) answers 403
 * FEATURE_NOT_ENABLED while the add-on is off (plan §4.4-4.5). Call it after the role check, so an actor who cannot
 * see the item gets 404 and learns nothing of its kind.
 */
export function checkKindEnabled(actor: Actor, kind: ActKind): void {
  if (kind === 'STANDARD' && !hasIso(actor)) throw isoNotEnabled();
}

/** `?asOf=` is for FIRM_ADMIN, CONSULTANT and VIEWER only (api-conventions.md §1). */
export function asOfFor(
  actor: Actor,
  clientId: string | null,
  asOf: string | undefined,
  clock: Clock,
): string {
  if (asOf === undefined) return clock.today();
  if (!hasRole(actor, clientId, ['FIRM_ADMIN', 'CONSULTANT', 'VIEWER'])) {
    throw new MockError('FORBIDDEN', 'Only firm roles and viewers may set asOf', {
      action: 'report.asOf',
    });
  }
  return asOf;
}

// ---------- lookups ----------

const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** Indexes over one firm's data, built per request. */
export class Lookup {
  readonly clients;
  readonly companies;
  readonly units;
  readonly locations;
  readonly departments;
  readonly people;
  readonly acts;
  readonly categories;
  readonly obligations;
  readonly assignments;
  readonly instances;
  readonly evidenceByInstance;
  readonly commentsByInstance;

  constructor(readonly firm: FirmState) {
    const d = firm.data;
    this.clients = byId(d.clients);
    this.companies = byId(d.companies);
    this.units = byId(d.units);
    this.locations = byId(d.locations);
    this.departments = byId(d.departments);
    this.people = byId(d.people);
    this.acts = byId(d.acts);
    this.categories = byId(d.categories);
    this.obligations = byId(d.obligations);
    this.assignments = byId(d.assignments);
    this.instances = byId(d.instances);
    this.evidenceByInstance = groupBy(
      d.evidence.filter((e) => e.archivedAt === null),
      (e) => e.instanceId,
    );
    this.commentsByInstance = groupBy(d.comments, (c) => c.instanceId);
  }

  obligationOf(instance: InstanceRecord): Row<'obligations'> {
    return this.obligations.get(this.assignments.get(instance.assignmentId)!.obligationId)!;
  }

  /** The kind of an act by id. */
  actKindOf(actId: string): ActKind {
    return actKind(this.acts.get(actId)!);
  }

  scored(instance: InstanceRecord): ScoredInstance {
    return {
      id: instance.id,
      dueDate: instance.dueDate,
      workflowState: instance.workflowState,
      completedOn: instance.completedOn,
      criticality: this.obligationOf(instance).criticality,
    };
  }
}

// ---------- register rows ----------

type RowOut = z.input<typeof InstanceRow>;
type DetailOut = z.input<typeof InstanceDetail>;

export function statusOf(firm: FirmState, instance: InstanceRecord, asOf: string): DerivedStatus {
  return deriveStatus(instance, asOf, firm.data.firm.settings.dueSoonDays);
}

export function instanceRow(look: Lookup, instance: InstanceRecord, asOf: string): RowOut {
  const assignment = look.assignments.get(instance.assignmentId)!;
  const obligation = look.obligations.get(assignment.obligationId)!;
  const unit = look.units.get(instance.unitId)!;
  const location = look.locations.get(unit.locationId)!;
  const status = statusOf(look.firm, instance, asOf);
  const comments = look.commentsByInstance.get(instance.id) ?? [];
  const latest = comments.reduce<(typeof comments)[number] | null>(
    (last, c) => (last === null || c.createdAt >= last.createdAt ? c : last),
    null,
  );
  return {
    id: instance.id,
    version: instance.version,
    obligationId: obligation.id,
    externalRef: obligation.externalRef,
    title: obligation.title,
    timelineType: obligation.timelineType,
    categoryName: look.categories.get(obligation.categoryId)!.name,
    actId: obligation.actId,
    actName: look.acts.get(obligation.actId)!.name,
    criticality: obligation.criticality,
    clientId: instance.clientId,
    companyName: look.companies.get(unit.companyId)!.name,
    unitId: unit.id,
    unitName: unit.name,
    locationLabel: [location.country, location.state, location.city]
      .filter((part) => part !== null)
      .join(' / '),
    departmentId: assignment.departmentId,
    departmentName: look.departments.get(assignment.departmentId)!.name,
    ownerId: instance.ownerId,
    ownerName: look.people.get(instance.ownerId)!.displayName,
    approverId: instance.approverId,
    approverName: look.people.get(instance.approverId)!.displayName,
    periodStart: instance.periodStart,
    periodEnd: instance.periodEnd,
    dueDate: instance.dueDate,
    completedOn: instance.completedOn,
    workflowState: instance.workflowState,
    pendingKind: instance.pendingKind,
    status,
    overdueDays: status === 'OVERDUE' ? daysBetween(instance.dueDate, asOf) : null,
    evidenceCount: (look.evidenceByInstance.get(instance.id) ?? []).length,
    commentCount: comments.length,
    lastComment: latest?.body ?? null,
    formLabels: obligation.forms.map((f) => f.label),
    logSheetLabels: obligation.logSheets.map((f) => f.label),
  };
}

const OPEN_STATES = ['OPEN', 'SENT_BACK'];

/** The actions the actor may take on an instance now (state machine plus endpoints.md roles). */
export function allowedActions(actor: Actor, instance: InstanceRecord): InstanceAction[] {
  const scope = (roles: Role[]) => hasRole(actor, instance.clientId, roles, instance.unitId);
  const isOwner = instance.ownerId === actor.person.id && scope(['OWNER']);
  const isApprover = instance.approverId === actor.person.id && scope(['APPROVER']);
  const manager = scope(['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN']);
  const open = OPEN_STATES.includes(instance.workflowState);
  const closed =
    instance.workflowState === 'APPROVED' || instance.workflowState === 'NOT_APPLICABLE';
  const actions: InstanceAction[] = [];
  if (open && isOwner) actions.push('SUBMIT', 'REQUEST_NA');
  if (instance.workflowState === 'SUBMITTED' && (scope(['CLIENT_ADMIN']) || isApprover)) {
    actions.push('APPROVE', 'SEND_BACK');
  }
  if (closed && manager) actions.push('REOPEN');
  const editable = (INSTANCE_EDIT_STATES as readonly string[]).includes(instance.workflowState);
  if (editable && manager) actions.push('REASSIGN', 'CHANGE_DUE_DATE');
  if (manager || isOwner || isApprover) actions.push('COMMENT');
  if (editable && (manager || isOwner || isApprover)) actions.push('UPLOAD_EVIDENCE');
  return actions;
}

export function instanceDetail(
  look: Lookup,
  actor: Actor,
  instance: InstanceRecord,
  asOf: string,
): DetailOut {
  const obligation = look.obligationOf(instance);
  return {
    ...instanceRow(look, instance, asOf),
    description: obligation.description,
    applicabilityText: obligation.applicabilityText,
    naReason: instance.naReason,
    forms: obligation.forms,
    logSheets: obligation.logSheets,
    evidenceRequired: obligation.evidenceRequired,
    allowedActions: allowedActions(actor, instance),
  };
}

/**
 * Instances the actor may see in a client: every unit for client-wide roles, scoped units for OW and AP. ISO
 * activities (instances under STANDARD acts) only while the account has the ISO add-on, and then as `source` asks:
 * `LAW` for STATUTE acts, `ISO` for STANDARD acts, both when absent (`inSource`, plan §4.4-4.6).
 */
export function visibleInstances(
  actor: Actor,
  clientId: string,
  source?: ActivitySource,
): InstanceRecord[] {
  const memberships = membershipsFor(actor, clientId);
  const allUnits = memberships.some((m) => m.unitIds === null);
  const units = new Set(memberships.flatMap((m) => m.unitIds ?? []));
  const standard = standardAssignmentIds(actor.firm);
  return actor.firm.data.instances.filter(
    (i) =>
      i.clientId === clientId &&
      i.archivedAt === null &&
      (allUnits || units.has(i.unitId)) &&
      inSource(actor, standard.has(i.assignmentId) ? 'STANDARD' : 'STATUTE', source),
  );
}

export function scoreResult(
  look: Lookup,
  instances: InstanceRecord[],
  asOf: string,
): z.input<typeof ScoreResult> {
  const scored = instances.map((i) => look.scored(i));
  const settings = look.firm.data.firm.settings;
  const result = score(scored, asOf, settings);
  return {
    engineVersion: MOCK_ENGINE_VERSION,
    asOf,
    score: result.score,
    onTimeRate: result.onTimeRate,
    counts: result.counts,
    instanceIds: statusIds(scored, asOf, settings.dueSoonDays),
  };
}

// ---------- register filters and sorting ----------

const CRITICALITY_RANK = { SUPER_CRITICAL: 5, CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

/** FY label "2022-23" to its first and last day for a client whose FY starts in `startMonth`. */
export function fyRange(fy: string, startMonth: number): { from: string; to: string } {
  const year = Number(fy.slice(0, 4));
  const from = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? year : year + 1;
  const last = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return { from, to: `${endYear}-${String(endMonth).padStart(2, '0')}-${last}` };
}

type RegisterFilters = Omit<RegisterQuery, 'limit' | 'cursor' | 'count' | 'sort' | 'asOf'>;

/** Applies register filters (api-conventions.md §3), `source` included (`inSource`), to rows. */
export function filterRows(
  rows: RowOut[],
  filters: Partial<RegisterFilters>,
  actor: Actor,
  look: Lookup,
  fyStartMonth: number,
): RowOut[] {
  const me = (ref: string | undefined) => (ref === 'me' ? actor.person.id : ref);
  const ownerId = me(filters.ownerId);
  const approverId = me(filters.approverId);
  const range = filters.fy === undefined ? null : fyRange(filters.fy, fyStartMonth);
  const q = filters.q?.toLowerCase();
  const inList = <T>(list: T[] | undefined, value: T) => list === undefined || list.includes(value);
  return rows.filter((row) => {
    const obligation = look.obligations.get(row.obligationId)!;
    return (
      inSource(actor, look.actKindOf(row.actId), filters.source) &&
      inList(filters.unitId, row.unitId) &&
      inList(filters.departmentId, row.departmentId) &&
      inList(filters.actId, row.actId) &&
      inList(filters.categoryId, obligation.categoryId) &&
      (ownerId === undefined || row.ownerId === ownerId) &&
      (approverId === undefined || row.approverId === approverId) &&
      inList(filters.criticality, row.criticality) &&
      inList(filters.status, row.status) &&
      inList(filters.workflowState, row.workflowState) &&
      (filters.timelineType === undefined || row.timelineType === filters.timelineType) &&
      inList(filters.domain, obligation.domain) &&
      (filters.dueFrom === undefined || row.dueDate >= filters.dueFrom) &&
      (filters.dueTo === undefined || row.dueDate <= filters.dueTo) &&
      (range === null || (row.dueDate >= range.from && row.dueDate <= range.to)) &&
      (filters.completedFrom === undefined ||
        (row.completedOn !== null && row.completedOn >= filters.completedFrom)) &&
      (filters.completedTo === undefined ||
        (row.completedOn !== null && row.completedOn <= filters.completedTo)) &&
      (filters.hasEvidence === undefined || row.evidenceCount > 0 === filters.hasEvidence) &&
      (q === undefined ||
        [row.title, row.externalRef ?? '', row.actName, row.lastComment ?? '']
          .join('\n')
          .toLowerCase()
          .includes(q))
    );
  });
}

type SortKey = { field: string; direction: 'asc' | 'desc' };

export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  keys: SortKey[],
  updatedAt?: (row: T) => string,
): T[] {
  const value = (row: T, field: string): string | number => {
    if (field === 'criticality')
      return CRITICALITY_RANK[row.criticality as keyof typeof CRITICALITY_RANK];
    if (field === 'updatedAt' && updatedAt) return updatedAt(row);
    const v = row[field];
    return typeof v === 'number' ? v : String(v ?? '');
  };
  return [...rows].sort((a, b) => {
    for (const { field, direction } of keys) {
      const x = value(a, field);
      const y = value(b, field);
      if (x !== y) return (x < y ? -1 : 1) * (direction === 'asc' ? 1 : -1);
    }
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

// ---------- paging ----------

/** Cursor pagination over an already filtered and sorted list. The cursor is an opaque offset. */
export function paginate<T>(
  items: T[],
  query: { limit: number; cursor?: string; count?: boolean },
): { items: T[]; nextCursor: string | null; total?: number } {
  let offset = 0;
  if (query.cursor !== undefined) {
    offset = Number(Buffer.from(query.cursor, 'base64url').toString('utf8').replace(/^o:/, ''));
    if (!Number.isInteger(offset) || offset < 0) {
      throw new MockError('VALIDATION', 'Invalid cursor', {
        issues: [{ path: ['cursor'], message: 'Invalid cursor' }],
      });
    }
  }
  const end = offset + query.limit;
  return {
    items: items.slice(offset, end),
    nextCursor: end < items.length ? Buffer.from(`o:${end}`).toString('base64url') : null,
    ...(query.count === true ? { total: items.length } : {}),
  };
}

/** Case-insensitive `?q=` over the given fields. */
export function matches(q: string | undefined, ...values: (string | null | undefined)[]): boolean {
  if (q === undefined) return true;
  const needle = q.toLowerCase();
  return values.some((v) => v?.toLowerCase().includes(needle));
}

export const live = <T extends { archivedAt: string | null }>(rows: T[]) =>
  rows.filter((r) => r.archivedAt === null);

/** Client roles see library rows only through assignments in their clients (endpoints.md §3). */
export function libraryIsFiltered(actor: Actor): boolean {
  return !actor.memberships.some((m) => !isClientRole(m.role));
}

// ---------- writes ----------

/** Appends an audit event; the mock writes one wherever the real API must (root CLAUDE.md rule 2). */
export function audit(
  ctx: { store: { newId(): string }; clock: Clock; requestId: string },
  actor: Actor,
  event: {
    action: Row<'auditEvents'>['action'];
    entityType: Row<'auditEvents'>['entityType'];
    entityId: string;
    clientId: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    reason?: string | null;
  },
): void {
  actor.firm.data.auditEvents.push({
    id: ctx.store.newId(),
    firmId: actor.firm.data.firm.id,
    clientId: event.clientId,
    at: ctx.clock.now(),
    requestId: ctx.requestId,
    actorId: actor.person.id,
    actorKind: 'PERSON',
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    before: event.before ?? null,
    after: event.after ?? null,
    reason: event.reason ?? null,
  });
}

/** 409 STALE_VERSION unless the client sent the current version. */
export function checkVersion(row: { version: number }, version: number): void {
  if (row.version !== version) {
    throw new MockError('STALE_VERSION', 'This record changed since you loaded it', {
      currentVersion: row.version,
    });
  }
}

/** Bumps version and updatedAt after a write. */
export function touch(row: { version?: number; updatedAt: string }, clock: Clock): void {
  if (row.version !== undefined) row.version += 1;
  row.updatedAt = clock.now();
}

/** Fields every new entity starts with. */
export function fresh(ctx: { store: { newId(): string }; clock: Clock }, firmId: string) {
  const now = ctx.clock.now();
  return {
    id: ctx.store.newId(),
    firmId,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
  };
}

/** Only the fields that differ, for audit `before`/`after`. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const keys = Object.keys(after).filter(
    (k) =>
      k !== 'version' &&
      k !== 'updatedAt' &&
      JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  return {
    before: Object.fromEntries(keys.map((k) => [k, before[k]])),
    after: Object.fromEntries(keys.map((k) => [k, after[k]])),
  };
}

/** Host of the mock's presigned URLs. Nothing listens there: the mock never stores file bytes. */
export const MOCK_FILE_HOST = 'https://files.mock.invalid';

export function fileUrl(path: string): string {
  return `${MOCK_FILE_HOST}/${path}`;
}

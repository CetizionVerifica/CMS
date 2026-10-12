import { z } from 'zod';
import { type Role } from '../enums.js';
import { Id } from '../primitives.js';
import { DryRunReport, ImportBatch, ImportRow, MappingTemplate } from '../schemas/import.js';
import { Act, Category, GeneratedPeriod, Obligation } from '../schemas/library.js';
import { Breakdown, ExportJob, PortfolioRow, ScoreResult } from '../schemas/scores.js';
import {
  Client,
  Company,
  Department,
  Location,
  Membership,
  Person,
  Unit,
} from '../schemas/tenancy.js';
import {
  Assignment,
  AuditEvent,
  Comment,
  EvidenceView,
  InstanceDetail,
  InstanceRow,
} from '../schemas/work.js';
import * as auth from './auth.js';
import {
  ArchiveBody,
  bulkCreateResults,
  bulkResults,
  list,
  MergeBody,
  NoContent,
  page,
  RestoreBody,
  SignedUrl,
  UploadTicket,
} from './common.js';
import * as dash from './dashboards.js';
import * as ent from './entities.js';
import * as imp from './imports.js';
import * as work from './workflow.js';

/**
 * Every v1 endpoint with its schemas and role permissions (docs/contracts/endpoints.md).
 * The OpenAPI spec and the mock server are generated from this table; providers implement it exactly.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';
export type ProviderModule = 'M5' | 'M6' | 'M7' | 'M8' | 'M10';

/**
 * How a role may call an endpoint: `all` within its scope (endpoints.md §1), `own` only on instances where it is the
 * owner (OWNER) or approver (APPROVER), `limited` with the restriction in `notes`. A missing role is 403 FORBIDDEN.
 */
export type Access = 'all' | 'own' | 'limited';

export interface Endpoint {
  module: ProviderModule;
  method: HttpMethod;
  /** OpenAPI-style template under /api/v1, e.g. `/instances/{id}/submit`. */
  path: string;
  summary: string;
  /** `public`: no session. `session`: any signed-in person. `action`: `can()` with `actions`. */
  auth: 'public' | 'session' | 'action';
  /** `can()` action names; the first is checked, a second applies to part of the body (see summary). */
  actions: readonly string[];
  roles: Partial<Record<Role, Access>>;
  params: z.ZodObject | null;
  query: z.ZodType | null;
  body: z.ZodType | null;
  status: 200 | 201 | 202 | 204;
  response: z.ZodType;
  /** Honours the `Idempotency-Key` header for 24 hours (api-conventions.md §2). */
  idempotent: boolean;
  notes?: string;
}

const ROLE_CODES = {
  FA: 'FIRM_ADMIN',
  CO: 'CONSULTANT',
  CA: 'CLIENT_ADMIN',
  AP: 'APPROVER',
  OW: 'OWNER',
  VI: 'VIEWER',
} as const satisfies Record<string, Role>;

/** `'FA CO CA AP:own'` → `{ FIRM_ADMIN: 'all', ..., APPROVER: 'own' }`, mirroring the endpoints.md tables. */
function roles(spec: string): Partial<Record<Role, Access>> {
  const result: Partial<Record<Role, Access>> = {};
  for (const token of spec.split(' ')) {
    const [code, access = 'all'] = token.split(':') as [keyof typeof ROLE_CODES, Access?];
    result[ROLE_CODES[code]] = access;
  }
  return result;
}

const EVERYONE = 'FA CO CA AP OW VI';
const ENTITY_READERS = EVERYONE;
const ENTITY_WRITERS = 'FA CO CA';
const LIBRARY_WRITERS = 'FA CO';
const IMPORTERS = 'FA CO';

/** Path params from the template: every `{name}` is an Id unless `overrides` says otherwise. */
function paramsFor(path: string, overrides: Record<string, z.ZodType> = {}): z.ZodObject | null {
  const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
  if (names.length === 0) return null;
  return z.strictObject(Object.fromEntries(names.map((name) => [name, overrides[name] ?? Id])));
}

interface EndpointInput {
  module: ProviderModule;
  method: HttpMethod;
  path: string;
  summary: string;
  action?: string | readonly string[];
  /** Defaults to `action` when an action is given. */
  auth?: 'public' | 'session';
  roles?: string;
  paramOverrides?: Record<string, z.ZodType>;
  query?: z.ZodType;
  body?: z.ZodType;
  status?: 200 | 201 | 202 | 204;
  response: z.ZodType;
  idempotent?: boolean;
  notes?: string;
}

/** An endpoint that keeps its schema types, so clients and the mock server get typed bodies and responses. */
export type TypedEndpoint<I extends EndpointInput> = Endpoint & {
  query: I['query'] extends z.ZodType ? I['query'] : null;
  body: I['body'] extends z.ZodType ? I['body'] : null;
  response: I['response'];
};

function endpoint<const I extends EndpointInput>(input: I): TypedEndpoint<I> {
  const actions = input.action === undefined ? [] : [input.action].flat();
  return {
    module: input.module,
    method: input.method,
    path: input.path,
    summary: input.summary,
    auth: actions.length > 0 ? 'action' : (input.auth ?? 'session'),
    actions,
    roles: input.roles === undefined ? {} : roles(input.roles),
    params: paramsFor(input.path, input.paramOverrides),
    query: input.query ?? null,
    body: input.body ?? null,
    status: input.status ?? 200,
    response: input.response,
    idempotent: input.idempotent ?? false,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  } as unknown as TypedEndpoint<I>;
}

const M5 = 'M5';
const M6 = 'M6';
const M7 = 'M7';
const M8 = 'M8';
const M10 = 'M10';

const token = { token: auth.InviteTokenParams.shape.token };

/** Lists and pages reused by several endpoints, so the spec names them once. */
export const InstanceRowPage = page(InstanceRow);
export const AuditEventPage = page(AuditEvent);
export const ClientPage = page(Client);
export const PersonPage = page(Person);
export const CategoryPage = page(Category);

export const ENDPOINTS = {
  // ---------- M5 · auth ----------
  login: endpoint({
    module: M5,
    method: 'POST',
    path: '/auth/login',
    summary: 'Sign in with email and password; sets the session cookie. Rate limited.',
    auth: 'public',
    body: auth.LoginBody,
    response: auth.Me,
  }),
  requestMagicLink: endpoint({
    module: M5,
    method: 'POST',
    path: '/auth/magic-link',
    summary: 'Email a sign-in link. Always 202, so it never reveals whether an account exists.',
    auth: 'public',
    body: auth.MagicLinkBody,
    status: 202,
    response: NoContent,
  }),
  verifyMagicLink: endpoint({
    module: M5,
    method: 'POST',
    path: '/auth/magic-link/verify',
    summary: 'Exchange a magic-link token for a session.',
    auth: 'public',
    body: auth.MagicLinkVerifyBody,
    response: auth.Me,
  }),
  logout: endpoint({
    module: M5,
    method: 'POST',
    path: '/auth/logout',
    summary: 'End the session.',
    roles: EVERYONE,
    status: 204,
    response: NoContent,
  }),
  enrollMfa: endpoint({
    module: M5,
    method: 'POST',
    path: '/auth/mfa/enroll',
    summary: 'Start TOTP enrolment. Required for FIRM_ADMIN and CONSULTANT.',
    roles: EVERYONE,
    response: auth.MfaEnrollment,
  }),
  verifyMfa: endpoint({
    module: M5,
    method: 'POST',
    path: '/auth/mfa/verify',
    summary: 'Check a TOTP code; completes enrolment or satisfies MFA for this session.',
    roles: EVERYONE,
    body: auth.MfaVerifyBody,
    response: auth.Me,
  }),
  getMe: endpoint({
    module: M5,
    method: 'GET',
    path: '/me',
    summary: 'The signed-in person, memberships, visible clients, CSRF token and MFA state.',
    roles: EVERYONE,
    response: auth.Me,
  }),
  createInvite: endpoint({
    module: M5,
    method: 'POST',
    path: '/invites',
    summary: 'Invite a person to a membership.',
    action: 'person.invite',
    roles: 'FA CO:limited CA:limited',
    notes:
      'CONSULTANT and CLIENT_ADMIN invite only client roles in their clients; only FIRM_ADMIN invites firm roles.',
    body: auth.InviteBody,
    status: 201,
    response: auth.Invite,
  }),
  getInvite: endpoint({
    module: M5,
    method: 'GET',
    path: '/invites/{token}',
    summary: 'What the accept page shows for an invite link.',
    auth: 'public',
    paramOverrides: token,
    response: auth.InvitePreview,
  }),
  acceptInvite: endpoint({
    module: M5,
    method: 'POST',
    path: '/invites/{token}/accept',
    summary: 'Claim the invited person: set the password and start a session.',
    auth: 'public',
    paramOverrides: token,
    body: auth.InviteAcceptBody,
    response: auth.Me,
  }),
  revokeInvite: endpoint({
    module: M5,
    method: 'POST',
    path: '/invites/{id}/revoke',
    summary: 'Revoke a pending invite.',
    action: 'person.invite',
    roles: 'FA CO CA',
    response: auth.Invite,
  }),

  // ---------- M6 · clients ----------
  listClients: endpoint({
    module: M6,
    method: 'GET',
    path: '/clients',
    summary: 'Clients the signed-in person may see.',
    action: 'client.read',
    roles: EVERYONE,
    query: ent.ClientListQuery,
    response: ClientPage,
  }),
  createClient: endpoint({
    module: M6,
    method: 'POST',
    path: '/clients',
    summary: 'Create a client.',
    action: 'client.create',
    roles: 'FA',
    body: ent.ClientCreateBody,
    status: 201,
    response: Client,
  }),
  getClient: endpoint({
    module: M6,
    method: 'GET',
    path: '/clients/{clientId}',
    summary: 'One client.',
    action: 'client.read',
    roles: EVERYONE,
    response: Client,
  }),
  updateClient: endpoint({
    module: M6,
    method: 'PATCH',
    path: '/clients/{clientId}',
    summary: 'Rename a client.',
    action: 'client.update',
    roles: 'FA CO',
    body: ent.ClientUpdateBody,
    response: Client,
  }),
  archiveClient: endpoint({
    module: M6,
    method: 'POST',
    path: '/clients/{clientId}/archive',
    summary: 'Archive a client.',
    action: 'client.archive',
    roles: 'FA',
    body: ArchiveBody,
    response: Client,
  }),
  restoreClient: endpoint({
    module: M6,
    method: 'POST',
    path: '/clients/{clientId}/restore',
    summary: 'Restore an archived client.',
    action: 'client.archive',
    roles: 'FA',
    body: RestoreBody,
    response: Client,
  }),
  getClientSettings: endpoint({
    module: M6,
    method: 'GET',
    path: '/clients/{clientId}/settings',
    summary: 'FY start, time zone, holiday policy and reminders.',
    action: 'client.settings',
    roles: 'FA CO CA',
    response: ent.ClientSettingsView,
  }),
  putClientSettings: endpoint({
    module: M6,
    method: 'PUT',
    path: '/clients/{clientId}/settings',
    summary: 'Replace the client settings.',
    action: 'client.settings',
    roles: 'FA CO CA:limited',
    notes: 'CLIENT_ADMIN may send only `reminders`.',
    body: ent.ClientSettingsBody,
    response: ent.ClientSettingsView,
  }),

  // ---------- M6 · companies, units, locations, departments ----------
  listCompanies: endpoint({
    module: M6,
    method: 'GET',
    path: '/clients/{clientId}/companies',
    summary: 'Companies of a client.',
    action: 'entity.read',
    roles: ENTITY_READERS,
    query: ent.EntityListQuery,
    response: page(Company),
  }),
  createCompany: endpoint({
    module: M6,
    method: 'POST',
    path: '/clients/{clientId}/companies',
    summary: 'Add a company.',
    action: 'entity.write',
    roles: ENTITY_WRITERS,
    body: ent.CompanyCreateBody,
    status: 201,
    response: Company,
  }),
  updateCompany: endpoint({
    module: M6,
    method: 'PATCH',
    path: '/companies/{id}',
    summary: 'Rename a company.',
    action: 'entity.write',
    roles: ENTITY_WRITERS,
    body: ent.CompanyUpdateBody,
    response: Company,
  }),
  archiveCompany: endpoint({
    module: M6,
    method: 'POST',
    path: '/companies/{id}/archive',
    summary: 'Archive a company.',
    action: 'entity.write',
    roles: ENTITY_WRITERS,
    body: ArchiveBody,
    response: Company,
  }),
  listUnits: endpoint({
    module: M6,
    method: 'GET',
    path: '/clients/{clientId}/units',
    summary: 'Units (plants, sites, offices) of a client.',
    action: 'entity.read',
    roles: ENTITY_READERS,
    query: ent.UnitListQuery,
    response: page(Unit),
  }),
  createUnit: endpoint({
    module: M6,
    method: 'POST',
    path: '/clients/{clientId}/units',
    summary: 'Add a unit.',
    action: 'entity.write',
    roles: ENTITY_WRITERS,
    body: ent.UnitCreateBody,
    status: 201,
    response: Unit,
  }),
  updateUnit: endpoint({
    module: M6,
    method: 'PATCH',
    path: '/units/{id}',
    summary: 'Change a unit.',
    action: 'entity.write',
    roles: ENTITY_WRITERS,
    body: ent.UnitUpdateBody,
    response: Unit,
  }),
  archiveUnit: endpoint({
    module: M6,
    method: 'POST',
    path: '/units/{id}/archive',
    summary: 'Archive a unit.',
    action: 'entity.write',
    roles: ENTITY_WRITERS,
    body: ArchiveBody,
    response: Unit,
  }),
  listLocations: endpoint({
    module: M6,
    method: 'GET',
    path: '/locations',
    summary: 'Locations (country, state, city) of the firm.',
    action: 'location.read',
    roles: EVERYONE,
    query: ent.LocationListQuery,
    response: page(Location),
  }),
  createLocation: endpoint({
    module: M6,
    method: 'POST',
    path: '/locations',
    summary: 'Add a location.',
    action: 'location.write',
    roles: 'FA CO CA',
    body: ent.LocationCreateBody,
    status: 201,
    response: Location,
  }),
  listDepartments: endpoint({
    module: M6,
    method: 'GET',
    path: '/clients/{clientId}/departments',
    summary: 'Departments of a client.',
    action: 'department.read',
    roles: ENTITY_READERS,
    query: ent.EntityListQuery,
    response: page(Department),
  }),
  createDepartment: endpoint({
    module: M6,
    method: 'POST',
    path: '/clients/{clientId}/departments',
    summary: 'Add a department.',
    action: 'department.write',
    roles: ENTITY_WRITERS,
    body: ent.DepartmentCreateBody,
    status: 201,
    response: Department,
  }),
  updateDepartment: endpoint({
    module: M6,
    method: 'PATCH',
    path: '/departments/{id}',
    summary: 'Rename a department or change its aliases.',
    action: 'department.write',
    roles: ENTITY_WRITERS,
    body: ent.DepartmentUpdateBody,
    response: Department,
  }),
  mergeDepartments: endpoint({
    module: M6,
    method: 'POST',
    path: '/departments/{id}/merge',
    summary: 'Merge other departments into this one; their names become aliases.',
    action: 'department.merge',
    roles: ENTITY_WRITERS,
    body: MergeBody,
    response: Department,
  }),

  // ---------- M6 · people and memberships ----------
  listFirmPeople: endpoint({
    module: M6,
    method: 'GET',
    path: '/people',
    summary: 'Firm staff.',
    action: 'person.read',
    roles: 'FA CO',
    query: ent.PersonListQuery,
    response: PersonPage,
  }),
  listClientPeople: endpoint({
    module: M6,
    method: 'GET',
    path: '/clients/{clientId}/people',
    summary: 'People with a membership in a client.',
    action: 'person.read',
    roles: ENTITY_READERS,
    query: ent.PersonListQuery,
    response: PersonPage,
  }),
  createClientPerson: endpoint({
    module: M6,
    method: 'POST',
    path: '/clients/{clientId}/people',
    summary: 'Add a person to a client.',
    action: 'person.write',
    roles: ENTITY_WRITERS,
    body: ent.PersonCreateBody,
    status: 201,
    response: Person,
  }),
  updatePerson: endpoint({
    module: M6,
    method: 'PATCH',
    path: '/people/{id}',
    summary: 'Change a name or email.',
    action: 'person.write',
    roles: ENTITY_WRITERS,
    body: ent.PersonUpdateBody,
    response: Person,
  }),
  mergePeople: endpoint({
    module: M6,
    method: 'POST',
    path: '/people/{id}/merge',
    summary: 'Merge duplicate people into this one; their assignments and instances move here.',
    action: 'person.merge',
    roles: ENTITY_WRITERS,
    body: MergeBody,
    response: Person,
  }),
  listMemberships: endpoint({
    module: M6,
    method: 'GET',
    path: '/people/{id}/memberships',
    summary: "A person's memberships.",
    action: 'membership.write',
    roles: ENTITY_WRITERS,
    response: list(Membership),
  }),
  createMembership: endpoint({
    module: M6,
    method: 'POST',
    path: '/people/{id}/memberships',
    summary: 'Grant a membership.',
    action: 'membership.write',
    roles: 'FA CO:limited CA:limited',
    notes:
      'CLIENT_ADMIN (and CONSULTANT) grant only client roles in their clients; firm roles are FIRM_ADMIN only.',
    body: auth.MembershipGrant,
    status: 201,
    response: Membership,
  }),
  updateMembership: endpoint({
    module: M6,
    method: 'PATCH',
    path: '/memberships/{id}',
    summary: "Change a membership's scope or expiry.",
    action: 'membership.write',
    roles: 'FA CO:limited CA:limited',
    notes: 'Same limits as createMembership.',
    body: ent.MembershipUpdateBody,
    response: Membership,
  }),
  archiveMembership: endpoint({
    module: M6,
    method: 'POST',
    path: '/memberships/{id}/archive',
    summary: 'End a membership.',
    action: 'membership.write',
    roles: 'FA CO:limited CA:limited',
    notes: 'Same limits as createMembership.',
    body: ArchiveBody,
    response: Membership,
  }),

  // ---------- M6 · library ----------
  listActs: endpoint({
    module: M6,
    method: 'GET',
    path: '/library/acts',
    summary: 'Acts in the firm library.',
    action: 'library.read',
    roles: EVERYONE,
    notes: 'Client roles see only Acts with an assignment in their client.',
    query: ent.LibraryListQuery,
    response: page(Act),
  }),
  createAct: endpoint({
    module: M6,
    method: 'POST',
    path: '/library/acts',
    summary: 'Add an Act.',
    action: 'library.write',
    roles: LIBRARY_WRITERS,
    body: ent.ActCreateBody,
    status: 201,
    response: Act,
  }),
  updateAct: endpoint({
    module: M6,
    method: 'PATCH',
    path: '/library/acts/{id}',
    summary: 'Change an Act.',
    action: 'library.write',
    roles: LIBRARY_WRITERS,
    body: ent.ActUpdateBody,
    response: Act,
  }),
  mergeActs: endpoint({
    module: M6,
    method: 'POST',
    path: '/library/acts/{id}/merge',
    summary: 'Merge other Acts into this one; their names become aliases.',
    action: 'library.write',
    roles: LIBRARY_WRITERS,
    body: MergeBody,
    response: Act,
  }),
  listCategories: endpoint({
    module: M6,
    method: 'GET',
    path: '/library/categories',
    summary: 'Categories in the firm library.',
    action: 'library.read',
    roles: EVERYONE,
    query: ent.LibraryListQuery,
    response: CategoryPage,
  }),
  createCategory: endpoint({
    module: M6,
    method: 'POST',
    path: '/library/categories',
    summary: 'Add a category.',
    action: 'library.write',
    roles: LIBRARY_WRITERS,
    body: ent.CategoryCreateBody,
    status: 201,
    response: Category,
  }),
  updateCategory: endpoint({
    module: M6,
    method: 'PATCH',
    path: '/library/categories/{id}',
    summary: 'Change a category.',
    action: 'library.write',
    roles: LIBRARY_WRITERS,
    body: ent.CategoryUpdateBody,
    response: Category,
  }),
  mergeCategories: endpoint({
    module: M6,
    method: 'POST',
    path: '/library/categories/{id}/merge',
    summary: 'Merge other categories into this one.',
    action: 'library.write',
    roles: LIBRARY_WRITERS,
    body: MergeBody,
    response: Category,
  }),
  listObligations: endpoint({
    module: M6,
    method: 'GET',
    path: '/library/obligations',
    summary: 'Obligations in the firm library.',
    action: 'library.read',
    roles: EVERYONE,
    notes: 'Client roles see only obligations with an assignment in their client.',
    query: ent.ObligationListQuery,
    response: page(Obligation),
  }),
  createObligation: endpoint({
    module: M6,
    method: 'POST',
    path: '/library/obligations',
    summary: 'Add an obligation.',
    action: 'library.write',
    roles: LIBRARY_WRITERS,
    body: ent.ObligationCreateBody,
    status: 201,
    response: Obligation,
  }),
  getObligation: endpoint({
    module: M6,
    method: 'GET',
    path: '/library/obligations/{id}',
    summary: 'One obligation.',
    action: 'library.read',
    roles: EVERYONE,
    response: Obligation,
  }),
  updateObligation: endpoint({
    module: M6,
    method: 'PATCH',
    path: '/library/obligations/{id}',
    summary: 'Change an obligation; bumps libraryVersion.',
    action: 'library.write',
    roles: LIBRARY_WRITERS,
    body: ent.ObligationUpdateBody,
    response: Obligation,
  }),
  archiveObligation: endpoint({
    module: M6,
    method: 'POST',
    path: '/library/obligations/{id}/archive',
    summary: 'Archive an obligation.',
    action: 'library.write',
    roles: LIBRARY_WRITERS,
    body: ArchiveBody,
    response: Obligation,
  }),
  previewRule: endpoint({
    module: M6,
    method: 'POST',
    path: '/library/rules/preview',
    summary: 'Periods and due dates a recurrence rule generates (engine generateInstances).',
    action: 'library.read',
    roles: 'FA CO CA',
    body: ent.RulePreviewBody,
    response: list(GeneratedPeriod),
  }),
  pushObligation: endpoint({
    module: M6,
    method: 'POST',
    path: '/library/obligations/{id}/push',
    summary: "Apply the obligation's current libraryVersion to future instances in these clients.",
    action: 'library.push',
    roles: LIBRARY_WRITERS,
    body: ent.ObligationPushBody,
    response: ent.ObligationPushResult,
  }),

  // ---------- M6 · assignments ----------
  listAssignments: endpoint({
    module: M6,
    method: 'GET',
    path: '/clients/{clientId}/assignments',
    summary: 'Assignments of a client.',
    action: 'assignment.read',
    roles: EVERYONE,
    query: ent.AssignmentListQuery,
    response: page(Assignment),
  }),
  createAssignment: endpoint({
    module: M6,
    method: 'POST',
    path: '/clients/{clientId}/assignments',
    summary: 'Apply an obligation to a unit.',
    action: 'assignment.write',
    roles: ENTITY_WRITERS,
    body: ent.AssignmentCreateBody,
    status: 201,
    response: Assignment,
  }),
  bulkCreateAssignments: endpoint({
    module: M6,
    method: 'POST',
    path: '/clients/{clientId}/assignments/bulk',
    summary: 'Create up to 200 assignments; per-item results.',
    action: 'assignment.write',
    roles: ENTITY_WRITERS,
    body: ent.AssignmentBulkBody,
    response: bulkCreateResults(Assignment),
  }),
  updateAssignment: endpoint({
    module: M6,
    method: 'PATCH',
    path: '/assignments/{id}',
    summary: 'Change department, default owner or approver, or end date.',
    action: 'assignment.write',
    roles: ENTITY_WRITERS,
    body: ent.AssignmentUpdateBody,
    response: Assignment,
  }),
  setAssignmentApplicability: endpoint({
    module: M6,
    method: 'POST',
    path: '/assignments/{id}/applicability',
    summary:
      'Mark applicable, not applicable or to assess. NOT_APPLICABLE stops future generation.',
    action: 'assignment.applicability',
    roles: ENTITY_WRITERS,
    body: ent.AssignmentApplicabilityBody,
    response: Assignment,
  }),
  archiveAssignment: endpoint({
    module: M6,
    method: 'POST',
    path: '/assignments/{id}/archive',
    summary: 'Archive an assignment.',
    action: 'assignment.write',
    roles: ENTITY_WRITERS,
    body: ArchiveBody,
    response: Assignment,
  }),

  // ---------- M7 · instances ----------
  listInstances: endpoint({
    module: M7,
    method: 'GET',
    path: '/clients/{clientId}/instances',
    summary: 'The register. APPROVER and OWNER see only their units.',
    action: 'instance.read',
    roles: EVERYONE,
    query: work.RegisterQuery,
    response: InstanceRowPage,
  }),
  getInstance: endpoint({
    module: M7,
    method: 'GET',
    path: '/instances/{id}',
    summary: 'One instance with the actions the signed-in person may take.',
    action: 'instance.read',
    roles: EVERYONE,
    query: work.InstanceReadQuery,
    response: InstanceDetail,
  }),
  submitInstance: endpoint({
    module: M7,
    method: 'POST',
    path: '/instances/{id}/submit',
    summary: 'Owner submits the instance as done.',
    action: 'instance.submit',
    roles: 'OW:own',
    body: work.SubmitBody,
    response: InstanceDetail,
    idempotent: true,
  }),
  requestNa: endpoint({
    module: M7,
    method: 'POST',
    path: '/instances/{id}/request-na',
    summary: 'Owner asks for the instance to be marked not applicable.',
    action: 'instance.submit',
    roles: 'OW:own',
    body: work.RequestNaBody,
    response: InstanceDetail,
    idempotent: true,
  }),
  approveInstance: endpoint({
    module: M7,
    method: 'POST',
    path: '/instances/{id}/approve',
    summary:
      'Approve a submission. A CLIENT_ADMIN approves as a delegate (audited delegated: true).',
    action: 'instance.approve',
    roles: 'CA AP:own',
    body: work.ApproveBody,
    response: InstanceDetail,
    idempotent: true,
  }),
  sendBackInstance: endpoint({
    module: M7,
    method: 'POST',
    path: '/instances/{id}/send-back',
    summary: 'Return a submission to the owner with a reason.',
    action: 'instance.approve',
    roles: 'CA AP:own',
    body: work.SendBackBody,
    response: InstanceDetail,
    idempotent: true,
  }),
  reopenInstance: endpoint({
    module: M7,
    method: 'POST',
    path: '/instances/{id}/reopen',
    summary: 'Reopen an approved or not-applicable instance.',
    action: 'instance.reopen',
    roles: 'FA CO CA',
    body: work.ReopenBody,
    response: InstanceDetail,
    idempotent: true,
  }),
  bulkApprove: endpoint({
    module: M7,
    method: 'POST',
    path: '/clients/{clientId}/instances/bulk-approve',
    summary: 'Approve up to 200 submissions; per-item results.',
    action: 'instance.approve',
    roles: 'CA AP:own',
    body: work.BulkApproveBody,
    response: bulkResults(InstanceRow),
    idempotent: true,
  }),
  updateInstance: endpoint({
    module: M7,
    method: 'PATCH',
    path: '/instances/{id}',
    summary:
      'Reassign owner or approver (instance.reassign) or move the due date (instance.due_date).',
    action: ['instance.reassign', 'instance.dueDate'],
    roles: 'FA CO CA',
    body: work.InstanceUpdateBody,
    response: InstanceDetail,
  }),
  myApprovals: endpoint({
    module: M7,
    method: 'GET',
    path: '/me/approvals',
    summary: 'SUBMITTED instances the signed-in person approves (CLIENT_ADMIN: all in the client).',
    action: 'instance.read',
    roles: 'CA AP',
    query: work.MyQueueQuery,
    response: InstanceRowPage,
  }),
  myTasks: endpoint({
    module: M7,
    method: 'GET',
    path: '/me/tasks',
    summary: 'OPEN and SENT_BACK instances the signed-in person owns, by due date.',
    action: 'instance.read',
    roles: 'AP OW',
    query: work.MyQueueQuery,
    response: InstanceRowPage,
  }),
  listComments: endpoint({
    module: M7,
    method: 'GET',
    path: '/instances/{id}/comments',
    summary: 'Comments on an instance, oldest first.',
    action: 'comment.read',
    roles: 'FA CO CA AP:own OW:own VI',
    query: work.CommentListQuery,
    response: page(Comment),
  }),
  createComment: endpoint({
    module: M7,
    method: 'POST',
    path: '/instances/{id}/comments',
    summary: 'Comment on an instance.',
    action: 'comment.write',
    roles: 'FA CO CA AP:own OW:own',
    body: work.CommentCreateBody,
    status: 201,
    response: Comment,
  }),

  // ---------- M7 · evidence ----------
  evidenceUploadUrl: endpoint({
    module: M7,
    method: 'POST',
    path: '/instances/{id}/evidence/upload-url',
    summary:
      'Presigned PUT for one evidence file (5 minutes). Only while OPEN, SENT_BACK or SUBMITTED.',
    action: 'evidence.write',
    roles: 'FA CO CA AP:own OW:own',
    body: work.EvidenceUploadUrlBody,
    response: UploadTicket,
  }),
  confirmEvidence: endpoint({
    module: M7,
    method: 'POST',
    path: '/instances/{id}/evidence',
    summary: 'Confirm an uploaded file. It stays PENDING until scanned.',
    action: 'evidence.write',
    roles: 'FA CO CA AP:own OW:own',
    body: work.EvidenceConfirmBody,
    status: 201,
    response: EvidenceView,
  }),
  listInstanceEvidence: endpoint({
    module: M7,
    method: 'GET',
    path: '/instances/{id}/evidence',
    summary: 'Evidence metadata for one instance.',
    action: 'evidence.read',
    roles: EVERYONE,
    response: list(EvidenceView),
  }),
  evidenceVault: endpoint({
    module: M7,
    method: 'GET',
    path: '/clients/{clientId}/evidence',
    summary: 'Evidence vault. APPROVER and OWNER see only their units.',
    action: 'evidence.read',
    roles: EVERYONE,
    query: work.EvidenceVaultQuery,
    response: page(EvidenceView),
  }),
  evidenceDownloadUrl: endpoint({
    module: M7,
    method: 'GET',
    path: '/evidence/{id}/download-url',
    summary:
      'Presigned GET valid 5 minutes; writes an EVIDENCE_DOWNLOAD audit event. CLEAN evidence only.',
    action: 'evidence.download',
    roles: EVERYONE,
    response: SignedUrl,
  }),
  removeEvidence: endpoint({
    module: M7,
    method: 'POST',
    path: '/evidence/{id}/remove',
    summary: 'Remove evidence from its instance (archives it; never deletes).',
    action: 'evidence.remove',
    roles: 'FA CO CA OW:own',
    notes: 'OWNER only before approval.',
    body: work.EvidenceRemoveBody,
    response: EvidenceView,
  }),

  // ---------- M7 · audit ----------
  clientAudit: endpoint({
    module: M7,
    method: 'GET',
    path: '/clients/{clientId}/audit',
    summary: 'Audit trail of a client, newest first.',
    action: 'audit.read',
    roles: 'FA CO CA VI',
    query: work.AuditQuery,
    response: AuditEventPage,
  }),
  instanceAudit: endpoint({
    module: M7,
    method: 'GET',
    path: '/instances/{id}/audit',
    summary: 'History of one instance, newest first.',
    action: 'audit.read',
    roles: EVERYONE,
    query: work.InstanceAuditQuery,
    response: AuditEventPage,
  }),

  // ---------- M8 · imports ----------
  createImport: endpoint({
    module: M8,
    method: 'POST',
    path: '/clients/{clientId}/imports',
    summary: 'Start an import: returns the batch id and a presigned PUT for the workbook.',
    action: 'import.create',
    roles: IMPORTERS,
    body: imp.ImportCreateBody,
    status: 201,
    response: imp.ImportUploadTicket,
  }),
  importUploaded: endpoint({
    module: M8,
    method: 'POST',
    path: '/imports/{id}/uploaded',
    summary:
      'Confirm the upload (status UPLOADED); returns sheets, headers and a suggested mapping.',
    action: 'import.write',
    roles: IMPORTERS,
    body: imp.ImportUploadedBody,
    response: imp.ImportUploaded,
  }),
  putImportMapping: endpoint({
    module: M8,
    method: 'PUT',
    path: '/imports/{id}/mapping',
    summary: 'Choose the sheet and column mapping (status MAPPED).',
    action: 'import.write',
    roles: IMPORTERS,
    body: imp.ImportMappingBody,
    response: ImportBatch,
  }),
  parseImport: endpoint({
    module: M8,
    method: 'POST',
    path: '/imports/{id}/parse',
    summary: 'Parse and clean the rows in the background; poll getImport until PARSED.',
    action: 'import.write',
    roles: IMPORTERS,
    status: 202,
    response: ImportBatch,
  }),
  getImport: endpoint({
    module: M8,
    method: 'GET',
    path: '/imports/{id}',
    summary: 'The batch with its status and counts.',
    action: 'import.read',
    roles: IMPORTERS,
    response: ImportBatch,
  }),
  listImportIssues: endpoint({
    module: M8,
    method: 'GET',
    path: '/imports/{id}/issues',
    summary: 'Cleaning issues grouped by groupKey.',
    action: 'import.read',
    roles: IMPORTERS,
    query: imp.ImportIssueQuery,
    response: list(imp.ImportIssueGroup),
  }),
  decideImportIssue: endpoint({
    module: M8,
    method: 'PATCH',
    path: '/imports/{id}/issues/{groupKey}',
    summary: 'Decide a group of issues; the batch is REVIEWED when none are PENDING.',
    action: 'import.write',
    roles: IMPORTERS,
    paramOverrides: { groupKey: imp.ImportIssueGroupParams.shape.groupKey },
    body: imp.ImportIssueDecisionBody,
    response: imp.ImportIssueGroup,
  }),
  listImportRows: endpoint({
    module: M8,
    method: 'GET',
    path: '/imports/{id}/rows',
    summary: 'Raw and mapped rows, for the preview grid.',
    action: 'import.read',
    roles: IMPORTERS,
    query: imp.ImportRowQuery,
    response: page(ImportRow),
  }),
  dryRunImport: endpoint({
    module: M8,
    method: 'POST',
    path: '/imports/{id}/dry-run',
    summary: 'What the commit would create, update and skip (status DRY_RUN_READY).',
    action: 'import.write',
    roles: IMPORTERS,
    response: DryRunReport,
  }),
  commitImport: endpoint({
    module: M8,
    method: 'POST',
    path: '/imports/{id}/commit',
    summary:
      'Apply the import (COMMITTING, then COMMITTED). 422 IMPORT_BLOCKED while issues block it.',
    action: 'import.commit',
    roles: IMPORTERS,
    status: 202,
    response: ImportBatch,
    idempotent: true,
  }),
  cancelImport: endpoint({
    module: M8,
    method: 'POST',
    path: '/imports/{id}/cancel',
    summary: 'Cancel an import before COMMITTING.',
    action: 'import.write',
    roles: IMPORTERS,
    response: ImportBatch,
  }),
  listImports: endpoint({
    module: M8,
    method: 'GET',
    path: '/clients/{clientId}/imports',
    summary: 'Import history of a client, newest first.',
    action: 'import.read',
    roles: IMPORTERS,
    query: imp.ImportListQuery,
    response: page(ImportBatch),
  }),
  listMappingTemplates: endpoint({
    module: M8,
    method: 'GET',
    path: '/clients/{clientId}/mapping-templates',
    summary: "The client's and the firm-wide mapping templates.",
    action: 'import.read',
    roles: IMPORTERS,
    query: imp.MappingTemplateListQuery,
    response: page(MappingTemplate),
  }),
  createMappingTemplate: endpoint({
    module: M8,
    method: 'POST',
    path: '/clients/{clientId}/mapping-templates',
    summary: 'Save a mapping template.',
    action: 'import.write',
    roles: IMPORTERS,
    body: imp.MappingTemplateCreateBody,
    status: 201,
    response: MappingTemplate,
  }),
  updateMappingTemplate: endpoint({
    module: M8,
    method: 'PATCH',
    path: '/mapping-templates/{id}',
    summary: 'Rename or change a mapping template.',
    action: 'import.write',
    roles: IMPORTERS,
    body: imp.MappingTemplateUpdateBody,
    response: MappingTemplate,
  }),

  // ---------- M10 · dashboards and reports ----------
  portfolio: endpoint({
    module: M10,
    method: 'GET',
    path: '/portfolio',
    summary: 'One score row per client the signed-in consultant sees.',
    action: 'dashboard.portfolio',
    roles: 'FA CO',
    query: dash.DashboardQuery,
    response: list(PortfolioRow),
  }),
  clientOverview: endpoint({
    module: M10,
    method: 'GET',
    path: '/clients/{clientId}/overview',
    summary:
      'Score, upcoming items and my tasks. APPROVER and OWNER numbers cover their units only.',
    action: 'dashboard.read',
    roles: EVERYONE,
    query: dash.DashboardQuery,
    response: dash.ClientOverview,
  }),
  breakdown: endpoint({
    module: M10,
    method: 'GET',
    path: '/clients/{clientId}/breakdowns',
    summary: 'Scores by department, Act, criticality, unit or owner.',
    action: 'dashboard.read',
    roles: EVERYONE,
    query: dash.BreakdownQuery,
    response: Breakdown,
  }),
  calendar: endpoint({
    module: M10,
    method: 'GET',
    path: '/clients/{clientId}/calendar',
    summary: 'Instances by due date for a date range.',
    action: 'instance.read',
    roles: EVERYONE,
    query: dash.CalendarQuery,
    response: list(dash.CalendarDay),
  }),
  actReport: endpoint({
    module: M10,
    method: 'GET',
    path: '/clients/{clientId}/reports/act-wise',
    summary: 'Scores by Act.',
    action: 'report.read',
    roles: 'FA CO CA AP VI',
    query: dash.DashboardQuery,
    response: Breakdown,
  }),
  departmentReport: endpoint({
    module: M10,
    method: 'GET',
    path: '/clients/{clientId}/reports/department-wise',
    summary: 'Scores by department.',
    action: 'report.read',
    roles: 'FA CO CA AP VI',
    query: dash.DashboardQuery,
    response: Breakdown,
  }),
  overdueReport: endpoint({
    module: M10,
    method: 'GET',
    path: '/clients/{clientId}/reports/overdue',
    summary: 'Overdue instances, most overdue first, with the score they drag down.',
    action: 'report.read',
    roles: 'FA CO CA AP VI',
    query: dash.DashboardQuery,
    response: z.strictObject({ result: ScoreResult, items: z.array(InstanceRow) }),
  }),
  createExport: endpoint({
    module: M10,
    method: 'POST',
    path: '/clients/{clientId}/exports',
    summary: 'Start an Excel or PDF export.',
    action: 'export.create',
    roles: 'FA CO CA AP VI',
    body: dash.ExportCreateBody,
    status: 202,
    response: ExportJob,
    idempotent: true,
  }),
  getExport: endpoint({
    module: M10,
    method: 'GET',
    path: '/exports/{id}',
    summary: 'Export status.',
    action: 'export.read',
    roles: 'FA CO CA AP VI',
    response: ExportJob,
  }),
  exportDownloadUrl: endpoint({
    module: M10,
    method: 'GET',
    path: '/exports/{id}/download-url',
    summary: 'Presigned GET for a finished export, valid 5 minutes.',
    action: 'export.read',
    roles: 'FA CO CA AP VI',
    response: SignedUrl,
  }),
} satisfies Record<string, Endpoint>;

export type EndpointId = keyof typeof ENDPOINTS;

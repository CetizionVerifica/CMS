import {
  DEFAULT_CLIENT_SETTINGS,
  type ComplianceInstance,
  type Id,
  type LocalDate,
  type Membership,
  type RequestContext,
  type Role,
} from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { accountView, createTestAuth } from '../../../auth/testing.js';
import { buildServer } from '../../../server.js';
import { MemoryStore } from './memory-store.js';

/**
 * A small two-firm world for the M6 route tests: firm A has two clients (A and B), firm B one. Each actor is a
 * person with one membership, signed in through M5's real session hook and policy.
 */

export const uid = (n: number): Id => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const FIRM_A = uid(1);
export const FIRM_B = uid(2);

export const ids = {
  clientA: uid(10),
  clientB: uid(11),
  clientX: uid(12),
  companyA: uid(20),
  companyB: uid(21),
  companyX: uid(22),
  companyEmpty: uid(23),
  location: uid(30),
  unit1: uid(40),
  unit2: uid(41),
  unitB: uid(42),
  hr: uid(50),
  hrAlias: uid(51),
  deptB: uid(52),
  act: uid(80),
  actDup: uid(81),
  category: uid(85),
  categoryDup: uid(86),
  obligation: uid(90),
  obligationB: uid(91),
  obligationFree: uid(92),
  assignment: uid(100),
  assignmentB: uid(101),
  instance: uid(110),
  instanceDup: uid(111),
  /** ISO rows, seeded only by `seedIsoLibrary`: a STANDARD act, an activity under it, and its assignment in client A. */
  isoAct: uid(82),
  isoObligation: uid(93),
  isoAssignment: uid(102),
  /** UNCLAIMED, default owner of an assignment in client B. */
  unclaimed: uid(68),
  /** UNCLAIMED duplicate of the owner ("Omar  owner"), owner of an instance in client A only. */
  duplicate: uid(69),
} as const;

export const NOW = new Date('2026-10-12T06:30:00Z');
export const AT = '2026-10-01T00:00:00Z';
export const AS_OF = '2026-10-12' as LocalDate;

export type ActorName =
  | 'firmAdmin'
  | 'consultant'
  | 'clientAdmin'
  | 'approver'
  | 'owner'
  | 'viewer'
  | 'consultantB'
  | 'otherFirmAdmin';

interface ActorDef {
  person: Id;
  firm: Id;
  name: string;
  role: Role;
  clientId: Id | null;
  consultantClientIds: Id[] | null;
  unitIds: Id[] | null;
}

export const ACTORS: Record<ActorName, ActorDef> = {
  firmAdmin: {
    person: uid(60),
    firm: FIRM_A,
    name: 'Asha Admin',
    role: 'FIRM_ADMIN',
    clientId: null,
    consultantClientIds: null,
    unitIds: null,
  },
  consultant: {
    person: uid(61),
    firm: FIRM_A,
    name: 'Cyrus Consultant',
    role: 'CONSULTANT',
    clientId: null,
    consultantClientIds: [ids.clientA],
    unitIds: null,
  },
  clientAdmin: {
    person: uid(62),
    firm: FIRM_A,
    name: 'Kiran Clientadmin',
    role: 'CLIENT_ADMIN',
    clientId: ids.clientA,
    consultantClientIds: null,
    unitIds: null,
  },
  approver: {
    person: uid(63),
    firm: FIRM_A,
    name: 'Arun Approver',
    role: 'APPROVER',
    clientId: ids.clientA,
    consultantClientIds: null,
    unitIds: [ids.unit1],
  },
  owner: {
    person: uid(64),
    firm: FIRM_A,
    name: 'Omar Owner',
    role: 'OWNER',
    clientId: ids.clientA,
    consultantClientIds: null,
    unitIds: [ids.unit1],
  },
  viewer: {
    person: uid(65),
    firm: FIRM_A,
    name: 'Vera Viewer',
    role: 'VIEWER',
    clientId: ids.clientA,
    consultantClientIds: null,
    unitIds: null,
  },
  consultantB: {
    person: uid(66),
    firm: FIRM_A,
    name: 'Bela Consultant',
    role: 'CONSULTANT',
    clientId: null,
    consultantClientIds: [ids.clientB],
    unitIds: null,
  },
  otherFirmAdmin: {
    person: uid(67),
    firm: FIRM_B,
    name: 'Xavier Otherfirm',
    role: 'FIRM_ADMIN',
    clientId: null,
    consultantClientIds: null,
    unitIds: null,
  },
};

export const ACTOR_NAMES = Object.keys(ACTORS) as ActorName[];

/** The firm-A actor holding each role, for the role matrix. */
export const ACTOR_FOR_ROLE: Record<Role, ActorName> = {
  FIRM_ADMIN: 'firmAdmin',
  CONSULTANT: 'consultant',
  CLIENT_ADMIN: 'clientAdmin',
  APPROVER: 'approver',
  OWNER: 'owner',
  VIEWER: 'viewer',
};

export const membershipId = (actor: ActorName): Id => uid(200 + ACTOR_NAMES.indexOf(actor));

function membershipOf(actor: ActorName): Membership {
  const a = ACTORS[actor];
  return {
    id: membershipId(actor),
    firmId: a.firm,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    version: 1,
    personId: a.person,
    role: a.role,
    clientId: a.clientId,
    consultantClientIds: a.consultantClientIds,
    unitIds: a.unitIds,
    expiresAt: a.role === 'VIEWER' ? '2027-03-31T18:29:59Z' : null,
  };
}

export function contextOf(actor: ActorName, requestId = 'req-test'): RequestContext {
  const a = ACTORS[actor];
  const firmClients = a.firm === FIRM_A ? [ids.clientA, ids.clientB] : [ids.clientX];
  const clientIds =
    a.role === 'FIRM_ADMIN'
      ? firmClients
      : a.role === 'CONSULTANT'
        ? (a.consultantClientIds ?? [])
        : [a.clientId as Id];
  return {
    requestId,
    firmId: a.firm,
    personId: a.person,
    memberships: [membershipOf(actor)],
    clientIds,
    mfaSatisfied: true,
    asOf: AS_OF,
  };
}

const base = (id: Id, firmId: Id = FIRM_A) => ({
  id,
  firmId,
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
});

export function seedWorld(store: MemoryStore): void {
  const client = (id: Id, name: string, firmId: Id = FIRM_A) =>
    store.seed('clients', {
      ...base(id, firmId),
      version: 1,
      name,
      settings: DEFAULT_CLIENT_SETTINGS,
    });
  client(ids.clientA, 'Kestrel Metals Group');
  client(ids.clientB, 'Bharat Mills');
  client(ids.clientX, 'Xeno Holdings', FIRM_B);

  store.seed('companies', {
    ...base(ids.companyA),
    version: 1,
    clientId: ids.clientA,
    name: 'Kestrel Aluminium',
  });
  store.seed('companies', {
    ...base(ids.companyB),
    version: 1,
    clientId: ids.clientB,
    name: 'Bharat Textiles',
  });
  store.seed('companies', {
    ...base(ids.companyX, FIRM_B),
    version: 1,
    clientId: ids.clientX,
    name: 'Xeno',
  });
  store.seed('companies', {
    ...base(ids.companyEmpty),
    version: 1,
    clientId: ids.clientA,
    name: 'Kestrel Cement',
  });

  store.seed('locations', {
    ...base(ids.location),
    country: 'India',
    countryCode: 'IN',
    state: 'West Bengal',
    stateCode: 'WB',
    city: 'Riverbend',
  });

  const unit = (id: Id, clientId: Id, companyId: Id, name: string) =>
    store.seed('units', {
      ...base(id),
      version: 1,
      clientId,
      companyId,
      name,
      locationId: ids.location,
    });
  unit(ids.unit1, ids.clientA, ids.companyA, 'Plant');
  unit(ids.unit2, ids.clientA, ids.companyA, 'Head Office');
  unit(ids.unitB, ids.clientB, ids.companyB, 'Mill');

  const dept = (id: Id, clientId: Id, name: string) =>
    store.seed('departments', { ...base(id), version: 1, clientId, name, aliases: [] });
  dept(ids.hr, ids.clientA, 'Human Resources');
  dept(ids.hrAlias, ids.clientA, 'HR');
  dept(ids.deptB, ids.clientB, 'Safety');

  for (const actor of ACTOR_NAMES) {
    const a = ACTORS[actor];
    store.seed('people', {
      ...base(a.person, a.firm),
      version: 1,
      displayName: a.name,
      nameNormalized: a.name.toLowerCase(),
      email: `${actor.toLowerCase()}@example.com`,
      status: 'ACTIVE',
    });
    store.seed('memberships', { ...membershipOf(actor) });
  }
  const unclaimed = (id: Id, displayName: string) =>
    store.seed('people', {
      ...base(id),
      version: 1,
      displayName,
      nameNormalized: displayName.toLowerCase().replace(/\s+/g, ' '),
      email: null,
      status: 'UNCLAIMED',
    });
  unclaimed(ids.unclaimed, 'Bimal Unclaimed');
  unclaimed(ids.duplicate, 'Omar  owner');

  const aliased = (table: 'acts' | 'categories', id: Id, name: string, extra = {}) =>
    store.seed(table, { ...base(id), version: 1, name, aliases: [], ...extra });
  aliased('acts', ids.act, 'Factories Act, 1948', {
    shortName: 'Factories Act',
    jurisdiction: 'CENTRAL',
    stateCode: null,
    kind: 'STATUTE',
  });
  aliased('acts', ids.actDup, 'The Factories Act 1948', {
    shortName: null,
    jurisdiction: 'CENTRAL',
    stateCode: null,
    kind: 'STATUTE',
  });
  aliased('categories', ids.category, 'Returns');
  aliased('categories', ids.categoryDup, 'Return');

  const obligation = (id: Id, title: string) =>
    store.seed('obligations', {
      ...base(id),
      version: 1,
      externalRef: `HRS-CL-${id.slice(-3)}`,
      domain: 'HRS',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId: ids.act,
      categoryId: ids.category,
      title,
      description: 'File the return.',
      applicabilityText: null,
      criticality: 'HIGH',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'ANNUAL', month: 2, day: 1 },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: false,
      forms: [],
      logSheets: [],
      clauseRefs: [],
      libraryVersion: 1,
    });
  obligation(ids.obligation, 'Annual return');
  obligation(ids.obligationB, 'Half-yearly return');
  obligation(ids.obligationFree, 'Display of abstract');

  const assignment = (
    id: Id,
    clientId: Id,
    unitId: Id,
    obligationId: Id,
    departmentId: Id,
    owner: Id,
  ) =>
    store.seed('assignments', {
      ...base(id),
      version: 1,
      clientId,
      unitId,
      obligationId,
      departmentId,
      defaultOwnerId: owner,
      defaultApproverId: ACTORS.approver.person,
      applicability: 'APPLICABLE',
      naReason: null,
      activeFrom: '2022-04-01',
      activeTo: null,
    });
  assignment(
    ids.assignment,
    ids.clientA,
    ids.unit1,
    ids.obligation,
    ids.hrAlias,
    ACTORS.owner.person,
  );
  assignment(ids.assignmentB, ids.clientB, ids.unitB, ids.obligationB, ids.deptB, ids.unclaimed);

  const instance = (
    id: Id,
    ownerId: Id,
    periodStart: string,
    workflowState: 'OPEN' | 'APPROVED',
  ) => {
    const row: ComplianceInstance = {
      ...base(id),
      version: 1,
      clientId: ids.clientA,
      unitId: ids.unit1,
      assignmentId: ids.assignment,
      periodStart: periodStart as LocalDate,
      periodEnd: periodStart as LocalDate,
      dueDate: periodStart as LocalDate,
      workflowState,
      pendingKind: null,
      completedOn: workflowState === 'APPROVED' ? (periodStart as LocalDate) : null,
      naReason: null,
      ownerId,
      approverId: ACTORS.approver.person,
      submittedAt: null,
      approvedAt: null,
      dueDateOverridden: false,
    };
    store.seedInstance(row);
  };
  instance(ids.instance, ACTORS.owner.person, '2027-02-01', 'OPEN');
  instance(ids.instanceDup, ids.duplicate, '2026-02-01', 'APPROVED');
}

export interface TestApp {
  app: FastifyInstance;
  store: MemoryStore;
  /** The session cookie and CSRF headers for an actor. */
  headers(actor: ActorName): Record<string, string>;
  call(
    actor: ActorName | null,
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown; headers: Record<string, unknown> }>;
  /** Sets a firm's effective add-ons, as the operator console would; every firm starts with none. */
  setFeatures(firm: Id, features: string[]): void;
}

/**
 * Adds a copied ISO catalogue's rows to firm A (ISO-9): a STANDARD act, one activity under it and its assignment on
 * unit 1 of client A, owned by the owner. Not in `seedWorld`, so the other tests' lists are unchanged.
 */
export function seedIsoLibrary(store: MemoryStore): void {
  store.seed('acts', {
    ...base(ids.isoAct),
    version: 1,
    name: 'ISO 45001 occupational health and safety management',
    shortName: 'ISO 45001',
    jurisdiction: 'CENTRAL',
    stateCode: null,
    aliases: [],
    kind: 'STANDARD',
  });
  store.seed('obligations', {
    ...base(ids.isoObligation),
    version: 1,
    externalRef: 'ISO-WORKPLACE-INSPECTION',
    domain: 'OTHER',
    jurisdiction: 'CENTRAL',
    stateCode: null,
    actId: ids.isoAct,
    categoryId: ids.category,
    title: 'Workplace inspection',
    description: 'Inspect the workplace and record what was found.',
    applicabilityText: null,
    criticality: 'MEDIUM',
    timelineType: 'TIME_BASED',
    recurrenceRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    ruleStatus: 'CONFIRMED',
    evidenceRequired: true,
    forms: [],
    logSheets: [],
    clauseRefs: [{ standard: 'ISO_45001', clauseNumber: '9.1.1' }],
    libraryVersion: 1,
  });
  store.seed('assignments', {
    ...base(ids.isoAssignment),
    version: 1,
    clientId: ids.clientA,
    unitId: ids.unit1,
    obligationId: ids.isoObligation,
    departmentId: ids.hr,
    defaultOwnerId: ACTORS.owner.person,
    defaultApproverId: ACTORS.approver.person,
    applicability: 'APPLICABLE',
    naReason: null,
    activeFrom: '2026-04-01',
    activeTo: null,
  });
}

/** The firm's clients, which a firm admin sees. */
const firmClientIds = (firm: Id): Id[] =>
  firm === FIRM_A ? [ids.clientA, ids.clientB] : [ids.clientX];

/** A server over a freshly seeded world, behind M5's auth. A `null` actor sends no session. */
export function testApp(): TestApp {
  const store = new MemoryStore({ now: () => NOW });
  seedWorld(store);
  const auth = createTestAuth();
  const sessions = Object.fromEntries(
    ACTOR_NAMES.map((actor) => {
      const a = ACTORS[actor];
      const signedIn = auth.signIn({
        firmId: a.firm,
        personId: a.person,
        memberships: [membershipOf(actor)],
        principal: { firmClientIds: firmClientIds(a.firm) },
      });
      return [actor, signedIn.headers];
    }),
  ) as Record<ActorName, Record<string, string>>;
  const app = buildServer({
    authStore: auth.store,
    clock: () => NOW,
    libraryAndEntities: { store, now: () => NOW },
  });
  return {
    app,
    store,
    headers: (actor) => sessions[actor],
    setFeatures(firm, features) {
      const view = accountView(firm);
      auth.store.accounts.set(firm, {
        ...view,
        entitlements: { ...view.entitlements, features },
      });
    },
    async call(actor, method, url, body) {
      const res = await app.inject({
        method: method as 'GET',
        url: `/api/v1${url}`,
        headers: actor ? sessions[actor] : {},
        ...(body === undefined ? {} : { payload: body as object }),
      });
      return {
        status: res.statusCode,
        body: res.body === '' ? null : res.json(),
        headers: res.headers,
      };
    },
  };
}

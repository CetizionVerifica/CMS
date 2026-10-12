import { DEFAULT_CLIENT_SETTINGS, ENDPOINTS, type EndpointId, type Role } from '@canopy/contracts';
import type { MemoryStore } from './memory-store.js';
import { ACTORS, AT, ids, membershipId } from './world.js';

/**
 * One valid request per M6 endpoint against the seeded world. The role matrix, contract and audit tests all use
 * it, so adding an endpoint to the contracts without a scenario fails the tests.
 */

export interface Scenario {
  url: string;
  body?: unknown;
  /** Puts the world in the state the call needs, e.g. an archived client to restore. */
  setup?: (store: MemoryStore) => void;
}

type ScenarioFor = (role: Role) => Scenario;

const v1 = { version: 1 };
const reason = 'Recorded by the compliance team';

export const M6_ENDPOINT_IDS = (Object.keys(ENDPOINTS) as EndpointId[]).filter(
  (id) => ENDPOINTS[id].module === 'M6',
);

export const SCENARIOS: Record<string, ScenarioFor> = {
  listClients: () => ({ url: '/clients' }),
  createClient: () => ({ url: '/clients', body: { name: 'Chola Foods' } }),
  getClient: () => ({ url: `/clients/${ids.clientA}` }),
  updateClient: () => ({
    url: `/clients/${ids.clientA}`,
    body: { ...v1, name: 'Aditya Group Ltd' },
  }),
  archiveClient: () => ({ url: `/clients/${ids.clientA}/archive`, body: { ...v1, reason } }),
  restoreClient: () => ({
    url: `/clients/${ids.clientA}/restore`,
    body: v1,
    setup: (store) =>
      store.seed('clients', { ...store.raw('clients', ids.clientA)!, archivedAt: AT }),
  }),
  getClientSettings: () => ({ url: `/clients/${ids.clientA}/settings` }),
  putClientSettings: (role) => ({
    url: `/clients/${ids.clientA}/settings`,
    body:
      role === 'CLIENT_ADMIN'
        ? { ...v1, reminders: { ...DEFAULT_CLIENT_SETTINGS.reminders, ownerDaysBefore: [5, 1] } }
        : { ...v1, settings: { ...DEFAULT_CLIENT_SETTINGS, holidayPolicy: 'NEXT_WORKING_DAY' } },
  }),

  listCompanies: () => ({ url: `/clients/${ids.clientA}/companies` }),
  createCompany: () => ({
    url: `/clients/${ids.clientA}/companies`,
    body: { name: 'Aditya Power' },
  }),
  updateCompany: () => ({
    url: `/companies/${ids.companyA}`,
    body: { ...v1, name: 'Hindalco Ltd' },
  }),
  archiveCompany: () => ({
    url: `/companies/${ids.companyEmpty}/archive`,
    body: { ...v1, reason },
  }),
  listUnits: () => ({ url: `/clients/${ids.clientA}/units` }),
  createUnit: () => ({
    url: `/clients/${ids.clientA}/units`,
    body: { companyId: ids.companyA, name: 'Warehouse', locationId: ids.location },
  }),
  updateUnit: () => ({ url: `/units/${ids.unit1}`, body: { ...v1, name: 'Main Plant' } }),
  archiveUnit: () => ({ url: `/units/${ids.unit2}/archive`, body: { ...v1, reason } }),
  listLocations: () => ({ url: '/locations' }),
  createLocation: () => ({
    url: '/locations',
    body: {
      country: 'India',
      countryCode: 'IN',
      state: 'Maharashtra',
      stateCode: 'MH',
      city: 'Pune',
    },
  }),
  listDepartments: () => ({ url: `/clients/${ids.clientA}/departments` }),
  createDepartment: () => ({
    url: `/clients/${ids.clientA}/departments`,
    body: { name: 'Finance' },
  }),
  updateDepartment: () => ({ url: `/departments/${ids.hr}`, body: { ...v1, aliases: ['HRD'] } }),
  mergeDepartments: () => ({
    url: `/departments/${ids.hr}/merge`,
    body: { ...v1, sourceIds: [ids.hrAlias] },
  }),

  listFirmPeople: () => ({ url: '/people' }),
  listClientPeople: () => ({ url: `/clients/${ids.clientA}/people` }),
  createClientPerson: () => ({
    url: `/clients/${ids.clientA}/people`,
    body: { displayName: 'Neha  Nair' },
  }),
  updatePerson: () => ({
    url: `/people/${ACTORS.owner.person}`,
    body: { ...v1, displayName: 'Omar Owner Sr' },
  }),
  mergePeople: () => ({
    url: `/people/${ACTORS.owner.person}/merge`,
    body: { ...v1, sourceIds: [ids.duplicate] },
  }),
  listMemberships: () => ({ url: `/people/${ACTORS.owner.person}/memberships` }),
  createMembership: () => ({
    url: `/people/${ACTORS.owner.person}/memberships`,
    body: {
      role: 'VIEWER',
      clientId: ids.clientA,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: '2027-03-31T00:00:00Z',
    },
  }),
  updateMembership: () => ({
    url: `/memberships/${membershipId('owner')}`,
    body: { ...v1, unitIds: [ids.unit1, ids.unit2] },
  }),
  archiveMembership: () => ({
    url: `/memberships/${membershipId('viewer')}/archive`,
    body: { ...v1, reason },
  }),

  listActs: () => ({ url: '/library/acts' }),
  createAct: () => ({
    url: '/library/acts',
    body: { name: 'Payment of Wages Act, 1936', jurisdiction: 'CENTRAL' },
  }),
  updateAct: () => ({ url: `/library/acts/${ids.act}`, body: { ...v1, shortName: 'FA 1948' } }),
  mergeActs: () => ({
    url: `/library/acts/${ids.act}/merge`,
    body: { ...v1, sourceIds: [ids.actDup] },
  }),
  listCategories: () => ({ url: '/library/categories' }),
  createCategory: () => ({ url: '/library/categories', body: { name: 'Registers' } }),
  updateCategory: () => ({
    url: `/library/categories/${ids.category}`,
    body: { ...v1, aliases: ['Returns filing'] },
  }),
  mergeCategories: () => ({
    url: `/library/categories/${ids.category}/merge`,
    body: { ...v1, sourceIds: [ids.categoryDup] },
  }),
  listObligations: () => ({ url: '/library/obligations' }),
  createObligation: () => ({
    url: '/library/obligations',
    body: {
      externalRef: 'TAX-CL-033-6067-60218',
      domain: 'TAX',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId: ids.act,
      categoryId: ids.category,
      title: 'Deposit TDS',
      description: 'Deposit tax deducted at source by the 7th of the next month.',
      applicabilityText: null,
      criticality: 'CRITICAL',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: true,
      forms: [{ label: 'Challan 281', fileName: null, templateFileId: null }],
      logSheets: [],
    },
  }),
  getObligation: () => ({ url: `/library/obligations/${ids.obligation}` }),
  updateObligation: () => ({
    url: `/library/obligations/${ids.obligation}`,
    body: { ...v1, criticality: 'CRITICAL' },
  }),
  archiveObligation: () => ({
    url: `/library/obligations/${ids.obligationFree}/archive`,
    body: { ...v1, reason },
  }),
  previewRule: () => ({
    url: '/library/rules/preview',
    body: {
      rule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
      from: '2026-04-01',
      to: '2027-03-31',
      fyStartMonth: 4,
    },
  }),
  pushObligation: () => ({
    url: `/library/obligations/${ids.obligation}/push`,
    body: { clientIds: [ids.clientA] },
  }),

  listAssignments: () => ({ url: `/clients/${ids.clientA}/assignments` }),
  createAssignment: () => ({ url: `/clients/${ids.clientA}/assignments`, body: newAssignment() }),
  bulkCreateAssignments: () => ({
    url: `/clients/${ids.clientA}/assignments/bulk`,
    body: { items: [newAssignment()] },
  }),
  updateAssignment: () => ({
    url: `/assignments/${ids.assignment}`,
    body: { ...v1, defaultOwnerId: ids.duplicate, applyToOpen: true },
  }),
  setAssignmentApplicability: () => ({
    url: `/assignments/${ids.assignment}/applicability`,
    body: { ...v1, applicability: 'NOT_APPLICABLE', reason: 'The plant has no boiler' },
  }),
  archiveAssignment: () => ({
    url: `/assignments/${ids.assignment}/archive`,
    body: { ...v1, reason },
  }),
};

export function newAssignment(overrides: Record<string, unknown> = {}) {
  return {
    unitId: ids.unit1,
    obligationId: ids.obligationB,
    departmentId: ids.hr,
    defaultOwnerId: ACTORS.owner.person,
    defaultApproverId: ACTORS.approver.person,
    activeFrom: '2026-04-01',
    ...overrides,
  };
}

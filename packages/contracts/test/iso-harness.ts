// Shared harness for the ISO mock suites (test/iso-*.test.ts): firm B's people, calls by endpoint id, and seeding
// helpers that write records straight into the store, so a suite can set up another area's records without its routes.
import { expect } from 'vitest';
import type { z } from 'zod';
import { ENDPOINTS, type Endpoint } from '../src/api/endpoints.js';
import { ApiErrorResponse } from '../src/api/error-details.js';
import { FIRM_B_AS_OF, fixtureId, isoClauseId } from '../src/fixtures/index.js';
import { createMockServer, MOCK_BASE_PATH } from '../src/mock/index.js';
import type { FirmState, IsoRow, IsoTables } from '../src/mock/store.js';
import type { IsoStandardCode } from '../src/enums.js';

export type Id = keyof typeof ENDPOINTS;
export type App = ReturnType<typeof createMockServer>;

/** The mock's "today" for firm B. */
export const TODAY = FIRM_B_AS_OF;
export const NOW = `${TODAY}T06:30:00Z`;

const b = (key: string) => fixtureId(`firm-b:${key}`);

/** Firm B's people (docs/contracts/fixtures.md §6). */
export const PERSON = {
  meera: b('person:meera'), // FIRM_ADMIN
  arjun: b('person:arjun'), // CONSULTANT for Northwind
  leela: b('person:leela'), // CONSULTANT for Harbour only
  kabir: b('person:kabir'), // CLIENT_ADMIN, Northwind
  nisha: b('person:nisha'), // APPROVER, Northwind Pune only
  divya: b('person:divya'), // APPROVER, all Northwind units
  rohan: b('person:rohan'), // OWNER, Northwind Pune only
  sameer: b('person:sameer'), // OWNER, all Northwind units
  vikram: b('person:vikram'), // VIEWER, Northwind
  gita: b('person:gita'), // OWNER, DISABLED
  priya: b('person:priya'), // APPROVER, Harbour
  joseph: b('person:joseph'), // OWNER, Harbour
};
export const FIRM_B = fixtureId('firm-b');
export const NORTHWIND = b('client:northwind');
export const HARBOUR = b('client:harbour');
export const PUNE = b('unit:pune');
export const BENGALURU = b('unit:bengaluru');
export const CHENNAI = b('unit:chennai');

/** A fresh mock server pinned to firm B's today; close it in afterAll. */
export async function isoApp(): Promise<App> {
  const app = createMockServer({ today: TODAY });
  await app.ready();
  return app;
}

export interface Call {
  as?: string | null;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Every endpoint a suite called, for "each ISO endpoint is called" checks. */
export const called = new Set<Id>();

export async function call(
  app: App,
  id: Id,
  { as = PERSON.meera, params = {}, query, body, headers = {} }: Call = {},
) {
  const ep: Endpoint = ENDPOINTS[id];
  called.add(id);
  const path = ep.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = name === 'clientId' ? (params.clientId ?? NORTHWIND) : params[name];
    if (value === undefined) throw new Error(`${id}: missing path param ${name}`);
    return encodeURIComponent(value);
  });
  const search = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
  const response = await app.inject({
    method: ep.method,
    url: `${MOCK_BASE_PATH}${path}${search}`,
    headers: {
      ...(as === null ? {} : { 'x-mock-person': as }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  const json = response.body === '' ? null : (JSON.parse(response.body) as unknown);
  return { status: response.statusCode, json, headers: response.headers };
}

/** Calls an endpoint and checks the status and response schema the endpoint table promises. */
export async function ok<T = Record<string, unknown>>(
  app: App,
  id: Id,
  request?: Call,
): Promise<T> {
  const result = await call(app, id, request);
  if (result.status !== ENDPOINTS[id].status) {
    throw new Error(`${id}: ${result.status} ${JSON.stringify(result.json)}`);
  }
  const parsed = ENDPOINTS[id].response.safeParse(result.json);
  expect(parsed.success, `${id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  return result.json as T;
}

/** Calls an endpoint and expects the error `code` with `status`; returns the error envelope. */
export async function fails(app: App, id: Id, request: Call, code: string, status: number) {
  const result = await call(app, id, request);
  expect(result.status, `${id} ${JSON.stringify(result.json)}`).toBe(status);
  expect(ApiErrorResponse.parse(result.json).error.code).toBe(code);
  return result.json as { error: { code: string; details?: Record<string, unknown> } };
}

// ---------- the store ----------

export const firmB = (app: App): FirmState => app.store.firm(FIRM_B);

/** The id of a clause in firm B's copy of the catalogue, e.g. `clause('ISO_9001', '7.1.5')`. */
export const clause = (standard: IsoStandardCode, number: string) =>
  isoClauseId(FIRM_B, standard, number);

/** The id of a standard in firm B's copy of the catalogue. */
export function standardId(app: App, code: IsoStandardCode): string {
  return firmB(app).isoCatalogue.standards.find((s) => s.code === code)!.id;
}

/** Audit events written for one ISO record, oldest first. */
export const isoEvents = (app: App, entityId: string) =>
  firmB(app).data.auditEvents.filter((e) => e.entityId === entityId);

let seq = 0;
/** A fresh deterministic-enough id for seeded rows. */
export const seedId = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;

/** Base fields of a seeded ISO client record. */
export function base(clientId = NORTHWIND) {
  return {
    id: seedId(),
    firmId: FIRM_B,
    clientId,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    version: 1,
  };
}

/** Pushes a row into an ISO table, checked against the table's schema; returns it. */
export function seed<K extends keyof IsoTables>(
  app: App,
  table: K,
  row: z.input<(typeof import('../src/fixtures/schema.js').IsoTablesShape)[K]>[number],
): IsoRow<K> {
  (firmB(app).iso[table] as unknown[]).push(row);
  return row as IsoRow<K>;
}

/**
 * Seeds a management system over `standards` (default all three) and `unitIds` (default none, meaning every unit),
 * with one NOT_STARTED checklist row per assessable clause of its standards, as `createIsoSystem` makes them.
 */
export function seedSystem(
  app: App,
  options: {
    clientId?: string;
    standards?: IsoStandardCode[];
    unitIds?: string[];
    name?: string;
    climateChangeRelevant?: boolean | null;
  } = {},
): IsoRow<'managementSystems'> {
  const firm = firmB(app);
  const clientId = options.clientId ?? NORTHWIND;
  const codes = options.standards ?? ['ISO_9001', 'ISO_14001', 'ISO_45001'];
  const standardIds = codes.map((c) => standardId(app, c));
  const decided = options.climateChangeRelevant ?? null;
  const system = seed(app, 'managementSystems', {
    ...base(clientId),
    name: options.name ?? `Seeded system ${seq + 1}`,
    standardIds,
    scopeStatement: null,
    unitIds: options.unitIds ?? [],
    status: 'IMPLEMENTING',
    reviewIntervalMonths: 12,
    climateChangeRelevant: decided,
    climateChangeRationale: decided === null ? null : 'Seeded decision.',
    climateDecidedOn: decided === null ? null : TODAY,
  });
  for (const c of firm.isoCatalogue.clauses) {
    if (!c.assessable || !standardIds.includes(c.standardId)) continue;
    seed(app, 'clauseAssessments', {
      ...base(clientId),
      managementSystemId: system.id,
      clauseId: c.id,
      status: 'NOT_STARTED',
      justification: null,
      naState: 'NONE',
      statusBeforeNa: null,
      naRequestedById: null,
      naDecidedById: null,
      naDecidedAt: null,
      ownerId: null,
      notes: null,
      lastReviewedOn: null,
    });
  }
  return system;
}

/** Turns firm B's ISO add-on off (or back on) through the console stand-in. */
export async function setFeatures(app: App, features: string[], isoCatalogueCopied?: boolean) {
  const response = await app.inject({
    method: 'PUT',
    url: `/__mock/firms/${FIRM_B}/features`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      features,
      ...(isoCatalogueCopied === undefined ? {} : { isoCatalogueCopied }),
    }),
  });
  expect(response.statusCode).toBe(200);
}

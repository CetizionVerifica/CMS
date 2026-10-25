import { z } from 'zod';
import { type Role } from '../enums.js';
import { Id } from '../primitives.js';
import type { KnownFeature } from '../schemas/accounts.js';

/** The endpoint shape and the `endpoint()` builder shared by the endpoint tables (`endpoints.ts`, `iso-endpoints.ts`). */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';
export type ProviderModule = 'M5' | 'M6' | 'M7' | 'M8' | 'M10' | 'M15' | 'M16';

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
  /**
   * The add-on the route belongs to (ADR M16-0001). Without it on the account, the route answers 403
   * FEATURE_NOT_ENABLED after the session check and before the role check, reads included.
   */
  feature?: KnownFeature;
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

/** Path params from the template: every `{name}` is an Id unless `overrides` says otherwise. */
function paramsFor(path: string, overrides: Record<string, z.ZodType> = {}): z.ZodObject | null {
  const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
  if (names.length === 0) return null;
  return z.strictObject(Object.fromEntries(names.map((name) => [name, overrides[name] ?? Id])));
}

export interface EndpointInput {
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
  feature?: KnownFeature;
}

/** An endpoint that keeps its schema types, so clients and the mock server get typed bodies and responses. */
export type TypedEndpoint<I extends EndpointInput> = Endpoint & {
  query: I['query'] extends z.ZodType ? I['query'] : null;
  body: I['body'] extends z.ZodType ? I['body'] : null;
  response: I['response'];
};

export function endpoint<const I extends EndpointInput>(input: I): TypedEndpoint<I> {
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
    ...(input.feature === undefined ? {} : { feature: input.feature }),
  } as unknown as TypedEndpoint<I>;
}

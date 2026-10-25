import { z } from 'zod';
import { Id, Instant, LocalDate } from '../primitives.js';
import { CONTRACTS_VERSION } from '../version.js';
import {
  ColumnMapping,
  DryRunReport,
  ImportBatch,
  ImportRow,
  MappingTemplate,
} from '../schemas/import.js';
import {
  Act,
  Category,
  GeneratedPeriod,
  Obligation,
  RecurrenceRule,
  TemplateRef,
} from '../schemas/library.js';
import { Breakdown, ExportJob, PortfolioRow, ScoreResult } from '../schemas/scores.js';
import {
  Client,
  ClientSettings,
  Company,
  Department,
  Location,
  Membership,
  Person,
  ReminderSettings,
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
import {
  Account,
  OperatorAuditEvent,
  Plan,
  Subscription,
  SupportGrant,
  UsageSnapshot,
} from '../schemas/accounts.js';
import { AccountView, OperatorMe } from './accounts.js';
import { Invite, InvitePreview, Me, MembershipGrant } from './auth.js';
import { SignedUrl, UploadTicket } from './common.js';
import { ClientOverview, CalendarDay } from './dashboards.js';
import { ClientSettingsView, ObligationPushResult } from './entities.js';
import { ApiErrorResponse } from './error-details.js';
import {
  AuditEventPage,
  CategoryPage,
  ClientPage,
  type Endpoint,
  AccountPage,
  ENDPOINTS,
  InstanceRowPage,
  OperatorAuditEventPage,
  PLATFORM_ENDPOINTS,
  PersonPage,
} from './endpoints.js';
import { ImportIssueGroup, ImportUploaded, ImportUploadTicket, SheetPreview } from './imports.js';

/**
 * Builds the OpenAPI 3.1 document from the endpoint table. `docs/contracts/openapi.json` is its output
 * (`pnpm --filter @canopy/contracts openapi`); a test fails if the committed file is stale.
 */

/** Session cookie M5 sets on sign-in. */
export const SESSION_COOKIE = 'canopy_session';

/** Schemas that appear in the spec under their own name. */
const NAMED_SCHEMAS: Record<string, z.ZodType> = {
  Id,
  LocalDate,
  Instant,
  Client,
  ClientSettings,
  ReminderSettings,
  Company,
  Location,
  Unit,
  Department,
  Person,
  Membership,
  Act,
  Category,
  RecurrenceRule,
  TemplateRef,
  Obligation,
  GeneratedPeriod,
  Assignment,
  InstanceRow,
  InstanceDetail,
  EvidenceView,
  Comment,
  AuditEvent,
  ColumnMapping,
  DryRunReport,
  ImportBatch,
  ImportRow,
  MappingTemplate,
  ScoreResult,
  Breakdown,
  PortfolioRow,
  ExportJob,
  Me,
  AccountView,
  SupportGrant,
  Invite,
  InvitePreview,
  MembershipGrant,
  SignedUrl,
  UploadTicket,
  ClientOverview,
  CalendarDay,
  ClientSettingsView,
  ObligationPushResult,
  ImportIssueGroup,
  ImportUploaded,
  ImportUploadTicket,
  SheetPreview,
  ClientPage,
  PersonPage,
  CategoryPage,
  InstanceRowPage,
  AuditEventPage,
  Error: ApiErrorResponse,
};

type JsonObject = Record<string, unknown>;

export interface OpenApiDocument extends JsonObject {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, JsonObject>>;
  components: {
    schemas: Record<string, JsonObject>;
    parameters: Record<string, JsonObject>;
    headers: Record<string, JsonObject>;
    securitySchemes: Record<string, JsonObject>;
  };
}

const SCHEMA_URI = '#/components/schemas/';

function pascal(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function hasBody(schema: z.ZodType): boolean {
  return !(schema instanceof z.ZodNull);
}

/** Drop the keys z.toJSONSchema adds for standalone documents. */
function clean(schema: JsonObject): JsonObject {
  const copy = { ...schema };
  delete copy.$schema;
  delete copy.$id;
  return copy;
}

/** Inline JSON Schema for one query or path parameter object, split into OpenAPI parameters. */
function parameters(schema: z.ZodType, location: 'query' | 'path'): JsonObject[] {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonObject;
  const properties = json.properties as Record<string, JsonObject>;
  const required = new Set((json.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === 'path' || required.has(name),
    schema: clean(property),
  }));
}

/** What differs between the customer and the operator document. */
interface DocumentOptions {
  title: string;
  server: string;
  cookie: string;
  tags: readonly string[];
  namedSchemas: Record<string, z.ZodType>;
  description: string;
}

const CUSTOMER_DOCUMENT: DocumentOptions = {
  title: 'Canopy API',
  server: '/api/v1',
  cookie: SESSION_COOKIE,
  tags: ['M5', 'M6', 'M7', 'M8', 'M10', 'M15', 'M16'],
  namedSchemas: NAMED_SCHEMAS,
  description:
    'Generated from @canopy/contracts; do not edit. Conventions: docs/contracts/api-conventions.md. ' +
    'Role permissions per operation are in x-canopy-roles (all, own, limited); a missing role is 403. ' +
    'An operation with x-canopy-feature needs that add-on: 403 FEATURE_NOT_ENABLED without it.',
};

/** Operator session cookie (ADR M15-0001 decision 9); never valid on the customer API. */
export const OPERATOR_SESSION_COOKIE = 'op_sid';

const PLATFORM_DOCUMENT: DocumentOptions = {
  title: 'Canopy platform operator API',
  server: '/api/platform/v1',
  cookie: OPERATOR_SESSION_COOKIE,
  tags: ['M15'],
  namedSchemas: {
    Id,
    LocalDate,
    Instant,
    Account,
    Plan,
    Subscription,
    UsageSnapshot,
    OperatorAuditEvent,
    SupportGrant,
    OperatorMe,
    AccountPage,
    OperatorAuditEventPage,
    Error: ApiErrorResponse,
  },
  description:
    'Generated from @canopy/contracts; do not edit. The operator console API (ADR M15-0001). Every route except ' +
    'sign-in needs the operator session; there are no roles. Conventions as in docs/contracts/api-conventions.md.',
};

/** The operator API document; `docs/contracts/openapi.platform.json` is its output. */
export function buildPlatformOpenApi(
  endpoints: Record<string, Endpoint> = PLATFORM_ENDPOINTS,
): OpenApiDocument {
  return buildOpenApi(endpoints, PLATFORM_DOCUMENT);
}

export function buildOpenApi(
  endpoints: Record<string, Endpoint> = ENDPOINTS,
  options: DocumentOptions = CUSTOMER_DOCUMENT,
): OpenApiDocument {
  const registry = z.registry<{ id: string }>();
  const names = new Map<z.ZodType, string>();
  const name = (schema: z.ZodType, fallback: string): string => {
    const existing = names.get(schema);
    if (existing !== undefined) return existing;
    names.set(schema, fallback);
    registry.add(schema, { id: fallback });
    return fallback;
  };
  for (const [key, schema] of Object.entries(options.namedSchemas)) name(schema, key);

  const operations: [Endpoint, string, JsonObject][] = [];
  for (const [id, ep] of Object.entries(endpoints)) {
    const responses: JsonObject = {};
    if (hasBody(ep.response)) {
      const ref = name(ep.response, `${pascal(id)}Response`);
      responses[String(ep.status)] = {
        description: ep.summary,
        headers: { 'X-Request-Id': { $ref: '#/components/headers/RequestId' } },
        content: { 'application/json': { schema: { $ref: SCHEMA_URI + ref } } },
      };
    } else {
      responses[String(ep.status)] = {
        description: ep.summary,
        headers: { 'X-Request-Id': { $ref: '#/components/headers/RequestId' } },
      };
    }
    responses.default = {
      description: 'Error envelope (api-conventions.md §4-5); clients branch on error.code.',
      content: { 'application/json': { schema: { $ref: `${SCHEMA_URI}Error` } } },
    };

    const params: JsonObject[] = [];
    if (ep.params) params.push(...parameters(ep.params, 'path'));
    if (ep.query) params.push(...parameters(ep.query, 'query'));
    if (ep.idempotent) params.push({ $ref: '#/components/parameters/IdempotencyKey' });
    if (ep.method !== 'GET' && ep.auth !== 'public') {
      params.push({ $ref: '#/components/parameters/CsrfToken' });
    }

    const operation: JsonObject = {
      operationId: id,
      summary: ep.summary,
      tags: [ep.module],
      ...(params.length > 0 ? { parameters: params } : {}),
      ...(ep.body
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: SCHEMA_URI + name(ep.body, `${pascal(id)}Body`) },
                },
              },
            },
          }
        : {}),
      responses,
      security: ep.auth === 'public' ? [] : [{ session: [] }],
      'x-canopy-module': ep.module,
      'x-canopy-auth': ep.auth,
      'x-canopy-actions': ep.actions,
      'x-canopy-roles': ep.roles,
      'x-canopy-idempotent': ep.idempotent,
      ...(ep.notes === undefined ? {} : { 'x-canopy-notes': ep.notes }),
      ...(ep.feature === undefined ? {} : { 'x-canopy-feature': ep.feature }),
    };
    operations.push([ep, id, operation]);
  }

  const generated = z.toJSONSchema(registry, {
    io: 'input',
    unrepresentable: 'any',
    uri: (id) => SCHEMA_URI + id,
  }) as { schemas: Record<string, JsonObject> };
  const schemas = Object.fromEntries(
    Object.entries(generated.schemas)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, schema]) => [key, clean(schema)]),
  );

  const paths: OpenApiDocument['paths'] = {};
  for (const [ep, , operation] of operations) {
    paths[ep.path] ??= {};
    (paths[ep.path] as Record<string, JsonObject>)[ep.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.title,
      version: CONTRACTS_VERSION,
      description: options.description,
    },
    servers: [{ url: options.server }],
    tags: options.tags.map((module) => ({ name: module })),
    paths,
    components: {
      schemas,
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          description: 'A repeat with the same key within 24 hours returns the first response.',
          schema: { type: 'string', format: 'uuid' },
        },
        CsrfToken: {
          name: 'X-CSRF-Token',
          in: 'header',
          required: true,
          description: 'The csrfToken from GET /me.',
          schema: { type: 'string' },
        },
      },
      headers: {
        RequestId: {
          description:
            'Echoed from the request, else generated; the requestId in audit events and logs.',
          schema: { type: 'string' },
        },
      },
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: options.cookie },
      },
    },
  };
}

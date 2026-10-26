import type { ENDPOINTS, RequestContext } from '@canopy/contracts';
import type { Database } from '@canopy/db';
import type { z } from 'zod';
import type { KeyedRequest } from './idempotency.js';
import type { IsoFiles } from './ports.js';

/**
 * The types M16's handlers share: one handler per ISO entry of `ENDPOINTS` (module M16, `iso-endpoints.ts`), called
 * by the registrar in routes.ts.
 */

export type IsoEndpoints = typeof ENDPOINTS;
export type IsoEndpointId = keyof IsoEndpoints;

type Parsed<T> = T extends z.ZodType ? z.output<T> : undefined;

/** One parsed request: the actor, the path params, and the query and body as the contract parses them. */
export interface IsoCall<K extends IsoEndpointId> {
  readonly ctx: RequestContext;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Parsed<IsoEndpoints[K]['query']>;
  readonly body: Parsed<IsoEndpoints[K]['body']>;
  /** The request's `Idempotency-Key`, on routes marked `idempotent`. */
  readonly key: KeyedRequest | undefined;
}

export type IsoHandlers<K extends IsoEndpointId> = {
  readonly [P in K]: (call: IsoCall<P>) => Promise<z.input<IsoEndpoints[P]['response']>>;
};

export interface IsoRouteOptions {
  readonly db: Database;
  /** Defaults to the system clock. */
  readonly clock?: () => Date;
  /** The ISO file service; the file routes are mounted only when it is given. */
  readonly files?: IsoFiles;
}

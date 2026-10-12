// Handler types: one handler per ENDPOINTS entry, typed by that endpoint's schemas.
import type { z } from 'zod';
import type { ENDPOINTS } from '../api/endpoints.js';
import type { Actor, Clock, Scope } from './core.js';
import type { MockStore, Session } from './store.js';

export type EndpointId = keyof typeof ENDPOINTS;
type Ep<K extends EndpointId> = (typeof ENDPOINTS)[K];

export type QueryOf<K extends EndpointId> = Ep<K>['query'] extends z.ZodType
  ? z.output<Ep<K>['query']>
  : undefined;
export type BodyOf<K extends EndpointId> = Ep<K>['body'] extends z.ZodType
  ? z.output<Ep<K>['body']>
  : undefined;
export type ResultOf<K extends EndpointId> = z.input<Ep<K>['response']>;

export interface HandlerContext<K extends EndpointId> {
  store: MockStore;
  clock: Clock;
  requestId: string;
  /** Null only on public endpoints. */
  actor: Actor | null;
  params: Record<string, string>;
  query: QueryOf<K>;
  body: BodyOf<K>;
  /** The endpoints.md role check for what this request touches; every `action` endpoint calls it. */
  authorize(scope: Scope): void;
  /** Starts (or, with null, ends) the cookie session. */
  setSession(session: Session | null): void;
}

export type Handler<K extends EndpointId> = (ctx: HandlerContext<K>) => ResultOf<K>;
export type Handlers = { [K in EndpointId]: Handler<K> };
export type PartialHandlers<K extends EndpointId> = { [P in K]: Handler<P> };

/** The signed-in actor; endpoints that are not public always have one. */
export function actorOf<K extends EndpointId>(ctx: HandlerContext<K>): Actor {
  return ctx.actor!;
}

'use server';
// Server Actions behind the ISO screens. A screen names an ISO route from the contracts' endpoint table; the route must
// be one of the add-on's (never another module's), its path ids are checked as ids and its body against the route's own
// contracts schema before anything is sent (root rule 7). The API checks access, the add-on and every ISO rule, and
// writes the audit events; nothing here decides who may act.
import { ENDPOINTS, Id } from '@canopy/contracts';
import { revalidatePath } from 'next/cache';

import {
  isApiError,
  type CallRequest,
  type CallResponse,
  type EndpointName,
} from '../../../../../../lib/api/client';
import { sessionApi } from '../../../../../../lib/api/server';
import type { IsoWriteRoute } from './may';
import { failureMessage, type Outcome } from './outcome';

/** Reads a screen makes after the page has loaded: a record's files, and a file's short-lived download link. */
export type IsoReadRoute = 'listIsoFiles' | 'isoFileDownloadUrl' | 'listIsoExternalFindings';
const READS: readonly string[] = [
  'listIsoFiles',
  'isoFileDownloadUrl',
  'listIsoExternalFindings',
] satisfies IsoReadRoute[];

function isIsoWrite(name: string): name is IsoWriteRoute {
  const ep = (ENDPOINTS as Record<string, (typeof ENDPOINTS)[EndpointName]>)[name];
  return ep !== undefined && ep.feature === 'isoManagement' && ep.method !== 'GET';
}

/** The path's ids by name: every `{name}` in the template, each an id, `clientId` from the page. */
function pathParams(name: EndpointName, clientId: string, ids: Record<string, string>) {
  const params: Record<string, string> = {};
  for (const [, key] of ENDPOINTS[name].path.matchAll(/\{(\w+)\}/g)) {
    params[key!] = Id.parse(key === 'clientId' ? clientId : ids[key!]);
  }
  return params;
}

async function send<N extends EndpointName>(
  name: N,
  clientId: string,
  ids: Record<string, string>,
  request: Omit<CallRequest<N>, 'params'>,
  write: boolean,
): Promise<Outcome<CallResponse<N>>> {
  const endpoint = ENDPOINTS[name];
  const params = pathParams(name, clientId, ids);
  const body = endpoint.body?.safeParse(request.body ?? {});
  const query = endpoint.query?.safeParse(request.query ?? {});
  if (body?.success === false || query?.success === false) {
    return { ok: false, code: 'VALIDATION', message: failureMessage('VALIDATION') };
  }
  try {
    const api = await sessionApi();
    const { data } = await api.call(name, {
      params,
      ...(body === undefined ? {} : { body: body.data as CallRequest<N>['body'] }),
      ...(query === undefined ? {} : { query: query.data as CallRequest<N>['query'] }),
    });
    return { ok: true, data };
  } catch (error) {
    if (!isApiError(error)) throw error;
    return { ok: false, code: error.code, message: failureMessage(error.code, error.message) };
  } finally {
    if (write) revalidatePath(`/c/${params.clientId}/iso`, 'layout');
  }
}

/** One ISO write: a create, an edit or a step. */
export async function isoWrite<N extends IsoWriteRoute>(
  clientId: string,
  name: N,
  ids: Record<string, string>,
  body?: CallRequest<N>['body'],
): Promise<Outcome<CallResponse<N>>> {
  if (!isIsoWrite(name)) throw new Error('Not an ISO write route');
  return send(name, clientId, ids, { body } as Omit<CallRequest<N>, 'params'>, true);
}

/** One of the few reads a screen makes after load. */
export async function isoRead<N extends IsoReadRoute>(
  clientId: string,
  name: N,
  ids: Record<string, string>,
  query?: CallRequest<N>['query'],
): Promise<Outcome<CallResponse<N>>> {
  if (!READS.includes(name)) throw new Error('Not an ISO read a screen may make');
  return send(name, clientId, ids, { query } as Omit<CallRequest<N>, 'params'>, false);
}

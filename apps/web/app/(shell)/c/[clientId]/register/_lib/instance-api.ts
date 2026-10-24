// The instance drawer's calls to the API: the instance with its evidence, comments and history, the workflow actions,
// comments and evidence. Plain functions of an API client, so the Server Actions stay thin and the tests can run these
// against the in-process mock. Everything here is wording and plumbing; the API decides what is allowed.
import {
  InstanceRow,
  MAX_PAGE_LIMIT,
  type AuditEvent,
  type Comment,
  type ErrorCode,
  type EvidenceView,
  type InstanceDetail,
  type UploadTicket,
} from '@canopy/contracts';

import { isApiError, type ApiClient } from '../../../../../../lib/api/client';

type Api = Pick<ApiClient, 'call'>;

export type AuditPage = { events: AuditEvent[]; nextCursor: string | null };

export type DrawerData = {
  detail: InstanceDetail;
  evidence: EvidenceView[];
  comments: Comment[];
  /** Comments past the first page; the drawer says how many it doesn't show. */
  moreComments: boolean;
  audit: AuditPage;
  /** Display names by person id, for comment authors and the activity timeline. */
  names: Record<string, string>;
};

/** How many history events the drawer loads at a time. */
export const AUDIT_PAGE = 20;

/** Names of the people in the client (first page), plus the instance's owner and approver. A failed list is no names. */
async function peopleNames(api: Api, detail: InstanceDetail): Promise<Record<string, string>> {
  const people = await api
    .call('listClientPeople', {
      params: { clientId: detail.clientId },
      query: { limit: String(MAX_PAGE_LIMIT) },
    })
    .then(
      (r) => r.data.items,
      () => [],
    );
  return {
    ...Object.fromEntries(people.map((p) => [p.id, p.displayName])),
    [detail.ownerId]: detail.ownerName,
    [detail.approverId]: detail.approverName,
  };
}

export async function loadAudit(api: Api, id: string, cursor?: string): Promise<AuditPage> {
  const { data } = await api.call('instanceAudit', {
    params: { id },
    query: { limit: String(AUDIT_PAGE), ...(cursor ? { cursor } : {}) },
  });
  return { events: data.items, nextCursor: data.nextCursor };
}

export async function loadEvidence(api: Api, id: string): Promise<EvidenceView[]> {
  const { data } = await api.call('listInstanceEvidence', { params: { id } });
  return data.items;
}

/** Everything the drawer shows for one instance. Throws the API's error when the instance itself can't be read. */
export async function loadDrawer(api: Api, id: string): Promise<DrawerData> {
  const { data: detail } = await api.call('getInstance', { params: { id } });
  const [evidence, comments, audit, names] = await Promise.all([
    loadEvidence(api, id),
    api.call('listComments', { params: { id }, query: { limit: String(MAX_PAGE_LIMIT) } }),
    loadAudit(api, id),
    peopleNames(api, detail),
  ]);
  return {
    detail,
    evidence,
    comments: comments.data.items,
    moreComments: comments.data.nextCursor !== null,
    audit,
    names,
  };
}

/** A workflow action from the drawer's footer, with what the person typed. */
export type WorkflowAction =
  | { kind: 'SUBMIT'; version: number; completedOn: string; comment: string }
  | { kind: 'REQUEST_NA'; version: number; reason: string }
  | { kind: 'APPROVE'; version: number; comment?: string }
  | { kind: 'SEND_BACK'; version: number; reason: string }
  | { kind: 'REOPEN'; version: number; reason: string };

export async function runAction(
  api: Api,
  id: string,
  action: WorkflowAction,
): Promise<InstanceDetail> {
  const params = { id };
  switch (action.kind) {
    case 'SUBMIT': {
      const { version, completedOn, comment } = action;
      return (await api.call('submitInstance', { params, body: { version, completedOn, comment } }))
        .data;
    }
    case 'REQUEST_NA': {
      const { version, reason } = action;
      return (await api.call('requestNa', { params, body: { version, reason } })).data;
    }
    case 'APPROVE': {
      const { version, comment } = action;
      return (
        await api.call('approveInstance', {
          params,
          body: { version, ...(comment ? { comment } : {}) },
        })
      ).data;
    }
    case 'SEND_BACK': {
      const { version, reason } = action;
      return (await api.call('sendBackInstance', { params, body: { version, reason } })).data;
    }
    case 'REOPEN': {
      const { version, reason } = action;
      return (await api.call('reopenInstance', { params, body: { version, reason } })).data;
    }
  }
}

export async function addComment(api: Api, id: string, body: string): Promise<Comment> {
  return (await api.call('createComment', { params: { id }, body: { body } })).data;
}

export async function startUpload(
  api: Api,
  id: string,
  file: { fileName: string; mimeType: string; sizeBytes: number },
): Promise<UploadTicket> {
  return (await api.call('evidenceUploadUrl', { params: { id }, body: file })).data;
}

export async function confirmUpload(
  api: Api,
  id: string,
  upload: { uploadId: string; fileName: string; sha256: string },
): Promise<EvidenceView> {
  return (await api.call('confirmEvidence', { params: { id }, body: upload })).data;
}

/** A link to one CLEAN evidence file that works for 5 minutes. Never logged (root rule 6). */
export async function evidenceLink(api: Api, evidenceId: string): Promise<string> {
  return (await api.call('evidenceDownloadUrl', { params: { id: evidenceId } })).data.url;
}

export async function removeEvidence(
  api: Api,
  evidenceId: string,
  reason: string,
): Promise<EvidenceView> {
  return (await api.call('removeEvidence', { params: { id: evidenceId }, body: { reason } })).data;
}

/**
 * The upload URL's host can never resolve (`.invalid` is reserved, RFC 2606), as with the demo API's file host, so
 * there is nothing to send the bytes to. Any other URL gets the PUT.
 */
export function uploadHasNoHost(url: string): boolean {
  return new URL(url).hostname.endsWith('.invalid');
}

/** Lower-case hex SHA-256 of the file, which confirmEvidence checks against the stored bytes. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The register row inside a detail, so the grid can show a change without reloading. */
export function rowOf(detail: InstanceDetail): InstanceRow {
  const keys = Object.keys(InstanceRow.shape) as (keyof InstanceRow)[];
  return Object.fromEntries(keys.map((key) => [key, detail[key]])) as InstanceRow;
}

/** What went wrong, in words, for a failed drawer call. Keyed by the API's error code (api-conventions.md §4). */
export function errorMessage(code: ErrorCode | 'UNKNOWN'): string {
  switch (code) {
    case 'STALE_VERSION':
      return 'Someone changed this instance since you opened it. It has been reloaded: check it and try again.';
    case 'INVALID_TRANSITION':
      return 'This instance has moved on since you opened it, so that action no longer applies. It has been reloaded.';
    case 'EVIDENCE_REQUIRED':
      return 'Attach evidence that has passed the virus check before you submit.';
    case 'EVIDENCE_NOT_READY':
      return 'The evidence is still being checked for viruses. Try again in a moment.';
    case 'DATE_IN_FUTURE':
      return 'The completion date can’t be after today.';
    case 'REASON_REQUIRED':
      return 'Give a reason.';
    case 'FILE_TOO_LARGE':
      return 'That file is too large. The limit is 25 MB.';
    case 'UNSUPPORTED_FILE':
      return 'That type of file can’t be attached.';
    case 'FORBIDDEN':
    case 'ACCESS_EXPIRED':
    case 'NOT_FOUND':
      return 'You can’t do that on this instance.';
    case 'VALIDATION':
      return 'Some of what you entered isn’t valid. Check it and try again.';
    default:
      return 'That didn’t go through. Try again.';
  }
}

export type Outcome<T> =
  { ok: true; data: T } | { ok: false; code: ErrorCode | 'UNKNOWN'; message: string };

/**
 * Runs a call and turns an API error into words, since a Server Action's thrown errors don't reach the browser intact.
 * Anything that isn't an API error (a bug, the network) still throws.
 */
export async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (!isApiError(error)) throw error;
    return { ok: false, code: error.code, message: errorMessage(error.code) };
  }
}

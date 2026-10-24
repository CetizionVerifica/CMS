'use server';
// Server Actions behind the instance drawer. Every argument comes from the browser, so each is checked against the
// contracts' schemas first (root rule 7); the API then checks the person's access and the instance's state. Each one
// answers with an Outcome, since an error thrown here reaches the browser without its code.
import {
  ApproveBody,
  CommentCreateBody,
  Cursor,
  EvidenceConfirmBody,
  EvidenceRemoveBody,
  EvidenceUploadUrlBody,
  Id,
  ReopenBody,
  RequestNaBody,
  SendBackBody,
  SubmitBody,
  type Comment,
  type EvidenceView,
  type InstanceDetail,
  type UploadTicket,
} from '@canopy/contracts';
import { z } from 'zod';

import { serverApi, sessionApi } from '../../../../../lib/api/server';
import {
  addComment,
  confirmUpload,
  evidenceLink,
  loadAudit,
  loadDrawer,
  loadEvidence,
  outcome,
  removeEvidence,
  runAction,
  startUpload,
  type AuditPage,
  type DrawerData,
  type Outcome,
  type WorkflowAction,
} from './_lib/instance-api';

const Action = z.discriminatedUnion('kind', [
  SubmitBody.extend({ kind: z.literal('SUBMIT') }),
  RequestNaBody.extend({ kind: z.literal('REQUEST_NA') }),
  ApproveBody.extend({ kind: z.literal('APPROVE') }),
  SendBackBody.extend({ kind: z.literal('SEND_BACK') }),
  ReopenBody.extend({ kind: z.literal('REOPEN') }),
]);

export async function loadInstanceDrawer(id: string): Promise<Outcome<DrawerData>> {
  const api = await serverApi();
  return outcome(() => loadDrawer(api, Id.parse(id)));
}

export async function loadMoreHistory(id: string, cursor: string): Promise<Outcome<AuditPage>> {
  const api = await serverApi();
  return outcome(() => loadAudit(api, Id.parse(id), Cursor.parse(cursor)));
}

export async function reloadEvidence(id: string): Promise<Outcome<EvidenceView[]>> {
  const api = await serverApi();
  return outcome(() => loadEvidence(api, Id.parse(id)));
}

/** Submit, ask for NA, approve, send back or reopen, at the version the person saw. */
export async function runInstanceAction(
  id: string,
  action: WorkflowAction,
): Promise<Outcome<InstanceDetail>> {
  const api = await sessionApi();
  return outcome(() => runAction(api, Id.parse(id), Action.parse(action)));
}

export async function postComment(id: string, body: string): Promise<Outcome<Comment>> {
  const api = await sessionApi();
  return outcome(() => addComment(api, Id.parse(id), CommentCreateBody.parse({ body }).body));
}

/** Where to PUT one evidence file. The browser sends the bytes straight to storage, never through this server. */
export async function startEvidenceUpload(
  id: string,
  file: { fileName: string; mimeType: string; sizeBytes: number },
): Promise<Outcome<UploadTicket>> {
  const api = await sessionApi();
  return outcome(() => startUpload(api, Id.parse(id), EvidenceUploadUrlBody.parse(file)));
}

export async function confirmEvidenceUpload(
  id: string,
  upload: { uploadId: string; fileName: string; sha256: string },
): Promise<Outcome<EvidenceView>> {
  const api = await sessionApi();
  return outcome(() => confirmUpload(api, Id.parse(id), EvidenceConfirmBody.parse(upload)));
}

/** A 5-minute link to one file; the drawer opens it at once and keeps it nowhere. */
export async function evidenceDownload(evidenceId: string): Promise<Outcome<string>> {
  const api = await serverApi();
  return outcome(() => evidenceLink(api, Id.parse(evidenceId)));
}

export async function removeEvidenceFile(
  evidenceId: string,
  reason: string,
): Promise<Outcome<EvidenceView>> {
  const api = await sessionApi();
  return outcome(() =>
    removeEvidence(api, Id.parse(evidenceId), EvidenceRemoveBody.parse({ reason }).reason),
  );
}

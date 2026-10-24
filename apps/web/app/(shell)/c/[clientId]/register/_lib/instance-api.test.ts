// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk.
import { InstanceRow, type InstanceDetail } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError, createApiClient, type ApiClient } from '../../../../../../lib/api/client';
import {
  MOCK_CLIENTS,
  MOCK_MFA_CODE,
  MOCK_PASSWORD,
  mockFetch,
} from '../../../../../../lib/api/mock';
import {
  addComment,
  AUDIT_PAGE,
  confirmUpload,
  errorMessage,
  evidenceLink,
  loadAudit,
  loadDrawer,
  loadEvidence,
  outcome,
  removeEvidence,
  rowOf,
  runAction,
  sha256Hex,
  startUpload,
  uploadHasNoHost,
} from './instance-api';
import { loadPage } from './register-api';

const CLIENT = MOCK_CLIENTS.demoMetals;
const api = (cookie?: string, csrfToken?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie, csrfToken });

async function as(email: string, mfa = false): Promise<ApiClient> {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  const { data } = await api(cookie).me();
  return api(cookie, data.csrfToken);
}

/** The first instance in the query whose detail passes `pick`, as this person sees it. */
async function find(
  who: ApiClient,
  query: string,
  pick: (d: InstanceDetail) => boolean,
): Promise<InstanceDetail> {
  const page = await loadPage(who, CLIENT, query);
  for (const row of page.rows) {
    const { data } = await who.call('getInstance', { params: { id: row.id } });
    if (pick(data)) return data;
  }
  throw new Error(`No instance for ${query}`);
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).buffer as ArrayBuffer;

describe('loadDrawer', () => {
  it('loads the instance with its evidence, comments, history and the names to show', async () => {
    const consultant = await as('consultant@demo.test', true);
    const [row] = (await loadPage(consultant, CLIENT, 'sort=dueDate')).rows;
    const data = await loadDrawer(consultant, row!.id);
    expect(data.detail.id).toBe(row!.id);
    expect(Array.isArray(data.evidence)).toBe(true);
    expect(Array.isArray(data.comments)).toBe(true);
    expect(data.audit.events.length).toBeLessThanOrEqual(AUDIT_PAGE);
    expect(data.names[data.detail.ownerId]).toBe(data.detail.ownerName);
    expect(data.names[data.detail.approverId]).toBe(data.detail.approverName);
  });

  it('throws the API’s error for an instance the person can’t see', async () => {
    const owner = await as('owner@demo.test');
    await expect(loadDrawer(owner, '00000000-0000-5000-8000-0000000fffff')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('still loads when the people list fails, naming only the owner and approver', async () => {
    const consultant = await as('consultant@demo.test', true);
    const [row] = (await loadPage(consultant, CLIENT, 'sort=dueDate')).rows;
    const flaky: Pick<ApiClient, 'call'> = {
      call: ((name: Parameters<ApiClient['call']>[0], request: never) =>
        name === 'listClientPeople'
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'down'))
          : consultant.call(name, request)) as ApiClient['call'],
    };
    const data = await loadDrawer(flaky, row!.id);
    expect(Object.keys(data.names).sort()).toEqual(
      [data.detail.ownerId, data.detail.approverId].sort(),
    );
  });
});

describe('the owner’s journey: evidence, submit, comments', () => {
  it('needs clean evidence to submit, then submits at the version seen', async () => {
    const owner = await as('owner@demo.test');
    const detail = await find(
      owner,
      'ownerId=me&workflowState=OPEN&sort=dueDate',
      (d) => d.evidenceRequired && d.allowedActions.includes('SUBMIT'),
    );
    const submit = (version: number) =>
      outcome(() =>
        runAction(owner, detail.id, {
          kind: 'SUBMIT',
          version,
          completedOn: detail.dueDate,
          comment: 'Filed the return.',
        }),
      );

    const before = await loadEvidence(owner, detail.id);
    if (!before.some((e) => e.scanStatus === 'CLEAN')) {
      expect(await submit(detail.version)).toMatchObject({ ok: false, code: 'EVIDENCE_REQUIRED' });
    }

    const content = bytes('%PDF-1.4 demo challan');
    const ticket = await startUpload(owner, detail.id, {
      fileName: 'challan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: content.byteLength,
    });
    expect(uploadHasNoHost(ticket.url)).toBe(true);
    const added = await confirmUpload(owner, detail.id, {
      uploadId: ticket.uploadId,
      fileName: 'challan.pdf',
      sha256: await sha256Hex(content),
    });
    expect(added.scanStatus).toBe('PENDING');
    const after = await loadEvidence(owner, detail.id);
    expect(after.find((e) => e.id === added.id)?.scanStatus).toBe('CLEAN');
    expect(await evidenceLink(owner, added.id)).toMatch(/^https:\/\//);

    const done = await submit(detail.version);
    expect(done).toMatchObject({ ok: true, data: { workflowState: 'SUBMITTED' } });
    // The same version again is out of date.
    expect(await submit(detail.version)).toMatchObject({ ok: false, code: 'STALE_VERSION' });

    const history = await loadAudit(owner, detail.id);
    expect(history.events.some((e) => e.action === 'TRANSITION')).toBe(true);
    expect(history.events.some((e) => e.action === 'EVIDENCE_ADD')).toBe(true);
  });

  it('comments, removes evidence with a reason, and asks for not applicable', async () => {
    const owner = await as('owner@demo.test');
    const detail = await find(owner, 'ownerId=me&workflowState=OPEN&sort=dueDate', (d) =>
      d.allowedActions.includes('REQUEST_NA'),
    );
    const note = await addComment(owner, detail.id, 'Waiting on the bank’s receipt.');
    expect(note).toMatchObject({ kind: 'NOTE', body: 'Waiting on the bank’s receipt.' });

    const content = bytes('wrong file');
    const ticket = await startUpload(owner, detail.id, {
      fileName: 'wrong.txt',
      mimeType: 'text/plain',
      sizeBytes: content.byteLength,
    });
    const added = await confirmUpload(owner, detail.id, {
      uploadId: ticket.uploadId,
      fileName: 'wrong.txt',
      sha256: await sha256Hex(content),
    });
    const removed = await removeEvidence(owner, added.id, 'Attached the wrong file.');
    expect(removed.archivedAt).not.toBeNull();
    expect((await loadEvidence(owner, detail.id)).some((e) => e.id === added.id)).toBe(false);

    const na = await runAction(owner, detail.id, {
      kind: 'REQUEST_NA',
      version: detail.version,
      reason: 'The unit has no boilers.',
    });
    expect(na).toMatchObject({ workflowState: 'SUBMITTED', pendingKind: 'NA' });
  });
});

describe('the approver’s actions', () => {
  it('sends one back with a reason and approves another', async () => {
    const approver = await as('approver@demo.test');
    const page = await loadPage(approver, CLIENT, 'workflowState=SUBMITTED&sort=dueDate');
    const waiting: InstanceDetail[] = [];
    for (const row of page.rows) {
      const { data } = await approver.call('getInstance', { params: { id: row.id } });
      if (data.allowedActions.includes('APPROVE')) waiting.push(data);
      if (waiting.length === 2) break;
    }
    expect(waiting).toHaveLength(2);
    const [first, second] = waiting as [InstanceDetail, InstanceDetail];

    const back = await runAction(approver, first.id, {
      kind: 'SEND_BACK',
      version: first.version,
      reason: 'The challan is for the wrong month.',
    });
    expect(back.workflowState).toBe('SENT_BACK');
    const approved = await runAction(approver, second.id, {
      kind: 'APPROVE',
      version: second.version,
    });
    expect(['APPROVED', 'NOT_APPLICABLE']).toContain(approved.workflowState);
    expect(approved.allowedActions).not.toContain('APPROVE');
  });

  it('approves with a comment, and a consultant reopens it with a reason', async () => {
    const approver = await as('approver@demo.test');
    const detail = await find(approver, 'workflowState=SUBMITTED&sort=dueDate', (d) =>
      d.allowedActions.includes('APPROVE'),
    );
    const approved = await runAction(approver, detail.id, {
      kind: 'APPROVE',
      version: detail.version,
      comment: 'Checked against the bank statement.',
    });
    const consultant = await as('consultant@demo.test', true);
    const { data: seen } = await consultant.call('getInstance', { params: { id: detail.id } });
    expect(seen.allowedActions).toContain('REOPEN');
    const reopened = await runAction(consultant, detail.id, {
      kind: 'REOPEN',
      version: approved.version,
      reason: 'The challan was for another unit.',
    });
    expect(reopened.workflowState).toBe('OPEN');
  });
});

describe('helpers', () => {
  it('hashes bytes as lower-case hex SHA-256', async () => {
    expect(await sha256Hex(bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('skips the PUT only for a host that can never resolve', () => {
    expect(uploadHasNoHost('https://files.mock.invalid/uploads/1')).toBe(true);
    expect(uploadHasNoHost('https://storage.example.com/evidence/1?sig=x')).toBe(false);
    expect(uploadHasNoHost('https://invalid.example.com/x')).toBe(false);
  });

  it('keeps exactly the register row’s fields of a detail', async () => {
    const consultant = await as('consultant@demo.test', true);
    const [row] = (await loadPage(consultant, CLIENT, 'sort=dueDate')).rows;
    const { data } = await consultant.call('getInstance', { params: { id: row!.id } });
    const back = rowOf(data);
    expect(InstanceRow.parse(back)).toEqual(back);
    expect(back).toEqual(row);
  });

  it('words every error the drawer can meet, and a generic line for the rest', () => {
    for (const code of [
      'STALE_VERSION',
      'INVALID_TRANSITION',
      'EVIDENCE_REQUIRED',
      'EVIDENCE_NOT_READY',
      'DATE_IN_FUTURE',
      'REASON_REQUIRED',
      'FILE_TOO_LARGE',
      'UNSUPPORTED_FILE',
      'FORBIDDEN',
      'VALIDATION',
    ] as const) {
      expect(errorMessage(code)).not.toBe(errorMessage('UNKNOWN'));
    }
    expect(errorMessage('NOT_FOUND')).toBe(errorMessage('FORBIDDEN'));
    expect(errorMessage('INTERNAL')).toBe('That didn’t go through. Try again.');
  });

  it('turns API errors into outcomes and lets anything else throw', async () => {
    await expect(
      outcome(() => Promise.reject(new ApiError(409, 'STALE_VERSION', 'x'))),
    ).resolves.toEqual({
      ok: false,
      code: 'STALE_VERSION',
      message: errorMessage('STALE_VERSION'),
    });
    await expect(outcome(() => Promise.reject(new TypeError('bug')))).rejects.toThrow('bug');
    await expect(outcome(async () => 3)).resolves.toEqual({ ok: true, data: 3 });
  });
});

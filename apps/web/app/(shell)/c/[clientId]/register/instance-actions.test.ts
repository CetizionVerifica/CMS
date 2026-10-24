// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_CLIENTS, MOCK_MFA_CODE, MOCK_PASSWORD } from '../../../../../lib/api/mock';
import { createApiClient } from '../../../../../lib/api/client';
import { mockFetch } from '../../../../../lib/api/mock';
import {
  nextHeaders,
  nextNavigation,
  request,
  resetRequest,
} from '../../../../../lib/test/next-mocks';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => nextHeaders);
vi.mock('next/navigation', () => nextNavigation);

const actions = await import('./instance-actions');

const CLIENT = MOCK_CLIENTS.demoMetals;
const ID = '00000000-0000-5000-8000-000000000301';
const api = (cookie?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });

async function signIn(email: string, mfa = false) {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  const [name, value] = cookie.split('=') as [string, string];
  request.cookies.set(name, decodeURIComponent(value));
  return api(cookie);
}

beforeEach(() => resetRequest());

describe('instance drawer actions', () => {
  it('refuses arguments that aren’t what the drawer sends', async () => {
    await signIn('owner@demo.test');
    await expect(actions.loadInstanceDrawer('../x')).rejects.toThrow();
    await expect(actions.loadMoreHistory(ID, '')).rejects.toThrow();
    await expect(actions.reloadEvidence('nope')).rejects.toThrow();
    await expect(
      actions.runInstanceAction(ID, {
        kind: 'SUBMIT',
        version: 1,
        completedOn: '15/11/2024',
        comment: 'x',
      }),
    ).rejects.toThrow();
    await expect(actions.runInstanceAction(ID, { kind: 'SUBMIT' } as never)).rejects.toThrow();
    await expect(
      actions.runInstanceAction(ID, { kind: 'SEND_BACK', version: 1, reason: '  ' }),
    ).rejects.toThrow();
    await expect(
      actions.runInstanceAction(ID, { kind: 'DELETE', version: 1 } as never),
    ).rejects.toThrow();
    await expect(actions.postComment(ID, '')).rejects.toThrow();
    await expect(
      actions.startEvidenceUpload(ID, {
        fileName: 'virus.exe',
        mimeType: 'application/x-msdownload',
        sizeBytes: 10,
      }),
    ).rejects.toThrow();
    await expect(
      actions.startEvidenceUpload(ID, {
        fileName: 'big.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 26 * 1024 * 1024,
      }),
    ).rejects.toThrow();
    await expect(
      actions.confirmEvidenceUpload(ID, { uploadId: ID, fileName: 'a.pdf', sha256: 'ABC' }),
    ).rejects.toThrow();
    await expect(actions.evidenceDownload('x')).rejects.toThrow();
    await expect(actions.removeEvidenceFile(ID, '')).rejects.toThrow();
  });

  it('loads, comments and answers an API refusal as an outcome, as the signed-in person', async () => {
    const owner = await signIn('owner@demo.test');
    const { data } = await owner.call('listInstances', {
      params: { clientId: CLIENT },
      query: { ownerId: 'me', workflowState: 'OPEN', limit: '1' },
    });
    const id = data.items[0]!.id;

    const loaded = await actions.loadInstanceDrawer(id);
    expect(loaded).toMatchObject({ ok: true, data: { detail: { id } } });
    expect(await actions.loadInstanceDrawer('00000000-0000-5000-8000-0000000fffff')).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });

    // Comments are state-changing, so they go with the session's CSRF token.
    expect(await actions.postComment(id, 'Looking into it.')).toMatchObject({
      ok: true,
      data: { body: 'Looking into it.' },
    });
    expect(await actions.reloadEvidence(id)).toMatchObject({ ok: true });

    // An owner can't approve: the API says so, and the drawer gets words, not a thrown error.
    expect(await actions.runInstanceAction(id, { kind: 'APPROVE', version: 1 })).toMatchObject({
      ok: false,
    });
    const history = await actions.loadInstanceDrawer(id);
    if (history.ok && history.data.audit.nextCursor) {
      expect(await actions.loadMoreHistory(id, history.data.audit.nextCursor)).toMatchObject({
        ok: true,
      });
    }
  });

  it('runs an upload end to end and removes the file with a reason', async () => {
    const consultant = await signIn('consultant@demo.test', true);
    const { data } = await consultant.call('listInstances', {
      params: { clientId: CLIENT },
      query: { workflowState: 'OPEN', limit: '1' },
    });
    const id = data.items[0]!.id;
    const ticket = await actions.startEvidenceUpload(id, {
      fileName: 'register.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: 100,
    });
    expect(ticket.ok).toBe(true);
    if (!ticket.ok) return;
    const confirmed = await actions.confirmEvidenceUpload(id, {
      uploadId: ticket.data.uploadId,
      fileName: 'register.xlsx',
      sha256: 'a'.repeat(64),
    });
    expect(confirmed).toMatchObject({ ok: true, data: { scanStatus: 'PENDING' } });
    if (!confirmed.ok) return;
    await actions.reloadEvidence(id);
    expect(await actions.evidenceDownload(confirmed.data.id)).toMatchObject({ ok: true });
    expect(await actions.removeEvidenceFile(confirmed.data.id, 'Duplicate')).toMatchObject({
      ok: true,
    });
  });
});

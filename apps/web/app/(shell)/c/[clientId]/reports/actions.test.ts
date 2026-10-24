// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../../lib/api/client';

const call = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('../../../../../lib/api/server', () => ({ sessionApi: async () => ({ call }) }));
const redirectIfSignedOut = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../overview/signed-out', () => ({ redirectIfSignedOut }));

const { exportProgressAction, startExportAction } = await import('./actions');

const CLIENT = '00000000-0000-5000-8000-000000000101';
const EXPORT = '00000000-0000-5000-8000-000000000999';
const refusal = (status: number, code: ConstructorParameters<typeof ApiError>[1]) =>
  new ApiError(status, code, 'refused', undefined, 'mock');

describe('startExportAction', () => {
  it('starts the export for the financial year', async () => {
    call.mockResolvedValueOnce({ data: { id: EXPORT } });
    expect(await startExportAction(CLIENT, 'ACT_REPORT_XLSX', '2024-25')).toEqual({
      ok: true,
      id: EXPORT,
    });
    expect(call).toHaveBeenLastCalledWith('createExport', {
      params: { clientId: CLIENT },
      body: { kind: 'ACT_REPORT_XLSX', fy: '2024-25' },
    });
    call.mockResolvedValueOnce({ data: { id: EXPORT } });
    await startExportAction(CLIENT, 'CERTIFICATE_PDF', null);
    expect(call).toHaveBeenLastCalledWith('createExport', {
      params: { clientId: CLIENT },
      body: { kind: 'CERTIFICATE_PDF' },
    });
  });

  it('refuses input that is not a kind or an FY before calling the API', async () => {
    call.mockReset();
    const notStarted = { ok: false, message: 'The download didn’t start. Try again.' };
    expect(await startExportAction(CLIENT, 'EVERYTHING', null)).toEqual(notStarted);
    expect(await startExportAction(CLIENT, 'ACT_REPORT_XLSX', '2024-26')).toEqual(notStarted);
    expect((await exportProgressAction('not-an-id')).status).toBe('failed');
    expect(call).not.toHaveBeenCalled();
  });

  it('sends an expired sign-in to the login steps', async () => {
    redirectIfSignedOut.mockClear();
    const expired = refusal(401, 'UNAUTHENTICATED');
    call.mockRejectedValueOnce(expired).mockRejectedValueOnce(expired);
    await startExportAction(CLIENT, 'ACT_REPORT_XLSX', null);
    await exportProgressAction(EXPORT);
    expect(redirectIfSignedOut).toHaveBeenCalledWith(expired);
    expect(redirectIfSignedOut).toHaveBeenCalledTimes(2);
  });

  it('says why an export was refused', async () => {
    call.mockRejectedValueOnce(refusal(403, 'FORBIDDEN'));
    expect(await startExportAction(CLIENT, 'ACT_REPORT_XLSX', null)).toEqual({
      ok: false,
      message: 'You can’t download reports for this client.',
    });
    call.mockRejectedValueOnce(refusal(429, 'RATE_LIMITED'));
    expect((await startExportAction(CLIENT, 'ACT_REPORT_XLSX', null)).ok).toBe(false);
    call.mockRejectedValueOnce(new Error('boom'));
    expect(await startExportAction(CLIENT, 'ACT_REPORT_XLSX', null)).toEqual({
      ok: false,
      message: 'The download didn’t start. Try again.',
    });
  });
});

describe('exportProgressAction', () => {
  it('reports a pending, failed or finished export', async () => {
    call.mockResolvedValueOnce({ data: { status: 'RUNNING' } });
    expect(await exportProgressAction(EXPORT)).toEqual({ status: 'pending' });
    call.mockResolvedValueOnce({ data: { status: 'FAILED' } });
    expect((await exportProgressAction(EXPORT)).status).toBe('failed');
    call
      .mockResolvedValueOnce({ data: { status: 'DONE' } })
      .mockResolvedValueOnce({ data: { url: 'https://files.example/e' } });
    expect(await exportProgressAction(EXPORT)).toEqual({
      status: 'ready',
      url: 'https://files.example/e',
    });
    call.mockRejectedValueOnce(refusal(403, 'ACCESS_EXPIRED'));
    expect(await exportProgressAction(EXPORT)).toEqual({
      status: 'failed',
      message: 'You can’t download reports for this client.',
    });
  });
});

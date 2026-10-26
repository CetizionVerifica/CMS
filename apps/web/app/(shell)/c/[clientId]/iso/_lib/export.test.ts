// @vitest-environment node
// The ISO download actions, run as on the server against the web app's mock API (M0's mock).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  nextHeaders,
  nextNavigation,
  RedirectError,
  resetRequest,
} from '../../../../../../lib/test/next-mocks';
import { CLIENT } from '../_test/iso-data';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => nextHeaders);
vi.mock('next/navigation', () => nextNavigation);

const { relayCookies, serverApi, sessionApi } = await import('../../../../../../lib/api/server');
const { isoExportProgress, startIsoExport } = await import('./export');

async function signIn(email: string) {
  await relayCookies(
    (await (await serverApi()).login({ email, password: 'demo-password' })).setCookies,
  );
  if (['consultant@demo.test', 'company@demo.test'].includes(email)) {
    await relayCookies((await (await sessionApi()).verifyMfa('123456')).setCookies);
  }
}

beforeEach(() => {
  resetRequest();
});

describe('startIsoExport and isoExportProgress', () => {
  it('starts the risk register export with its filters and hands back its link when done', async () => {
    await signIn('consultant@demo.test');
    const started = await startIsoExport(CLIENT, 'ISO_RISK_REGISTER_XLSX', 'significant=true');
    if (!started.ok) throw new Error(started.message);
    let progress = await isoExportProgress(started.id);
    for (let i = 0; i < 5 && progress.status === 'pending'; i++) {
      progress = await isoExportProgress(started.id);
    }
    expect(progress.status).toBe('ready');
    if (progress.status === 'ready') expect(progress.url).toMatch(/^https?:\/\//);
  });

  it('refuses a kind that is not an ISO export, or filters its list does not take', async () => {
    await signIn('consultant@demo.test');
    expect(await startIsoExport(CLIENT, 'REGISTER_XLSX', '')).toEqual({
      ok: false,
      message: 'The download didn’t start. Try again.',
    });
    expect((await startIsoExport(CLIENT, 'ISO_RISK_REGISTER_XLSX', 'ids=a')).ok).toBe(false);
    expect(await isoExportProgress('not-an-id')).toEqual({
      status: 'failed',
      message: 'The download didn’t start. Try again.',
    });
  });

  it('says the add-on is off for an account without it', async () => {
    await signIn('company@demo.test');
    expect(await startIsoExport(CLIENT, 'ISO_RISK_REGISTER_XLSX', '')).toEqual({
      ok: false,
      message: 'ISO management systems is not turned on for this account.',
    });
  });

  it('sends a signed-out person to sign in', async () => {
    await expect(startIsoExport(CLIENT, 'ISO_RISK_REGISTER_XLSX', '')).rejects.toBeInstanceOf(
      RedirectError,
    );
  });
});

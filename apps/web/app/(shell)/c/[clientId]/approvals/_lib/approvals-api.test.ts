// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk.
import { MAX_PAGE_LIMIT } from '@canopy/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createApiClient, type ApiClient } from '../../../../../../lib/api/client';
import {
  MOCK_CLIENTS,
  MOCK_MFA_CODE,
  MOCK_PASSWORD,
  mockFetch,
} from '../../../../../../lib/api/mock';
import { makeRow } from '../../register/_test/rows';
import { approvalsHref, askOf, loadQueue, openApprovalId, taskItem } from './approvals-api';

const CLIENT = MOCK_CLIENTS.demoMetals;
const api = (cookie?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });

async function as(email: string, mfa = false): Promise<ApiClient> {
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (mfa) cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  return api(cookie);
}

describe('loadQueue', () => {
  it('lists what waits for the approver, with the count on the first page', async () => {
    const approver = await as('approver@demo.test');
    const page = await loadQueue(approver, CLIENT, 'mine');
    expect(page.total).toBe(page.rows.length);
    expect(page.rows.length).toBeGreaterThan(0);
    // The demo's people are M0's, whose ids differ from the shell's /me; one approver throughout is what `me` means.
    expect(new Set(page.rows.map((r) => r.workflowState))).toEqual(new Set(['SUBMITTED']));
    expect(new Set(page.rows.map((r) => r.approverId)).size).toBe(1);
  });

  it('lists everything waiting in the client for the client scope, oldest due date first', async () => {
    const consultant = await as('consultant@demo.test', true);
    const page = await loadQueue(consultant, CLIENT, 'client');
    expect(page.rows.length).toBeGreaterThan(1);
    expect(new Set(page.rows.map((r) => r.workflowState))).toEqual(new Set(['SUBMITTED']));
    const dues = page.rows.map((r) => r.dueDate);
    expect(dues).toEqual([...dues].sort());
  });

  it('asks for exactly the queue: SUBMITTED, the person’s own unless client-wide, by due date', async () => {
    const call = vi.fn(async () => ({ data: { items: [], nextCursor: null } }));
    await loadQueue({ call } as never, CLIENT, 'mine');
    await loadQueue({ call } as never, CLIENT, 'client', 'next');
    expect(call).toHaveBeenNthCalledWith(1, 'listInstances', {
      params: { clientId: CLIENT },
      query: {
        workflowState: 'SUBMITTED',
        approverId: 'me',
        sort: 'dueDate',
        limit: String(MAX_PAGE_LIMIT),
        count: 'true',
      },
    });
    expect(call).toHaveBeenNthCalledWith(2, 'listInstances', {
      params: { clientId: CLIENT },
      query: {
        workflowState: 'SUBMITTED',
        sort: 'dueDate',
        limit: String(MAX_PAGE_LIMIT),
        cursor: 'next',
      },
    });
  });

  it('narrows to the statutory work or the ISO activities when given a source', async () => {
    const call = vi.fn(async () => ({ data: { items: [], nextCursor: null } }));
    await loadQueue({ call } as never, CLIENT, 'client', undefined, 'ISO');
    expect(call).toHaveBeenCalledWith('listInstances', {
      params: { clientId: CLIENT },
      query: {
        workflowState: 'SUBMITTED',
        source: 'ISO',
        sort: 'dueDate',
        limit: String(MAX_PAGE_LIMIT),
        count: 'true',
      },
    });
    // Against the demo, whose consultant's account has the add-on: Law and ISO split the queue between them.
    const consultant = await as('consultant@demo.test', true);
    const all = (await loadQueue(consultant, CLIENT, 'client')).total!;
    const law = (await loadQueue(consultant, CLIENT, 'client', undefined, 'LAW')).total!;
    const iso = (await loadQueue(consultant, CLIENT, 'client', undefined, 'ISO')).total!;
    expect(law + iso).toBe(all);
    expect(law).toBeGreaterThan(0);
  });
});

describe('rows', () => {
  it('says what each row asks for, and links it to the drawer over the inbox', () => {
    const done = makeRow(1, {
      workflowState: 'SUBMITTED',
      pendingKind: 'COMPLETION',
      status: 'SUBMITTED',
    });
    const na = makeRow(2, {
      workflowState: 'SUBMITTED',
      pendingKind: 'NA',
      status: 'OVERDUE',
      overdueDays: 4,
    });
    expect(askOf(done)).toBe('marked done');
    expect(askOf(na)).toBe('asks to mark not applicable');
    expect(taskItem(CLIENT, done)).toEqual({
      id: done.id,
      title: 'Obligation 1',
      meta: 'Act 1 · Plant 01 · Owner 01 marked done',
      dueDate: done.dueDate,
      status: 'SUBMITTED',
      href: `/c/${CLIENT}/approvals/${done.id}`,
    });
    expect(taskItem(CLIENT, na)).toMatchObject({ status: 'OVERDUE', days: 4 });
  });

  it('keeps the page’s Source filter on the inbox and drawer paths', () => {
    expect(approvalsHref(CLIENT, undefined, 'source=ISO')).toBe(
      `/c/${CLIENT}/approvals?source=ISO`,
    );
    expect(approvalsHref(CLIENT, 'i1', 'source=LAW')).toBe(`/c/${CLIENT}/approvals/i1?source=LAW`);
    const row = taskItem(CLIENT, { ...makeRow(3), id: 'i2' }, 'source=ISO');
    expect(row.href).toBe(`/c/${CLIENT}/approvals/i2?source=ISO`);
  });

  it('reads the open instance from the path', () => {
    expect(approvalsHref(CLIENT)).toBe(`/c/${CLIENT}/approvals`);
    expect(openApprovalId(`/c/${CLIENT}/approvals`)).toBeNull();
    expect(openApprovalId(`/c/${CLIENT}/approvals/abc`)).toBe('abc');
    expect(openApprovalId(`/c/${CLIENT}/approvals/a%20b/`)).toBe('a b');
    expect(openApprovalId(`/c/${CLIENT}/register/abc`)).toBeNull();
  });
});

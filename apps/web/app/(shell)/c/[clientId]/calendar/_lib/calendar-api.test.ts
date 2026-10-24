// @vitest-environment node
// Node, as on the server: M0's mock server (behind lib/api/mock.ts) reads its fixtures from disk.
import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../../../../../lib/api/client';
import {
  MOCK_CLIENTS,
  MOCK_MFA_CODE,
  MOCK_PASSWORD,
  mockFetch,
} from '../../../../../../lib/api/mock';
import { loadMonth } from './calendar-api';

const CLIENT = MOCK_CLIENTS.demoMetals;
const api = (cookie?: string) =>
  createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });

describe('loadMonth', () => {
  it('asks for the month’s first to last day', async () => {
    const call = vi.fn(async () => ({ data: { items: [] } }));
    expect(await loadMonth({ call } as never, CLIENT, '2024-02')).toEqual({});
    expect(call).toHaveBeenCalledWith('calendar', {
      params: { clientId: CLIENT },
      query: { from: '2024-02-01', to: '2024-02-29' },
    });
  });

  it('groups the demo client’s due instances by their due date', async () => {
    const { setCookies } = await api().login({
      email: 'consultant@demo.test',
      password: MOCK_PASSWORD,
    });
    let cookie = setCookies[0]!.split(';')[0]!;
    cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
    const due = await loadMonth(api(cookie), CLIENT, '2023-06');
    const days = Object.keys(due);
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) {
      expect(day.startsWith('2023-06')).toBe(true);
      for (const row of due[day]!) expect(row.dueDate).toBe(day);
    }
  });
});

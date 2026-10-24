// @vitest-environment node
// The demo API has no client admin to sign in as, so this checks the request itself: reminders go out alone, which
// is the one settings change a client admin may make (endpoints.md §3, PUT /clients/{clientId}/settings).
import { describe, expect, it, vi } from 'vitest';

const call = vi.hoisted(() => vi.fn(async () => ({ data: {} })));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../../../../lib/api/server', () => ({ sessionApi: async () => ({ call }) }));

const { saveRemindersAction } = await import('./actions');

const CLIENT = '00000000-0000-5000-8000-000000000101';

describe('saveRemindersAction', () => {
  it('sends only the reminders and the version', async () => {
    const reminders = {
      ownerDaysBefore: [3],
      approverDaysAfter: [],
      sendAtLocalTime: '07:45',
      consultantDigestWeekday: 2,
    };
    expect(await saveRemindersAction(CLIENT, { version: 3, reminders })).toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith('putClientSettings', {
      params: { clientId: CLIENT },
      body: { version: 3, reminders },
    });
  });
});

// The calendar's call to the API: what falls due in a month, by day. A plain function of an API client, so the tests can
// run it against the in-process mock.
import type { InstanceRow } from '@canopy/contracts';

import type { ApiClient } from '../../../../../../lib/api/client';
import { monthRange, type Month } from './month';

/** Due instances by date ("YYYY-MM-DD"), as the API groups them. */
export type MonthDue = Record<string, InstanceRow[]>;

export async function loadMonth(
  api: Pick<ApiClient, 'call'>,
  clientId: string,
  month: Month,
): Promise<MonthDue> {
  const { data } = await api.call('calendar', {
    params: { clientId },
    query: monthRange(month),
  });
  return Object.fromEntries(data.items.map((day) => [day.date, day.items]));
}

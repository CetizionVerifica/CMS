// The calendar's call to the API: what falls due in a month, by day. A plain function of an API client, so the tests can
// run it against the in-process mock.
import type { ActivitySource, InstanceRow } from '@canopy/contracts';

import type { ApiClient } from '../../../../../../lib/api/client';
import { monthRange, type Month } from './month';

/** Due instances by date ("YYYY-MM-DD"), as the API groups them. */
export type MonthDue = Record<string, InstanceRow[]>;

/** `source` narrows the month to the statutory work or the ISO activities (passed only with the ISO add-on). */
export async function loadMonth(
  api: Pick<ApiClient, 'call'>,
  clientId: string,
  month: Month,
  source?: ActivitySource,
): Promise<MonthDue> {
  const { data } = await api.call('calendar', {
    params: { clientId },
    query: { ...monthRange(month), ...(source ? { source } : {}) },
  });
  return Object.fromEntries(data.items.map((day) => [day.date, day.items]));
}

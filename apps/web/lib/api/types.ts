// The one response shape the shell needs that contracts v1.1 doesn't carry yet: per-client context for the client
// switcher and the period picker. Which period is current comes from the engine, through the API, so the web app does
// no FY maths (root rule 3). Requested from M0 as an extension of `ClientSummary`; replace `ShellMe` with the
// contract's `Me` when it lands.
import { ClientSummary, FyLabel, Me, Month, TimeZone } from '@canopy/contracts';
import { z } from 'zod';

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');

export const ClientPeriodContext = z.strictObject({
  /** The quarter containing today in the client's time zone, from the engine. */
  current: z.strictObject({
    fy: FyLabel,
    quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  }),
  /** First FY with instances to the next one. */
  availableFys: z.array(FyLabel).min(1),
  /** Last month with generated instances, or null when none are generated yet. */
  availableUntil: YearMonth.nullable(),
});
export type ClientPeriodContext = z.infer<typeof ClientPeriodContext>;

export const ShellClientSummary = ClientSummary.extend({
  fyStartMonth: Month,
  timeZone: TimeZone,
  unitCount: z.int().min(0),
  period: ClientPeriodContext,
});
export type ShellClientSummary = z.infer<typeof ShellClientSummary>;

/** `GET /me` with the per-client context above. */
export const ShellMe = Me.extend({ clients: z.array(ShellClientSummary) });
export type ShellMe = z.infer<typeof ShellMe>;

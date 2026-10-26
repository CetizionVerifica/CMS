// The Source filter (docs/iso/plan.md §4.6): `source=LAW` lists the statutory work (STATUTE acts), `source=ISO` the ISO
// activities (STANDARD acts), and no `source` lists both. The register, approvals, calendar and evidence vault keep it
// in the URL under the API's own name. It exists only while the account has the ISO add-on: without it the filter is
// not shown and a `source` left in a URL is ignored, since the API returns statutory work only anyway (plan §4.4).
import { ActivitySource } from '@canopy/contracts';

export const SOURCE_PARAM = 'source';

/** The add-on that brings the filter (`ShellModel.features`). */
export const ISO_FEATURE = 'isoManagement';

/** The filter's choices, in this order, with the words the screens use. */
export const SOURCE_OPTIONS: readonly { value: ActivitySource; label: string }[] = [
  { value: 'LAW', label: 'Law' },
  { value: 'ISO', label: 'ISO' },
];

export const isoOn = (features: readonly string[]): boolean => features.includes(ISO_FEATURE);

type Params = { get(name: string): string | null };

/** The URL's source when the add-on is on and the value is one the API takes; otherwise none (both, or no ISO). */
export function sourceFromParams(params: Params, iso: boolean): ActivitySource | undefined {
  if (!iso) return undefined;
  const parsed = ActivitySource.safeParse(params.get(SOURCE_PARAM));
  return parsed.success ? parsed.data : undefined;
}

/** Writes a source into a copy of the URL; `undefined` (both) removes it, so plain links stay short. */
export function withSource(
  search: string | URLSearchParams,
  source: ActivitySource | undefined,
): URLSearchParams {
  const next = new URLSearchParams(search);
  if (source) next.set(SOURCE_PARAM, source);
  else next.delete(SOURCE_PARAM);
  return next;
}

/**
 * A FilterBar multi-select's ticks as a source: one ticked is that source; none or both ticked is both, which the URL
 * leaves out.
 */
export function sourceOfTicks(ticked: readonly string[] | undefined): ActivitySource | undefined {
  if (!ticked || ticked.length !== 1) return undefined;
  const parsed = ActivitySource.safeParse(ticked[0]);
  return parsed.success ? parsed.data : undefined;
}

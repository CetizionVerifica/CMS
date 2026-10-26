'use client';
// Filters of an ISO list, kept in the URL (apps/web/CLAUDE.md "Filters ... live in the URL"), so a filtered view can be
// shared and the back button works. A change drops `ids`, the exact list an overview number links to.
import { FilterBar, type FilterDef, type FilterValue } from '@canopy/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** The path with `changes` applied to its query: a list joins with commas, an empty value removes the key. */
export function withParams(
  pathname: string,
  params: URLSearchParams,
  changes: Record<string, string | string[] | undefined>,
): string {
  const next = new URLSearchParams(params.toString());
  next.delete('ids');
  for (const [key, value] of Object.entries(changes)) {
    const text = Array.isArray(value) ? value.join(',') : value;
    if (text) next.set(key, text);
    else next.delete(key);
  }
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** The path with one key set (or removed) and every other param kept: opens or closes a record over its list. */
export function withOpen(
  pathname: string,
  params: URLSearchParams,
  key: string,
  value?: string,
): string {
  const next = new URLSearchParams(params.toString());
  if (value) next.set(key, value);
  else next.delete(key);
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function IsoFilterBar({
  filters,
  value,
  resultText,
  resultCount,
  search,
}: {
  filters: FilterDef[];
  value: Record<string, string[]>;
  resultText: string;
  resultCount: number;
  search?: { placeholder: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (changes: Record<string, string | string[] | undefined>) =>
    router.push(withParams(pathname, new URLSearchParams(params.toString()), changes));

  const onChange = (next: Record<string, FilterValue>) => {
    const changes: Record<string, string[] | undefined> = {};
    for (const def of filters) {
      const v = next[def.key];
      changes[def.key] = Array.isArray(v) && v.length > 0 ? v : undefined;
    }
    go(changes);
  };

  return (
    <FilterBar
      className="mb-3.5"
      filters={filters}
      value={value}
      onChange={onChange}
      search={
        search
          ? {
              value: params.get('q') ?? '',
              onChange: (text) => go({ q: text.trim() || undefined }),
              placeholder: search.placeholder,
            }
          : undefined
      }
      resultText={resultText}
      resultCount={resultCount}
    />
  );
}

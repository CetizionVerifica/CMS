'use client';
// Search and filters for a library list, kept in the URL (apps/web/CLAUDE.md "Filters ... live in the URL"), so a
// filtered view can be shared and the back button works. Each change restarts paging.
import { FilterBar, type FilterDef, type FilterValue } from '@canopy/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { withParams } from './library-model';

export type LibraryFilterBarProps = {
  filters: FilterDef[];
  value: Record<string, string[]>;
  placeholder: string;
  resultText: string;
  resultCount: number;
};

export function LibraryFilterBar({
  filters,
  value,
  placeholder,
  resultText,
  resultCount,
}: LibraryFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (changes: Record<string, string | string[] | undefined>) =>
    router.push(withParams(pathname, new URLSearchParams(params.toString()), changes));

  // FilterBar waits for a pause in typing before it calls this.
  const onSearch = (text: string) => go({ q: text.trim() || undefined });

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
      search={{ value: params.get('q') ?? '', onChange: onSearch, placeholder }}
      resultText={resultText}
      resultCount={resultCount}
    />
  );
}

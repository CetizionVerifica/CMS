// The two library views. Plain links (a page each), with the current one marked for assistive tech.
import NextLink from 'next/link';

const VIEWS = [
  { href: '/library/acts', label: 'Acts' },
  { href: '/library/obligations', label: 'Obligations' },
] as const;

export function LibraryNav({ current }: { current: 'acts' | 'obligations' }) {
  return (
    <nav aria-label="Library" className="mb-3.5 flex gap-1 border-b border-line">
      {VIEWS.map((view) => {
        const active = view.href.endsWith(current);
        return (
          <NextLink
            key={view.href}
            href={view.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? '-mb-px border-b-2 border-forest px-3 py-2 text-body-strong text-ink'
                : '-mb-px border-b-2 border-transparent px-3 py-2 text-body text-muted hover:text-ink'
            }
          >
            {view.label}
          </NextLink>
        );
      })}
    </nav>
  );
}

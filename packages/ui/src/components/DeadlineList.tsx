import { CalendarDays } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { addDays, parts, weekdayMon0 } from '../lib/calendarDate';
import { cx } from '../lib/cx';
import { devWarn, formatDate, formatNumber, monthShort } from '../lib/format';
import { defaultLink, type LinkRenderer } from '../lib/link';
import { Skeleton } from '../primitives/Skeleton';
import { EmptyState } from './EmptyState';
import { statusLabel, StatusPill, type DerivedStatus } from './StatusPill';

export type DeadlineItem = {
  id: string;
  /** YYYY-MM-DD in the client's time zone. */
  dueDate: string;
  title: string;
  /** Unit or department · owner. */
  meta?: string;
  status?: DerivedStatus;
  days?: number;
  href: string;
};

export type DeadlineListProps = {
  title?: string;
  items: DeadlineItem[];
  /** Default 5; the rest become "+ 12 more". */
  max?: number;
  /**
   * Group into Overdue, This week, Next week and Later, from the API's `today` (never the browser
   * clock). Without `today` the list is not grouped.
   */
  groupBy?: 'week' | 'none';
  today?: string;
  viewAllHref?: string;
  viewAllLabel?: string;
  loading?: boolean;
  renderLink?: LinkRenderer;
  headingLevel?: 2 | 3;
  className?: string;
};

/** Only due-soon and overdue items show a pill, so the list stays calm. */
const showsPill = (s?: DerivedStatus): s is DerivedStatus => s === 'DUE_SOON' || s === 'OVERDUE';

const WEEK_ORDER = ['Overdue', 'This week', 'Next week', 'Later'];
type WeekLabel = 'Overdue' | 'This week' | 'Next week' | 'Later';

function weekGroup(due: string, today: string): WeekLabel {
  // Both are YYYY-MM-DD calendar dates, so string order is date order.
  if (due < today) return 'Overdue';
  const thisMonday = addDays(today, -weekdayMon0(today));
  const nextMonday = addDays(thisMonday, 7);
  const after = addDays(nextMonday, 7);
  if (due < nextMonday) return 'This week';
  if (due < after) return 'Next week';
  return 'Later';
}

/** Spec 12 · DeadlineList. Upcoming due dates for the overview and the calendar side panel. */
export function DeadlineList({
  title = 'Upcoming',
  items,
  max = 5,
  groupBy = 'none',
  today,
  viewAllHref,
  viewAllLabel = 'View calendar',
  loading = false,
  renderLink = defaultLink,
  headingLevel = 2,
  className,
}: DeadlineListProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3';
  const ungrouped = groupBy === 'week' && !today;
  useEffect(() => {
    if (ungrouped)
      devWarn(
        'DeadlineList: groupBy="week" needs `today` from the API; showing the list ungrouped.',
      );
  }, [ungrouped]);
  const shown = items.slice(0, max);
  const more = items.length - shown.length;

  const groups: { label: string | null; items: DeadlineItem[] }[] = [];
  // One group per label, in week order, even when the input is not sorted by due date.
  for (const item of shown) {
    const label = groupBy === 'week' && today ? weekGroup(item.dueDate, today) : null;
    const group = groups.find((g) => g.label === label);
    if (group) group.items.push(item);
    else groups.push({ label, items: [item] });
  }
  groups.sort((a, b) => WEEK_ORDER.indexOf(a.label ?? '') - WEEK_ORDER.indexOf(b.label ?? ''));

  let body: ReactNode;
  if (loading) {
    body = (
      <div aria-busy="true" className="flex flex-col">
        <span className="sr-only">Loading {title.toLowerCase()}</span>
        {[0, 1, 2, 3].map((n) => (
          <div
            key={n}
            className={cx(
              'flex min-h-13 items-center gap-3 py-1.5',
              n > 0 && 'border-t border-line',
            )}
          >
            <Skeleton className="h-11 w-11 rounded-chip" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        variant="done"
        icon={CalendarDays}
        title="Nothing due in this period."
        headingLevel={headingLevel === 2 ? 3 : 4}
        className="p-3"
      />
    );
  } else {
    body = groups.map((g, gi) => (
      <div key={`${g.label}-${gi}`}>
        {g.label ? <p className="pb-1 pt-2 text-label uppercase text-muted">{g.label}</p> : null}
        <ul className="flex flex-col">
          {g.items.map((item, i) => {
            const pill = showsPill(item.status) ? item.status : undefined;
            const name = [
              item.title,
              `due ${formatDate(item.dueDate)}`,
              item.status ? statusLabel(item.status, item.days).full : null,
            ]
              .filter(Boolean)
              .join(', ');
            const { day, month } = parts(item.dueDate);
            return (
              <li key={item.id} className={cx(i > 0 && 'border-t border-line')}>
                {renderLink({
                  href: item.href,
                  'aria-label': name,
                  className:
                    'flex min-h-13 items-center gap-3 rounded-chip px-1 py-1.5 hover:bg-mist',
                  children: (
                    <>
                      <span
                        aria-hidden
                        className="flex w-11 shrink-0 flex-col items-center rounded-chip bg-mist py-1"
                      >
                        <span className="text-section font-extrabold leading-none text-ink tabular">
                          {day}
                        </span>
                        <span className="text-label uppercase text-muted">{monthShort(month)}</span>
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body-strong text-ink">{item.title}</span>
                        {item.meta ? (
                          <span className="truncate text-meta text-muted">{item.meta}</span>
                        ) : null}
                      </span>
                      {pill ? <StatusPill status={pill} days={item.days} size="sm" /> : null}
                    </>
                  ),
                })}
              </li>
            );
          })}
        </ul>
      </div>
    ));
  }

  return (
    <section
      className={cx(
        'flex flex-col gap-2 rounded-card border border-line bg-surface p-4',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Heading className="text-card text-ink">{title}</Heading>
        {viewAllHref
          ? renderLink({
              href: viewAllHref,
              className:
                'inline-flex min-h-6 items-center text-meta font-bold text-forest hover:underline touch-target',
              children: viewAllLabel,
            })
          : null}
      </div>
      {body}
      {more > 0 && !loading && viewAllHref
        ? renderLink({
            href: viewAllHref,
            className:
              'inline-flex min-h-6 items-center self-start text-meta font-bold text-forest hover:underline touch-target',
            children: `+ ${formatNumber(more)} more`,
          })
        : null}
    </section>
  );
}

'use client';
// The calendar's interactive part: a month of due dates as a grid or a list, moving between months through the URL's
// period (`?fy=&m=`), and the chosen day's instances below the grid. Status words and colours come from the API's
// derived status (engine output); this file only lays them out.
import type { InstanceRow } from '@canopy/contracts';
import { Button, EmptyState, formatDate, StatusPill } from '@canopy/ui';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { withPeriod } from '../../../../../../lib/period';
import { statusValue } from '../../register/_lib/columns';
import type { MonthDue } from '../_lib/calendar-api';
import { addMonths, fyOf, monthLabel, monthWeeks, type Month } from '../_lib/month';

export type CalendarViewProps = {
  clientId: string;
  month: Month;
  /** Today in the client's time zone, "YYYY-MM-DD". */
  today: string;
  due: MonthDue;
  fyStartMonth: number;
  view: 'month' | 'list';
  /** The page's query string, kept when moving between months and views. */
  query: string;
};

const WEEKDAYS: [string, string][] = [
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
  ['Sun', 'Sunday'],
];

/** The dot for a status, from the status language's tones (packages/ui/spec/status-language.md). */
const DOT: Record<InstanceRow['status'], string> = {
  UPCOMING: 'bg-muted',
  DUE_SOON: 'bg-warn',
  OVERDUE: 'bg-crit',
  SUBMITTED: 'bg-warn',
  COMPLIED: 'bg-ok',
  COMPLIED_LATE: 'bg-warn',
  NOT_APPLICABLE: 'border border-line-strong',
};
/** A sent-back row counts as open work, but reads as sent back (the register's pill does the same). */
const dotOf = (row: InstanceRow) =>
  row.workflowState === 'SENT_BACK' ? 'bg-crit' : DOT[row.status];

/** A day's button name: "15 November 2024, 3 due, 1 overdue". */
export function dayLabel(date: string, items: InstanceRow[]): string {
  const long = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
  const overdue = items.filter((r) => r.status === 'OVERDUE').length;
  return [long, `${items.length} due`, overdue ? `${overdue} overdue` : null]
    .filter(Boolean)
    .join(', ');
}

const instanceHref = (clientId: string, id: string) =>
  `/c/${encodeURIComponent(clientId)}/register/${encodeURIComponent(id)}`;

function DueList({ clientId, items }: { clientId: string; items: InstanceRow[] }) {
  return (
    <ul className="flex flex-col">
      {items.map((row, i) => (
        <li
          key={row.id}
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-2 ${i > 0 ? 'border-t border-line' : ''}`}
        >
          <Link
            href={instanceHref(clientId, row.id)}
            className="min-w-0 flex-1 rounded-tag text-body-strong text-ink hover:underline"
          >
            {row.title}
          </Link>
          <span className="text-meta text-muted">
            {row.actName} · {row.unitName} · {row.ownerName}
          </span>
          <StatusPill {...statusValue(row)} size="sm" />
        </li>
      ))}
    </ul>
  );
}

export function CalendarView({
  clientId,
  month,
  today,
  due,
  fyStartMonth,
  view,
  query,
}: CalendarViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [navigating, startNavigation] = useTransition();
  const [chosen, setChosen] = useState<string | null>(null);
  const [seenMonth, setSeenMonth] = useState(month);
  if (seenMonth !== month) {
    setSeenMonth(month);
    setChosen(null);
  }

  const go = (next: URLSearchParams) => {
    const qs = next.toString();
    startNavigation(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };
  const toMonth = (step: number) => {
    const next = addMonths(month, step);
    go(withPeriod(query, { fy: fyOf(next, fyStartMonth), month: next }));
  };
  const toView = (next: 'month' | 'list') => {
    const params = new URLSearchParams(query);
    if (next === 'list') params.set('view', 'list');
    else params.delete('view');
    go(params);
  };

  const days = Object.keys(due)
    .filter((d) => d.startsWith(month) && (due[d]?.length ?? 0) > 0)
    .sort();
  const total = days.reduce((n, d) => n + due[d]!.length, 0);
  const label = monthLabel(month);

  return (
    <div className="flex flex-col gap-4" aria-busy={navigating || undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" icon={ChevronLeft} onClick={() => toMonth(-1)}>
          Previous month
        </Button>
        <h2 className="min-w-40 text-center text-section text-ink" aria-live="polite">
          {label}
        </h2>
        <Button variant="ghost" size="sm" icon={ChevronRight} onClick={() => toMonth(1)}>
          Next month
        </Button>
        <span className="text-meta text-muted">
          {total} {total === 1 ? 'instance' : 'instances'} due
        </span>
        <div role="group" aria-label="View" className="ml-auto flex gap-1">
          {(['month', 'list'] as const).map((v) => (
            <Button
              key={v}
              size="sm"
              variant={view === v ? 'primary' : 'ghost'}
              aria-pressed={view === v}
              onClick={() => toView(v)}
            >
              {v === 'month' ? 'Month' : 'List'}
            </Button>
          ))}
        </div>
      </div>

      {total === 0 ? (
        <EmptyState
          variant="first-use"
          icon={CalendarDays}
          title={`Nothing due in ${label}`}
          body="Move to another month, or pick another period."
        />
      ) : view === 'list' ? (
        <div className="flex flex-col gap-4">
          {days.map((d) => (
            <section
              key={d}
              aria-labelledby={`due-${d}`}
              className="rounded-card border border-line bg-surface p-4"
            >
              <h3 id={`due-${d}`} className="text-card text-ink">
                {formatDate(d)}
                {d === today ? <span className="text-meta text-muted"> · Today</span> : null}
              </h3>
              <DueList clientId={clientId} items={due[d]!} />
            </section>
          ))}
        </div>
      ) : (
        <>
          <table className="w-full table-fixed border-collapse rounded-card bg-surface">
            <caption className="sr-only">Due dates in {label}</caption>
            <thead>
              <tr>
                {WEEKDAYS.map(([short, long]) => (
                  <th key={short} scope="col" className="py-2 text-meta font-bold text-muted">
                    <abbr title={long} className="no-underline">
                      {short}
                    </abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthWeeks(month).map((week) => (
                <tr key={week[0]}>
                  {week.map((d) => {
                    const items = d.startsWith(month) ? (due[d] ?? []) : [];
                    const outside = !d.startsWith(month);
                    const number = Number(d.slice(8));
                    return (
                      <td
                        key={d}
                        aria-current={d === today ? 'date' : undefined}
                        className={`h-16 border border-line p-1 align-top sm:h-24 ${outside ? 'bg-mist text-muted' : ''}`}
                      >
                        {items.length === 0 ? (
                          <span
                            className={`block px-1 text-meta ${d === today ? 'font-bold text-forest' : ''}`}
                          >
                            {outside ? <span aria-hidden>{number}</span> : number}
                          </span>
                        ) : (
                          <button
                            type="button"
                            aria-label={dayLabel(d, items)}
                            aria-pressed={chosen === d}
                            onClick={() => setChosen(chosen === d ? null : d)}
                            className={`flex h-full w-full flex-col items-start gap-0.5 rounded-tag px-1 text-left hover:bg-mist ${chosen === d ? 'bg-sage' : ''}`}
                          >
                            <span
                              className={`text-meta ${d === today ? 'font-bold text-forest' : 'text-ink'}`}
                            >
                              {number}
                            </span>
                            {items.slice(0, 2).map((row) => (
                              <span
                                key={row.id}
                                className="hidden w-full items-center gap-1 text-meta text-ink sm:flex"
                              >
                                <span
                                  aria-hidden
                                  className={`size-2 shrink-0 rounded-pill ${dotOf(row)}`}
                                />
                                <span className="truncate">{row.title}</span>
                              </span>
                            ))}
                            <span className="text-meta text-muted sm:hidden">{items.length}</span>
                            {items.length > 2 ? (
                              <span className="hidden text-meta text-muted sm:block">
                                +{items.length - 2} more
                              </span>
                            ) : null}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {chosen && due[chosen] ? (
            <section
              aria-labelledby="chosen-day"
              className="rounded-card border border-line bg-surface p-4"
            >
              <h3 id="chosen-day" className="text-card text-ink">
                Due {formatDate(chosen)}
              </h3>
              <DueList clientId={clientId} items={due[chosen]} />
            </section>
          ) : (
            <p className="text-meta text-muted">Choose a day to see what falls due.</p>
          )}
        </>
      )}
    </div>
  );
}

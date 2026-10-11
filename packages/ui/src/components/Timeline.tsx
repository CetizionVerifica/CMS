import { Bot } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cx } from '../lib/cx';
import { Avatar } from '../primitives/Avatar';
import { Button } from '../primitives/Button';
import { Skeleton } from '../primitives/Skeleton';

/** Audit event kinds from the event catalogue (M7). Unknown kinds render with the neutral dot. */
export type AuditEventKind =
  | 'created'
  | 'assigned'
  | 'reassigned'
  | 'comment'
  | 'submitted'
  | 'approved'
  | 'complied'
  | 'sent_back'
  | 'due_date_changed'
  | 'evidence_added'
  | 'evidence_removed'
  | 'na_requested'
  | 'na_approved'
  | 'overdue'
  | (string & {});

export type TimelineEvent = {
  id: string;
  /** ISO timestamp in UTC. */
  at: string;
  actor: { name: string; avatarUrl?: string } | 'system';
  kind: AuditEventKind;
  /** Verb phrase from the API's event catalogue, e.g. "sent back". */
  summary: string;
  detail?: { reason?: string; from?: string; to?: string; field?: string };
};

export type TimelineProps = {
  events: TimelineEvent[];
  /** IANA zone of the client, e.g. "Asia/Kolkata". */
  timeZone: string;
  /** Default newest first. */
  order?: 'newest' | 'oldest';
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  /** Clock for "Today", "Yesterday" and "2 hours ago"; defaults to now. Pass it in tests and server renders. */
  now?: string;
  /** Product name shown for system events. */
  systemName?: string;
  className?: string;
};

const TONE: Record<string, 'ok' | 'warn' | 'crit' | 'neutral'> = {
  approved: 'ok',
  complied: 'ok',
  na_approved: 'ok',
  submitted: 'warn',
  due_date_changed: 'warn',
  na_requested: 'warn',
  sent_back: 'crit',
  evidence_removed: 'crit',
  overdue: 'crit',
};

const dotClass = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit', neutral: 'bg-line-strong' };

function dayKey(iso: string, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function dayLabel(key: string, todayKey: string, yesterdayKey: string): string {
  if (key === todayKey) return 'Today';
  if (key === yesterdayKey) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** "31 Mar 2027, 14:05 IST" in the client's time zone. */
export function formatTimestamp(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // India shows as "GMT+5:30" in en-GB; IST is what people read.
  const zone = timeZone === 'Asia/Kolkata' ? 'IST' : get('timeZoneName');
  return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} ${zone}`;
}

function relative(iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86400), 'day');
}

/** Spec 16 · Timeline. Read-only audit history; times are timestamps shown in the client's time zone. */
export function Timeline({
  events,
  timeZone,
  order = 'newest',
  onLoadMore,
  hasMore = false,
  loading = false,
  now,
  systemName = 'Canopy',
  className,
}: TimelineProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const countBefore = useRef<number | null>(null);
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const todayKey = dayKey(new Date(nowMs).toISOString(), timeZone);
  const yesterdayKey = dayKey(new Date(nowMs - 86_400_000).toISOString(), timeZone);

  const sorted = [...events].sort((a, b) =>
    order === 'newest' ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at),
  );

  // After "Show earlier activity", focus the first new item.
  useEffect(() => {
    const before = countBefore.current;
    if (before === null || events.length <= before) return;
    countBefore.current = null;
    const items = listRef.current?.querySelectorAll<HTMLElement>('li[data-event]');
    items?.[order === 'newest' ? before : 0]?.focus();
  }, [events.length, order]);

  if (loading && events.length === 0) {
    return (
      <div aria-busy="true" className={cx('flex flex-col gap-4', className)}>
        <span className="sr-only">Loading activity</span>
        {[0, 1, 2].map((n) => (
          <div key={n} className="flex gap-3">
            <Skeleton className="mt-1 size-2.5 rounded-pill" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return <p className={cx('text-body text-muted', className)}>No activity yet.</p>;
  }

  let lastDay = '';
  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <ol ref={listRef} aria-label="Activity" className="relative flex flex-col">
        {/* The rail, 6px from the left. */}
        <span aria-hidden className="absolute bottom-2 left-[6px] top-2 w-0.5 bg-line" />
        {sorted.map((e) => {
          const key = dayKey(e.at, timeZone);
          const separator = key !== lastDay ? dayLabel(key, todayKey, yesterdayKey) : null;
          lastDay = key;
          const tone = TONE[e.kind] ?? 'neutral';
          const system = e.actor === 'system';
          return [
            separator ? (
              <li
                key={`day-${key}`}
                aria-hidden
                className="relative pb-2 pl-6 pt-1 text-label uppercase text-muted"
              >
                {separator}
              </li>
            ) : null,
            <li
              key={e.id}
              data-event
              tabIndex={-1}
              className="relative flex flex-col gap-1 pb-4 pl-6 outline-none focus-visible:outline-2 focus-visible:outline-forest"
            >
              <span
                aria-hidden
                className={cx(
                  'absolute left-[2px] top-[7px] size-2.5 rounded-pill ring-2 ring-surface',
                  dotClass[tone],
                )}
              />
              <p className="flex flex-wrap items-center gap-x-1.5 text-body text-ink">
                {system ? (
                  <Bot aria-hidden size={16} className="text-muted" />
                ) : (
                  <Avatar
                    name={e.actor === 'system' ? systemName : e.actor.name}
                    size={24}
                    decorative
                  />
                )}
                <span>
                  <strong className="font-bold">
                    {system ? systemName : (e.actor as { name: string }).name}
                  </strong>{' '}
                  {e.summary}
                </span>
              </p>
              {e.detail?.reason ? (
                <blockquote className="rounded-chip bg-mist px-3 py-2 text-body text-ink">
                  {e.detail.reason}
                </blockquote>
              ) : null}
              {e.detail?.field ? (
                <p className="text-body">
                  <span className="text-ink">{e.detail.field}: </span>
                  <span className="text-muted">{e.detail.from ?? 'none'}</span>
                  <span className="text-muted"> to </span>
                  <span className="text-ink">{e.detail.to ?? 'none'}</span>
                </p>
              ) : null}
              <time dateTime={e.at} title={relative(e.at, nowMs)} className="text-meta text-muted">
                {formatTimestamp(e.at, timeZone)}
              </time>
            </li>,
          ];
        })}
      </ol>
      {hasMore && onLoadMore ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          loading={loading}
          onClick={() => {
            countBefore.current = events.length;
            onLoadMore();
          }}
        >
          Show earlier activity
        </Button>
      ) : null}
    </div>
  );
}

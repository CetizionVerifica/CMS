'use client';
// Shared pieces of the ISO pages: the states a page can be in besides showing its data, and the pills that word a
// state (docs/iso/model.md §4.7). Tones are only colour; the words always carry the meaning.
import { cx, EmptyState } from '@canopy/ui';

import {
  FeatureNotEnabled,
  NoPermission,
  NotFoundState,
  PageHeader,
} from '../../../../../../lib/patterns';
import { BEING_SET_UP, type Refusal } from '../_lib/refusal';
import { timingWords, word, type WordsEnum } from '../_lib/words';

/** The add-on is on but its catalogue copy isn't recorded yet (409 FEATURE_NOT_READY, plan §4.3). */
export function BeingSetUp({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <section className="rounded-card border border-line bg-surface">
        <EmptyState
          variant="first-use"
          size="page"
          title="ISO management systems is being set up"
          body={BEING_SET_UP.replace('ISO management systems is being set up. ', '')}
        />
      </section>
    </>
  );
}

/** A page whose data the API refused: says why, in the page's own place. */
export function IsoRefusal({
  refusal,
  title,
  homeHref,
}: {
  refusal: Refusal;
  title: string;
  homeHref: string;
}) {
  switch (refusal) {
    case 'notReady':
      return <BeingSetUp title={title} />;
    case 'notEnabled':
      return <FeatureNotEnabled feature="isoManagement" homeHref={homeHref} />;
    case 'noPermission':
      return (
        <NoPermission what={title.toLowerCase()} backHref={homeHref} backLabel="Go to overview" />
      );
    case 'notFound':
      return <NotFoundState />;
  }
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'crit';

const TONE: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-muted',
  ok: 'bg-ok-soft text-ok-ink',
  warn: 'bg-warn-soft text-warn-ink',
  crit: 'bg-crit-soft text-crit-ink',
};

/** A state in words, as a pill. */
export function IsoPill({ children, tone = 'neutral' }: { children: string; tone?: Tone }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-pill px-2 py-0.5 text-meta font-semibold whitespace-nowrap',
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Colour per state, where a state is good news (ok), needs someone (warn) or is late or refused (crit). */
const TONES: Partial<Record<WordsEnum, Partial<Record<string, Tone>>>> = {
  ClauseStatus: { IMPLEMENTED: 'ok', PARTIAL: 'warn' },
  ClauseNaState: { REQUESTED: 'warn', APPROVED: 'ok', REJECTED: 'crit' },
  RevisionState: { IN_REVIEW: 'warn', APPROVED: 'ok' },
  DocumentStatus: { ACTIVE: 'ok' },
  ExternalAuditState: { HELD: 'warn', RESPONDED: 'warn', CLOSED: 'ok' },
  FindingType: { MAJOR_NC: 'crit', MINOR_NC: 'warn', GOOD_PRACTICE: 'ok' },
  ManagementSystemStatus: { CERTIFIED: 'ok', SUSPENDED: 'crit' },
};

/** One value of a contracts ISO enum as a pill, in its words. */
export function StatePill<E extends WordsEnum>({ of, value }: { of: E; value: string }) {
  return <IsoPill tone={TONES[of]?.[value] ?? 'neutral'}>{word(of, value as never)}</IsoPill>;
}

const TIMING_TONE: Record<string, Tone> = { DUE_SOON: 'warn', OVERDUE: 'crit' };

/** An ISO due status (`reviewStatus` and the like) as a pill: "Overdue 3 days". */
export function TimingPill({
  status,
}: {
  status: { timing: 'ON_TIME' | 'DUE_SOON' | 'OVERDUE' | 'CLOSED'; overdueDays: number | null };
}) {
  return <IsoPill tone={TIMING_TONE[status.timing] ?? 'neutral'}>{timingWords(status)}</IsoPill>;
}

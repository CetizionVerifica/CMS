'use client';
// The ISO overview (packages.md ISO-6a): per management system, clause readiness beside the certification gates, the
// climate warnings, the counts that need someone, programme coverage, incidents, certificates and the next management
// review. Every number is the API's, and every number links to the list of exactly the records it counts.
import type { IsoStandard, IsoSystemOverview, ManagementReviewDue } from '@canopy/contracts';
import { formatDate, ScoreRing } from '@canopy/ui';
import NextLink from 'next/link';
import type { ReactNode } from 'react';

import { hrefWith } from '../_lib/people';
import { standardTitle, standardTitleByCode, word } from '../_lib/words';
import { IsoPill, TimingPill } from '../_components/IsoStates';
import {
  climateGapHref,
  climateGapText,
  countGroups,
  gateRows,
  isoPath,
  readinessLinks,
  readinessText,
  type CountLink,
  type MissingContext,
} from './overview-model';

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={`flex flex-col gap-3 rounded-card border border-line bg-surface p-4 ${className ?? ''}`}
    >
      <h3 className="text-body font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function Count({ item }: { item: CountLink }) {
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-body text-muted">{item.label}</span>
        {item.count === 0 ? (
          // Nothing to open: a link would land on the whole, unfiltered list.
          <span className="text-body font-semibold text-ink tabular-nums">0</span>
        ) : (
          <NextLink
            href={item.href}
            prefetch={false}
            className="text-body font-semibold text-forest tabular-nums underline-offset-2 hover:underline"
            aria-label={`${item.count} ${item.label.toLowerCase()}${item.note ? `, ${item.note}` : ''}`}
          >
            {item.count}
          </NextLink>
        )}
      </span>
      {item.note ? <span className="text-meta text-muted">{item.note}</span> : null}
    </li>
  );
}

function ReviewDue({ due, standards }: { due: ManagementReviewDue; standards: IsoStandard[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {due.items.map((item) => (
        <li key={item.standard} className="flex flex-wrap items-center gap-2 text-body">
          <span className="min-w-24 text-ink">{standardTitleByCode(standards, item.standard)}</span>
          <span className="text-muted">due {formatDate(item.nextDueOn)}</span>
          <TimingPill status={item} />
        </li>
      ))}
    </ul>
  );
}

export type OverviewViewProps = {
  clientId: string;
  system: IsoSystemOverview;
  standards: IsoStandard[];
  missing: MissingContext;
  /** Clause numbers by clause id, for the programme's uncovered clauses. */
  clauseNumbers: Record<string, string>;
};

/** One management system's overview. */
export function SystemOverview({
  clientId,
  system,
  standards,
  missing,
  clauseNumbers,
}: OverviewViewProps) {
  const sys = system.managementSystemId;
  const programme = system.auditProgramme;
  const uncovered = programme
    ? programme.uncoveredClauseIds.map((id) => clauseNumbers[id] ?? 'an unknown clause')
    : [];
  const incidentsHref = hrefWith(isoPath(clientId, 'nonconformities'), {
    ids: system.incidents.total.ids.join(','),
  });
  return (
    <div className="flex flex-col gap-4">
      {system.climateGaps.length > 0 ? (
        <section
          aria-label="Climate change"
          className="flex flex-col gap-1 rounded-card border border-line bg-warn-soft p-4"
        >
          <h3 className="text-body font-semibold text-warn-ink">Climate change (Amd 1:2024)</h3>
          <ul className="flex flex-col gap-1">
            {system.climateGaps.map((gap) => (
              <li key={gap} className="text-body text-ink">
                {climateGapText(gap)}{' '}
                <NextLink
                  href={climateGapHref(clientId, gap)}
                  prefetch={false}
                  className="text-forest underline"
                >
                  Go there
                </NextLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        aria-labelledby={`readiness-${sys}`}
        className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-center gap-4">
          <ScoreRing value={system.clauseReadiness.overall.score} label="Clause readiness" />
          <div>
            <h3 id={`readiness-${sys}`} className="text-card text-ink">
              Clause readiness {readinessText(system.clauseReadiness.overall.score)}
            </h3>
            <p className="text-body text-muted">
              The client&apos;s own assessment, clause by clause. The certification gates beside it
              come from records.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {system.clauseReadiness.byStandard.map((r) => {
            const gates =
              system.certificationReadiness.standards.find((s) => s.standardId === r.standardId)
                ?.gates ?? [];
            const rows = gateRows(clientId, sys, gates, missing);
            const title = standardTitle(standards, r.standardId);
            return (
              <div
                key={r.standardId}
                className="flex flex-col gap-3 rounded-control border border-line p-3"
              >
                <h4 className="text-body font-semibold text-ink">
                  {title}: {readinessText(r.score)}
                </h4>
                <ul aria-label={`${title} checklist`} className="flex flex-col gap-1">
                  {readinessLinks(clientId, sys, r.standardId, r).map((item) => (
                    <Count key={item.label} item={item} />
                  ))}
                </ul>
                <div>
                  <p className="mb-1 text-meta font-semibold text-muted">Certification gates</p>
                  <ul aria-label={`${title} certification gates`} className="flex flex-col gap-1.5">
                    {rows.map((g) => (
                      <li key={g.gate} className="text-body">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-ink">{g.label}</span>
                          <IsoPill tone={g.met ? 'ok' : 'warn'}>
                            {g.met ? 'Met' : 'Not met'}
                          </IsoPill>
                        </span>
                        {g.met ? null : (
                          <span className="block text-meta text-muted">
                            Missing: {g.missing.join(', ')}.{' '}
                            <NextLink
                              href={g.href}
                              prefetch={false}
                              className="text-forest underline"
                            >
                              Fix {g.label.toLowerCase()}
                            </NextLink>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {countGroups(clientId, system).map((group) => (
          <Card key={group.title} title={group.title}>
            <ul className="flex flex-col gap-1.5">
              {group.items.map((item) => (
                <Count key={item.label} item={item} />
              ))}
            </ul>
          </Card>
        ))}
        <Card title="Next management review">
          <ReviewDue due={system.managementReview} standards={standards} />
          <NextLink
            href={hrefWith(isoPath(clientId, 'management-reviews'), { managementSystemId: sys })}
            prefetch={false}
            className="text-body text-forest underline"
          >
            Management reviews
          </NextLink>
        </Card>
        <Card title="Audit programme">
          {programme ? (
            <>
              <p className="text-body text-muted">FY {programme.fy}</p>
              <ul className="flex flex-col gap-1.5">
                {(
                  [
                    ['Planned', programme.planned, 'PLANNED'],
                    ['Reported', programme.reported, 'REPORTED,CLOSED'],
                    ['Cancelled', programme.cancelled, 'CANCELLED'],
                  ] as const
                ).map(([label, count]) => (
                  <Count
                    key={label}
                    item={{
                      label,
                      count: count.count,
                      href: hrefWith(isoPath(clientId, 'audits'), { ids: count.ids.join(',') }),
                    }}
                  />
                ))}
              </ul>
              <p className="text-meta text-muted">
                {uncovered.length === 0
                  ? 'Every clause is covered this year.'
                  : `${uncovered.length} ${uncovered.length === 1 ? 'clause' : 'clauses'} not yet covered: ${uncovered.slice(0, 8).join(', ')}${uncovered.length > 8 ? ` and ${uncovered.length - 8} more` : ''}.`}
                {programme.uncoveredUnitIds.length > 0
                  ? ` Units not yet covered: ${programme.uncoveredUnitIds
                      .map((id) => missing.unitNames[id] ?? 'an unknown unit')
                      .join(', ')}.`
                  : ''}
              </p>
            </>
          ) : (
            <p className="text-body text-muted">No audit programme for this year yet.</p>
          )}
        </Card>
        <Card title="Incidents this year">
          <p className="text-body text-muted">
            {formatDate(system.incidents.from)} to {formatDate(system.incidents.to)}
          </p>
          <ul className="flex flex-col gap-1.5">
            <Count
              item={{
                label: 'All incidents',
                count: system.incidents.total.count,
                href: incidentsHref,
              }}
            />
            {system.incidents.byType
              .filter((t) => t.count > 0)
              .map((t) => (
                <Count
                  key={t.type}
                  item={{
                    label: word('IncidentType', t.type),
                    count: t.count,
                    href: hrefWith(isoPath(clientId, 'nonconformities'), { ids: t.ids.join(',') }),
                  }}
                />
              ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

/** The card that takes the person to their own open ISO actions. */
export function MyActionsCard({ clientId }: { clientId: string }) {
  return (
    <section
      aria-label="My ISO actions"
      className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-4"
    >
      <div>
        <h2 className="text-card text-ink">My ISO actions</h2>
        <p className="text-body text-muted">
          Corrective, treatment, improvement and review actions you own.
        </p>
      </div>
      <NextLink
        href={hrefWith(isoPath(clientId, 'actions'), { owner: 'me', state: 'OPEN' })}
        prefetch={false}
        className="text-body font-semibold text-forest underline"
      >
        Open my actions
      </NextLink>
    </section>
  );
}

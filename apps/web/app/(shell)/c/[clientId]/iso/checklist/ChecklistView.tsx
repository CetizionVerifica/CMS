'use client';
// The clause checklist (packages.md ISO-6a, model §3.3): one row per assessable clause of the system's standards. A row
// opens in a drawer named in the URL. Its status, owner, notes and review date are edited there; its N/A steps are
// exactly the row's `allowedActions`, so the API decides who may request, decide or withdraw.
import type { ClauseNaAction, ClauseWorkStatus } from '@canopy/contracts';
import {
  Button,
  DateInput,
  Drawer,
  DrawerSection,
  formatDate,
  Input,
  Select,
  Textarea,
  type DataTableProps,
  type FilterDef,
} from '@canopy/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { isoWrite } from '../_lib/actions';
import type { PersonOption } from '../_lib/people';
import { word, WORDS } from '../_lib/words';
import { FilesPanel } from '../_components/FilesPanel';
import {
  FormAlert,
  PersonSelect,
  StepButton,
  useSave,
  type StepButtonProps,
} from '../_components/controls';
import { IsoFilterBar, withOpen } from '../_components/IsoFilterBar';
import { StatePill } from '../_components/IsoStates';
import { IsoTable } from '../_components/IsoTable';
import type { ChecklistRow } from './checklist-model';

type Columns = DataTableProps<ChecklistRow>['columns'];

const columns: Columns = [
  {
    id: 'clause',
    header: 'Clause',
    accessorFn: (r) => ({ title: r.clause, sub: r.standard }) as never,
    meta: { type: 'title', locked: true },
    size: 420,
    enableSorting: false,
  },
  {
    id: 'status',
    header: 'Status',
    accessorFn: (r) => r.row.status as never,
    cell: (ctx) => <StatePill of="ClauseStatus" value={ctx.row.original.row.status} />,
    enableSorting: false,
  },
  {
    id: 'naState',
    header: 'Not applicable',
    accessorFn: (r) => r.row.naState as never,
    size: 200,
    cell: (ctx) =>
      ctx.row.original.row.naState === 'NONE' ? (
        <span className="text-muted">No request</span>
      ) : (
        <StatePill of="ClauseNaState" value={ctx.row.original.row.naState} />
      ),
    enableSorting: false,
  },
  {
    id: 'owner',
    header: 'Owner',
    accessorFn: (r) => r.ownerName as never,
    size: 180,
    meta: { type: 'text' },
    enableSorting: false,
  },
  {
    id: 'lastReviewedOn',
    header: 'Last reviewed',
    accessorFn: (r) => (r.row.lastReviewedOn ?? '') as never,
    meta: { type: 'date' },
    enableSorting: false,
  },
];

export type ChecklistViewProps = {
  clientId: string;
  systemId: string;
  rows: ChecklistRow[];
  people: PersonOption[];
  filters: FilterDef[];
  filterValue: Record<string, string[]>;
  /** The row whose drawer is open (`?row=`). */
  openRowId: string | null;
  /** Rows this person may edit: every row for managers, their own rows for an owner (contracts role table). */
  editable: { all: boolean; personId: string };
  /** May change a row's owner (managers). */
  canReassign: boolean;
  today: string;
  timeZone: string;
};

export function ChecklistView(props: ChecklistViewProps) {
  const { rows, filters, filterValue, openRowId } = props;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const hrefFor = (id?: string) =>
    withOpen(pathname, new URLSearchParams(params.toString()), 'row', id);
  const index = rows.findIndex((r) => r.id === openRowId);
  const open = index >= 0 ? rows[index]! : null;
  const go = (id?: string) => router.push(hrefFor(id), { scroll: false });

  return (
    <>
      <IsoFilterBar
        filters={filters}
        value={filterValue}
        resultText={`${rows.length} ${rows.length === 1 ? 'clause' : 'clauses'}`}
        resultCount={rows.length}
      />
      <IsoTable
        label="Checklist"
        columns={columns}
        data={rows}
        rowId={(r) => r.id}
        rowLabel={(r) => `${r.clause}, ${r.standard}`}
        rowHref={(r) => hrefFor(r.id)}
        countNoun={{ one: 'clause', other: 'clauses' }}
        empty={
          <p className="p-6 text-body text-muted">
            No clause matches these filters. Clear a filter to see more.
          </p>
        }
      />
      {open ? (
        <RowDrawer
          key={`${open.id}-${open.row.version}`}
          {...props}
          item={open}
          onClose={() => go()}
          onPrev={index > 0 ? () => go(rows[index - 1]!.id) : undefined}
          onNext={index < rows.length - 1 ? () => go(rows[index + 1]!.id) : undefined}
        />
      ) : null}
    </>
  );
}

const NA_STEPS: Record<
  ClauseNaAction,
  Omit<StepButtonProps, 'run' | 'title'> & { title: (clause: string) => string }
> = {
  REQUEST_NA: {
    label: 'Request not applicable',
    title: (c) => `Request that clause ${c} does not apply?`,
    body: 'An approver or client admin decides. Until then it counts as not started in readiness.',
    reason: {
      label: 'Why the clause does not apply',
      helper: 'Kept as the justification an auditor reads.',
    },
    done: 'Not applicable requested.',
  },
  APPROVE_NA: {
    label: 'Approve not applicable',
    title: (c) => `Approve that clause ${c} does not apply?`,
    body: 'The clause is excluded from the system.',
    reason: { label: 'Comment', optional: true },
    variant: 'primary',
    done: 'Not applicable approved.',
  },
  REJECT_NA: {
    label: 'Refuse',
    title: (c) => `Refuse not applicable for clause ${c}?`,
    body: 'The clause applies again and returns to the status it had before the request.',
    reason: { label: 'Why it applies' },
    tone: 'danger',
    done: 'Not applicable refused.',
  },
  WITHDRAW_NA: {
    label: 'Withdraw not applicable',
    title: (c) => `Withdraw not applicable for clause ${c}?`,
    body: 'The clause applies again and starts from Not started.',
    reason: { label: 'Why it applies now' },
    done: 'Not applicable withdrawn.',
  },
};

const NA_ROUTE = {
  REQUEST_NA: 'requestIsoClauseNa',
  APPROVE_NA: 'approveIsoClauseNa',
  REJECT_NA: 'rejectIsoClauseNa',
  WITHDRAW_NA: 'withdrawIsoClauseNa',
} as const;

function RowDrawer({
  clientId,
  systemId,
  people,
  editable,
  canReassign,
  today,
  timeZone,
  item,
  onClose,
  onPrev,
  onNext,
}: ChecklistViewProps & {
  item: ChecklistRow;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const { row } = item;
  const canEdit = editable.all || row.ownerId === editable.personId;
  const naLocked = row.naState === 'REQUESTED' || row.naState === 'APPROVED';
  const [status, setStatus] = useState<string>(naLocked ? '' : row.status);
  const [ownerId, setOwnerId] = useState(row.ownerId);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState(row.notes ?? '');
  const [reviewed, setReviewed] = useState<string | null>(row.lastReviewedOn);
  const { pending, error, save } = useSave();
  const ownerChanged = ownerId !== row.ownerId;
  const ids = { id: systemId, rowId: row.id };
  const number = row.clauseNumber;

  const body = () => {
    const b: Record<string, unknown> = { version: row.version };
    if (!naLocked && status !== row.status) b.status = status as ClauseWorkStatus;
    if (ownerChanged) {
      b.ownerId = ownerId;
      b.reason = reason.trim();
    }
    if ((notes.trim() || null) !== row.notes) b.notes = notes.trim() || null;
    if (reviewed !== row.lastReviewedOn) b.lastReviewedOn = reviewed;
    return b;
  };
  const changed = Object.keys(body()).length > 1;

  return (
    <Drawer
      open
      onOpenChange={(next) => !next && onClose()}
      title={item.clause}
      eyebrow={<span className="text-meta text-muted">{item.standard}</span>}
      meta={
        <span className="flex flex-wrap gap-2">
          <StatePill of="ClauseStatus" value={row.status} />
          {row.naState === 'NONE' ? null : <StatePill of="ClauseNaState" value={row.naState} />}
        </span>
      }
      onPrev={onPrev}
      onNext={onNext}
      itemNoun="clause"
      backLabel="Back to checklist"
      size="md"
      dirty={changed}
      dirtyPrompt={{ title: 'Discard your changes to this clause?' }}
    >
      <div className="flex flex-col gap-6">
        <DrawerSection title="Not applicable">
          <p className="text-body text-ink">
            {row.naState === 'NONE'
              ? row.exclusionAllowed
                ? 'The clause applies. It may be excluded with a justification.'
                : 'The clause applies. The standard does not allow it to be excluded.'
              : word('ClauseNaState', row.naState)}
          </p>
          {row.justification ? (
            <p className="whitespace-pre-line text-body text-muted">
              Justification: {row.justification}
            </p>
          ) : null}
          {row.allowedActions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {row.allowedActions.map((action) => {
                const step = NA_STEPS[action];
                return (
                  <StepButton
                    key={action}
                    {...step}
                    title={step.title(number)}
                    run={(text) =>
                      isoWrite(
                        clientId,
                        NA_ROUTE[action],
                        ids,
                        action === 'APPROVE_NA'
                          ? { version: row.version, ...(text ? { comment: text } : {}) }
                          : { version: row.version, reason: text ?? '' },
                      )
                    }
                  />
                );
              })}
            </div>
          ) : null}
        </DrawerSection>

        <DrawerSection title="Assessment">
          {canEdit ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void save(
                  () => isoWrite(clientId, 'updateIsoChecklistRow', ids, body() as never),
                  'The clause is saved.',
                );
              }}
            >
              {naLocked ? (
                <p className="text-body text-muted">
                  The status stays Not applicable while the request is open or approved. Withdraw it
                  to work on the clause again.
                </p>
              ) : (
                <Select
                  label="Status"
                  options={Object.entries(WORDS.ClauseStatus)
                    .filter(([value]) => value !== 'NOT_APPLICABLE')
                    .map(([value, label]) => ({ value, label }))}
                  value={status}
                  onValueChange={setStatus}
                />
              )}
              {canReassign ? (
                <PersonSelect
                  label="Owner"
                  people={people}
                  value={ownerId}
                  onChange={setOwnerId}
                  none="Nobody yet"
                />
              ) : (
                <p className="text-body">
                  <span className="text-muted">Owner: </span>
                  {item.ownerName}
                </p>
              )}
              {ownerChanged ? (
                <Input
                  label="Why the owner changes"
                  value={reason}
                  maxLength={2000}
                  onChange={(e) => setReason(e.target.value)}
                  required
                />
              ) : null}
              <Textarea
                label="Notes"
                helper="How the clause is met: the process, record or evidence an auditor would look at."
                value={notes}
                maxLength={8000}
                onChange={(e) => setNotes(e.target.value)}
              />
              <DateInput
                label="Last reviewed"
                value={reviewed}
                onValueChange={setReviewed}
                max={today}
                today={today}
              />
              <FormAlert message={error} />
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  loading={pending}
                  disabledReason={
                    !changed
                      ? 'Nothing has changed'
                      : ownerChanged && reason.trim() === ''
                        ? 'Say why the owner changes'
                        : undefined
                  }
                >
                  Save clause
                </Button>
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-body">
              <dt className="text-muted">Owner</dt>
              <dd>{item.ownerName}</dd>
              <dt className="text-muted">Notes</dt>
              <dd className="whitespace-pre-line">{row.notes ?? 'No notes yet.'}</dd>
              <dt className="text-muted">Last reviewed</dt>
              <dd>{row.lastReviewedOn ? formatDate(row.lastReviewedOn) : 'Not yet'}</dd>
            </dl>
          )}
        </DrawerSection>

        <FilesPanel
          clientId={clientId}
          subject={{ type: 'clause_assessment', id: row.id }}
          editable={canEdit}
          helper="Evidence that the clause is met."
          timeZone={timeZone}
        />
      </div>
    </Drawer>
  );
}

'use client';
// Step 3: the cleaning the API proposes, shown before anything is applied (root rule 5). Each group of rows with the
// same issue is decided once: use the proposal, type another value, or keep what the workbook says. The raw values
// stay on screen next to the proposal.
import type { ImportIssueDecisionBody, ImportIssueGroup } from '@canopy/contracts';
import { Button, Input } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { acceptAllAction, decideAction, dryRunAction, type ActionResult } from './actions';
import { CancelImport } from './CancelImport';
import {
  acceptableKeys,
  batchHref,
  blockingCount,
  decisionText,
  FIELD_LABEL,
  groupIssues,
  ISSUE_TITLE,
  rowsText,
} from './import-model';

export type ReviewStepProps = { clientId: string; batchId: string; groups: ImportIssueGroup[] };

function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, action: () => Promise<ActionResult>, after?: () => void) => {
    setPending(key);
    setError(null);
    const result = await action();
    setPending(null);
    if (!result.ok) {
      setError(result.message);
      router.refresh();
      return;
    }
    if (after) after();
    else router.refresh();
  };
  return { pending, error, run };
}

export function ReviewStep({ clientId, batchId, groups }: ReviewStepProps) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const sorted = groupIssues(groups);
  const blocking = blockingCount(sorted);
  const acceptable = acceptableKeys(sorted);
  const decide = (groupKey: string, body: ImportIssueDecisionBody) =>
    run(groupKey, () => decideAction(clientId, batchId, groupKey, body));

  return (
    <section aria-labelledby="review-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="review-heading" className="text-card text-ink">
          Review the cleaning
        </h2>
        <p className="text-body text-muted">
          {sorted.blocking.length > 0
            ? `${sorted.blocking.length} ${sorted.blocking.length === 1 ? 'problem stops' : 'problems stop'} this import. Fix the workbook and start a new import.`
            : sorted.decide.length > 0
              ? `${sorted.decide.length} ${sorted.decide.length === 1 ? 'group of rows needs' : 'groups of rows need'} a decision. Nothing is changed until you commit.`
              : 'Every group is decided. Run the dry run to see what the import will do.'}
        </p>
      </div>

      {acceptable.length > 0 ? (
        <div>
          <Button
            variant="secondary"
            loading={pending === 'all'}
            onClick={() => void run('all', () => acceptAllAction(clientId, batchId, acceptable))}
          >
            Accept every proposal ({acceptable.length})
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-body text-crit-ink">
          {error}
        </p>
      ) : null}

      <IssueList title="Stops the import" groups={sorted.blocking} tone="crit" />
      <IssueList
        title="Needs a decision"
        groups={sorted.decide}
        renderActions={(g) => (
          <DecisionButtons group={g} pending={pending === g.groupKey} onDecide={decide} />
        )}
      />
      <IssueList
        title="Decided"
        groups={sorted.decided}
        renderActions={(g) => (
          <DecisionButtons group={g} pending={pending === g.groupKey} onDecide={decide} changing />
        )}
      />
      <IssueList title="For information" groups={sorted.info} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          loading={pending === 'dry-run'}
          disabledReason={
            blocking > 0
              ? sorted.blocking.length > 0
                ? 'Problems in the workbook stop this import'
                : 'Decide every group first'
              : undefined
          }
          onClick={() =>
            void run(
              'dry-run',
              () => dryRunAction(clientId, batchId),
              () => router.push(batchHref(clientId, batchId)),
            )
          }
        >
          Run the dry run
        </Button>
        <CancelImport clientId={clientId} batchId={batchId} />
      </div>
    </section>
  );
}

function IssueList({
  title,
  groups,
  tone,
  renderActions,
}: {
  title: string;
  groups: ImportIssueGroup[];
  tone?: 'crit';
  renderActions?: (group: ImportIssueGroup) => React.ReactNode;
}) {
  if (groups.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3
        className={
          tone === 'crit'
            ? 'text-body font-semibold text-crit-ink'
            : 'text-body font-semibold text-ink'
        }
      >
        {title} <span className="tabular text-muted">({groups.length})</span>
      </h3>
      <ul className="flex flex-col gap-2">
        {groups.map((g) => (
          <li
            key={g.groupKey}
            className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
          >
            <IssueSummary group={g} />
            {renderActions ? renderActions(g) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function IssueSummary({ group }: { group: ImportIssueGroup }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-body font-semibold text-ink">
        {ISSUE_TITLE[group.type]}
        {group.field ? (
          <span className="font-normal text-muted"> · {FIELD_LABEL[group.field]}</span>
        ) : null}
      </p>
      <p className="text-meta text-muted">{rowsText(group.rowNumbers)}</p>
      {group.rawValues.length > 0 ? (
        <p className="text-body text-ink">
          <span className="text-muted">In the workbook: </span>
          {group.rawValues.map((v) => (v === '' ? '(empty)' : `“${v}”`)).join(', ')}
        </p>
      ) : null}
      {group.proposal !== null ? (
        <p className="text-body text-ink">
          <span className="text-muted">Proposed: </span>“{group.proposal}”
        </p>
      ) : null}
      {group.decision !== 'PENDING' ? (
        <p className="text-body text-ok-ink">{decisionText(group)}</p>
      ) : null}
    </div>
  );
}

function DecisionButtons({
  group,
  pending,
  onDecide,
  changing = false,
}: {
  group: ImportIssueGroup;
  pending: boolean;
  onDecide: (groupKey: string, body: ImportIssueDecisionBody) => Promise<void>;
  changing?: boolean;
}) {
  const [open, setOpen] = useState(!changing);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(group.editedValue ?? group.proposal ?? '');
  const subject = ISSUE_TITLE[group.type].toLowerCase();

  if (!open) {
    return (
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          aria-label={`Change the decision on ${subject}, ${rowsText(group.rowNumbers)}`}
        >
          Change
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {group.proposal !== null ? (
          <Button
            size="sm"
            loading={pending}
            onClick={() => void onDecide(group.groupKey, { decision: 'ACCEPTED' })}
          >
            Use “{group.proposal}”
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setEditing((e) => !e)}
          aria-expanded={editing}
        >
          Use another value
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={pending}
          onClick={() => void onDecide(group.groupKey, { decision: 'REJECTED' })}
        >
          Keep as written
        </Button>
      </div>
      {editing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim() === '') return;
            void onDecide(group.groupKey, { decision: 'EDITED', editedValue: value.trim() });
          }}
        >
          <Input
            label="Value to use"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="min-w-64"
          />
          <Button
            type="submit"
            size="sm"
            loading={pending}
            disabledReason={value.trim() === '' ? 'Type a value first' : undefined}
          >
            Save value
          </Button>
        </form>
      ) : null}
    </div>
  );
}

'use client';
// An internal audit's checklist and findings (model §3.7, §3.9). Rows are kept while the audit is planned or in
// progress; findings are recorded only in progress. A MAJOR_NC or MINOR_NC finding raises its nonconformity with it,
// and a finding's type moves only within its group: among observation, opportunity and good practice, or between major
// and minor while its nonconformity is still open, and never by that nonconformity's owner.
import {
  ChecklistResult,
  FindingType,
  NC_FINDING_TYPES,
  type AuditChecklistItem,
  type AuditFinding,
} from '@canopy/contracts';
import { Button, DateInput, RadioGroup, Select, Textarea } from '@canopy/ui';
import NextLink from 'next/link';
import { useState } from 'react';

import { isoWrite } from '../../_lib/actions';
import { nameOf } from '../../_lib/people';
import { word, WORDS } from '../../_lib/words';
import { ClausePicker } from '../../_components/ClausePicker';
import { FormDrawer, PersonSelect, useSave } from '../../_components/controls';
import { StatePill } from '../../_components/IsoStates';
import { clausesWithoutResult } from '../audit-model';
import type { AuditRecordProps, FindingNc } from './AuditRecord';

const NONE = '__none__';
const isNcType = (t: FindingType) => (NC_FINDING_TYPES as readonly FindingType[]).includes(t);
const short = (text: string) => text.slice(0, 60).trim();

/** The types a finding may move to (model §3.9): its own group, and for a nonconformity only while it may move. */
export function findingTypes(
  finding: Pick<AuditFinding, 'type'>,
  nc: FindingNc | undefined,
  personId: string,
): FindingType[] {
  if (!isNcType(finding.type)) return ['OBSERVATION', 'OFI', 'GOOD_PRACTICE'];
  const open = nc !== undefined && (nc.state === 'OPEN' || nc.state === 'ROOT_CAUSE_FOUND');
  return open && nc.ownerId !== personId ? ['MAJOR_NC', 'MINOR_NC'] : [finding.type];
}

/** The clauses a row or finding may name: the audit's, or the system's when it names none. */
function auditClauses(props: AuditRecordProps) {
  const { audit, clauses } = props;
  return audit.clauseIds.length ? clauses.filter((c) => audit.clauseIds.includes(c.id)) : clauses;
}

export function Checklist(props: AuditRecordProps) {
  const { audit, checklist, findings, units, clauses, canConduct } = props;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AuditChecklistItem | null>(null);
  const [finding, setFinding] = useState<AuditChecklistItem | null>(null);
  const open = audit.state === 'PLANNED' || audit.state === 'IN_PROGRESS';
  const clauseName = (id: string) => clauses.find((c) => c.id === id)?.label ?? 'A clause';
  const missing = clausesWithoutResult(audit, checklist);

  return (
    <section aria-labelledby="audit-checklist" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="audit-checklist" className="text-section text-ink">
          Checklist
        </h2>
        {canConduct && open ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add checklist row
          </Button>
        ) : null}
      </div>
      {open && missing.length > 0 ? (
        <p className="text-body text-muted">
          No result yet for {missing.length} of the audit’s {audit.clauseIds.length}{' '}
          {audit.clauseIds.length === 1 ? 'clause' : 'clauses'}:{' '}
          {missing.map(clauseName).join('; ')}.
        </p>
      ) : null}
      {checklist.length === 0 ? (
        <p className="rounded-card border border-line bg-surface p-4 text-body text-muted">
          No checklist row yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {checklist.map((row) => {
            const linked = findings.find((f) => f.id === row.findingId);
            return (
              <li
                key={row.id}
                aria-label={`Checklist row: ${short(row.question)}`}
                className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 whitespace-pre-line text-body text-ink">
                    {row.question}
                  </p>
                  {row.result ? (
                    <StatePill of="ChecklistResult" value={row.result} />
                  ) : (
                    <span className="text-meta text-muted">Not answered</span>
                  )}
                </div>
                <p className="text-meta text-muted">
                  {clauseName(row.clauseId)}
                  {row.unitId
                    ? ` · ${units.find((u) => u.id === row.unitId)?.name ?? 'Unknown unit'}`
                    : ''}
                </p>
                {row.auditorNote ? (
                  <p className="whitespace-pre-line text-body text-ink">{row.auditorNote}</p>
                ) : null}
                {row.notAuditedReason ? (
                  <p className="whitespace-pre-line text-body text-ink">
                    Not audited: {row.notAuditedReason}
                  </p>
                ) : null}
                {linked ? (
                  <p className="text-body text-ink">
                    Finding: {word('FindingType', linked.type)}, {short(linked.description)}
                  </p>
                ) : null}
                {canConduct && open ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(row)}>
                      Answer
                    </Button>
                    {audit.state === 'IN_PROGRESS' && row.result !== 'FINDING' ? (
                      <Button size="sm" variant="secondary" onClick={() => setFinding(row)}>
                        Record finding
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? <RowForm {...props} onClose={() => setAdding(false)} /> : null}
      {editing ? <RowForm {...props} row={editing} onClose={() => setEditing(null)} /> : null}
      {finding ? <FindingForm {...props} row={finding} onClose={() => setFinding(null)} /> : null}
    </section>
  );
}

function RowForm(props: AuditRecordProps & { row?: AuditChecklistItem; onClose: () => void }) {
  const { clientId, audit, findings, auditUnits: unitChoices, row, onClose } = props;
  const options = auditClauses(props);
  const [clauseId, setClauseId] = useState(
    row?.clauseId ?? (options.length === 1 ? options[0]!.id : ''),
  );
  const [unitId, setUnitId] = useState<string | null>(row?.unitId ?? null);
  const [question, setQuestion] = useState(row?.question ?? '');
  const [result, setResult] = useState<ChecklistResult | null>(row?.result ?? null);
  const [note, setNote] = useState(row?.auditorNote ?? '');
  const [reason, setReason] = useState(row?.notAuditedReason ?? '');
  const [findingId, setFindingId] = useState<string | null>(row?.findingId ?? null);
  const { pending, error, save } = useSave();

  const patch: Record<string, unknown> = {};
  if (row) {
    const text = (v: string) => v.trim() || null;
    if (question.trim() !== row.question) patch.question = question.trim();
    if (unitId !== row.unitId) patch.unitId = unitId;
    if (text(note) !== row.auditorNote) patch.auditorNote = text(note);
    const nextFinding = result === 'FINDING' ? findingId : null;
    const nextReason = result === 'NOT_AUDITED' ? text(reason) : null;
    if (result !== row.result) patch.result = result;
    if (nextFinding !== row.findingId) patch.findingId = nextFinding;
    if (nextReason !== row.notAuditedReason) patch.notAuditedReason = nextReason;
  }
  const missing = !row
    ? !clauseId
      ? 'Choose the clause'
      : question.trim() === ''
        ? 'Write the question'
        : undefined
    : Object.keys(patch).length === 0
      ? 'Nothing has changed'
      : question.trim() === ''
        ? 'Write the question'
        : result === 'FINDING' && !findingId
          ? 'Choose the finding, or record one from the row'
          : result === 'NOT_AUDITED' && reason.trim() === ''
            ? 'Say why it was not audited'
            : undefined;

  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={row ? 'Answer checklist row' : 'Add checklist row'}
      submitLabel={row ? 'Save row' : 'Add row'}
      pending={pending}
      error={error}
      disabledReason={missing}
      onSubmit={() =>
        void save(
          () =>
            row
              ? isoWrite(
                  clientId,
                  'updateIsoAuditChecklistItem',
                  { id: audit.id, itemId: row.id },
                  { version: row.version, ...patch } as never,
                )
              : isoWrite(
                  clientId,
                  'createIsoAuditChecklistItem',
                  { id: audit.id },
                  { clauseId, unitId, question: question.trim() },
                ),
          row ? 'The row is saved.' : 'The row is added.',
        ).then((ok) => ok && onClose())
      }
    >
      {!row ? (
        <Select
          label="Clause"
          options={options.map((c) => ({ value: c.id, label: c.label }))}
          value={clauseId || undefined}
          onValueChange={setClauseId}
        />
      ) : null}
      <Select
        label="Unit (optional)"
        options={[
          { value: NONE, label: 'No one unit' },
          ...unitChoices.map((u) => ({ value: u.id, label: u.name })),
        ]}
        value={unitId ?? NONE}
        onValueChange={(v) => setUnitId(v === NONE ? null : v)}
      />
      <Textarea
        label="Question"
        value={question}
        maxLength={2000}
        onChange={(e) => setQuestion(e.target.value)}
      />
      {row ? (
        <>
          <RadioGroup
            label="Result"
            options={[
              { value: NONE, label: 'Not answered' },
              ...ChecklistResult.options.map((r) => ({
                value: r,
                label: WORDS.ChecklistResult[r],
              })),
            ]}
            value={result ?? NONE}
            onValueChange={(v) => setResult(v === NONE ? null : (v as ChecklistResult))}
          />
          {result === 'FINDING' ? (
            <Select
              label="Finding"
              helper="Or close this and record a new finding from the row."
              options={findings.map((f) => ({
                value: f.id,
                label: `${word('FindingType', f.type)}: ${short(f.description)}`,
              }))}
              value={findingId ?? undefined}
              onValueChange={setFindingId}
            />
          ) : null}
          {result === 'NOT_AUDITED' ? (
            <Textarea
              label="Why it was not audited"
              value={reason}
              maxLength={2000}
              onChange={(e) => setReason(e.target.value)}
            />
          ) : null}
          <Textarea
            label="Auditor’s note (optional)"
            helper="What was sampled or seen."
            value={note}
            maxLength={4000}
            onChange={(e) => setNote(e.target.value)}
          />
        </>
      ) : null}
    </FormDrawer>
  );
}

export function Findings(props: AuditRecordProps) {
  const { clientId, audit, findings, ncs, units, clauses, canConduct, canEditFindings } = props;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AuditFinding | null>(null);
  const inProgress = audit.state === 'IN_PROGRESS';
  const clauseName = (id: string) => clauses.find((c) => c.id === id)?.label ?? 'A clause';

  return (
    <section aria-labelledby="audit-findings" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="audit-findings" className="text-section text-ink">
          Findings
        </h2>
        {canConduct && inProgress ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            Record finding
          </Button>
        ) : null}
      </div>
      {findings.length === 0 ? (
        <p className="rounded-card border border-line bg-surface p-4 text-body text-muted">
          {audit.state === 'PLANNED'
            ? 'Findings are recorded once the audit is started.'
            : 'No finding recorded.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {findings.map((f) => {
            const nc = ncs.find((n) => n.id === f.nonconformityId);
            return (
              <li
                key={f.id}
                aria-label={`Finding: ${short(f.description)}`}
                className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <StatePill of="FindingType" value={f.type} />
                  {f.unitId ? (
                    <span className="text-meta text-muted">
                      {units.find((u) => u.id === f.unitId)?.name ?? 'Unknown unit'}
                    </span>
                  ) : null}
                </span>
                <p className="whitespace-pre-line text-body text-ink">{f.description}</p>
                {f.clauseIds.length ? (
                  <p className="text-meta text-muted">{f.clauseIds.map(clauseName).join('; ')}</p>
                ) : null}
                {f.nonconformityId ? (
                  <p className="flex flex-wrap items-center gap-2 text-meta">
                    <NextLink
                      href={`/c/${clientId}/iso/nonconformities/${f.nonconformityId}`}
                      prefetch={false}
                      className="text-forest underline"
                    >
                      Open the nonconformity it raised
                    </NextLink>
                    {nc ? <StatePill of="NcState" value={nc.state} /> : null}
                  </p>
                ) : null}
                {canEditFindings && inProgress ? (
                  <div>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(f)}>
                      Edit finding
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? <FindingForm {...props} onClose={() => setAdding(false)} /> : null}
      {editing ? (
        <FindingForm {...props} finding={editing} onClose={() => setEditing(null)} />
      ) : null}
    </section>
  );
}

function FindingForm(
  props: AuditRecordProps & {
    finding?: AuditFinding;
    /** The checklist row the finding answers, marked FINDING with it. */
    row?: AuditChecklistItem;
    onClose: () => void;
  },
) {
  const {
    clientId,
    audit,
    ncs,
    people,
    personId,
    auditUnits: unitChoices,
    today,
    finding,
    row,
    onClose,
  } = props;
  const nc = ncs.find((n) => n.id === finding?.nonconformityId);
  const types = finding ? findingTypes(finding, nc, personId) : FindingType.options;
  const [type, setType] = useState<FindingType>(finding?.type ?? 'MINOR_NC');
  const [description, setDescription] = useState(finding?.description ?? '');
  const [clauseIds, setClauseIds] = useState<string[]>(
    finding?.clauseIds ?? (row ? [row.clauseId] : []),
  );
  const [unitId, setUnitId] = useState<string | null>(finding?.unitId ?? row?.unitId ?? null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [approverId, setApproverId] = useState<string | null>(null);
  const [dueOn, setDueOn] = useState<string | null>(null);
  const { pending, error, save } = useSave();
  const raises = !finding && isNcType(type);

  const patch: Record<string, unknown> = {};
  if (finding) {
    if (type !== finding.type) patch.type = type;
    if (description.trim() !== finding.description) patch.description = description.trim();
    if (unitId !== finding.unitId) patch.unitId = unitId;
    if (
      clauseIds.length !== finding.clauseIds.length ||
      clauseIds.some((id, i) => id !== finding.clauseIds[i])
    ) {
      patch.clauseIds = clauseIds;
    }
  }
  const missing =
    finding && Object.keys(patch).length === 0
      ? 'Nothing has changed'
      : description.trim() === ''
        ? 'Describe the finding'
        : raises && (!ownerId || !approverId || !dueOn)
          ? 'A nonconformity needs an owner, an approver and a due date'
          : raises && ownerId === approverId
            ? 'The approver is not the owner'
            : undefined;

  return (
    <FormDrawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={finding ? 'Edit finding' : 'Record finding'}
      submitLabel={finding ? 'Save finding' : 'Record finding'}
      pending={pending}
      error={error}
      disabledReason={missing}
      onSubmit={() =>
        void save(
          () =>
            finding
              ? isoWrite(
                  clientId,
                  'updateIsoInternalFinding',
                  { id: audit.id, findingId: finding.id },
                  { version: finding.version, ...patch } as never,
                )
              : isoWrite(
                  clientId,
                  'createIsoInternalFinding',
                  { id: audit.id },
                  {
                    type,
                    clauseIds,
                    unitId,
                    description: description.trim(),
                    ...(row ? { checklistItemId: row.id } : {}),
                    ...(raises
                      ? {
                          nonconformity: {
                            ownerId: ownerId!,
                            approverId: approverId!,
                            dueOn: dueOn!,
                          },
                        }
                      : {}),
                  },
                ),
          finding
            ? 'The finding is saved.'
            : raises
              ? 'The finding is recorded and its nonconformity raised.'
              : 'The finding is recorded.',
        ).then((ok) => ok && onClose())
      }
    >
      {row ? (
        <p className="text-body text-muted">For the checklist row “{short(row.question)}”.</p>
      ) : null}
      <Select
        label="Type"
        options={types.map((t) => ({ value: t, label: WORDS.FindingType[t] }))}
        value={type}
        onValueChange={(v) => setType(v as FindingType)}
      />
      {finding && types.length === 1 ? (
        <p className="text-meta text-muted">
          {nc
            ? nc.ownerId === personId
              ? 'Its type stays: you own the nonconformity it raised.'
              : 'Its type stays: the nonconformity it raised has moved past its root cause.'
            : 'Its type stays.'}
        </p>
      ) : null}
      <Textarea
        label="Description"
        value={description}
        maxLength={4000}
        onChange={(e) => setDescription(e.target.value)}
      />
      <ClausePicker
        label="Clauses (optional)"
        options={auditClauses(props)}
        value={clauseIds}
        onChange={setClauseIds}
        max={20}
      />
      <Select
        label="Unit (optional)"
        options={[
          { value: NONE, label: 'No one unit' },
          ...unitChoices.map((u) => ({ value: u.id, label: u.name })),
        ]}
        value={unitId ?? NONE}
        onValueChange={(v) => setUnitId(v === NONE ? null : v)}
      />
      {raises ? (
        <>
          <p className="text-body text-muted">A nonconformity is raised with it, for:</p>
          <PersonSelect label="Owner" people={people} value={ownerId} onChange={setOwnerId} />
          <PersonSelect
            label="Approver"
            people={people}
            value={approverId}
            onChange={setApproverId}
          />
          <DateInput
            label="Due on"
            value={dueOn}
            onValueChange={setDueOn}
            min={today}
            today={today}
          />
          {ownerId && approverId ? (
            <p className="text-meta text-muted">
              {nameOf(people, ownerId)} works on it; {nameOf(people, approverId)} approves.
            </p>
          ) : null}
        </>
      ) : null}
    </FormDrawer>
  );
}

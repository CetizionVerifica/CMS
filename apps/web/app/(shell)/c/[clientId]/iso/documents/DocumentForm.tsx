'use client';
// Adding a controlled document and editing its own fields (model §3.4). Code and type are set once. A form has a
// retention rule; an external document has an issuer and the issuer's reference. A new owner or approver, or a moved
// review date, needs a reason.
import type { DocumentType, DocumentView, ManagementSystem } from '@canopy/contracts';
import { DateInput, Input, Select, Textarea } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { isoWrite } from '../_lib/actions';
import type { PersonOption } from '../_lib/people';
import { WORDS } from '../_lib/words';
import { ClausePicker, type ClauseOption } from '../_components/ClausePicker';
import { FormDrawer, PersonSelect, useSave } from '../_components/controls';

export type DocumentFormProps = {
  clientId: string;
  people: PersonOption[];
  today: string;
  onClose: () => void;
};

type Fields = {
  title: string;
  clauseIds: string[];
  ownerId: string | null;
  approverId: string | null;
  reviewDueOn: string | null;
  retention: string;
  issuer: string;
  externalRef: string;
};

function TypeFields({
  type,
  fields,
  set,
}: {
  type: string;
  fields: Fields;
  set: (patch: Partial<Fields>) => void;
}) {
  if (type === 'FORM') {
    return (
      <Textarea
        label="Retention"
        helper="How long records made on this form are kept, where, and how they are disposed of."
        value={fields.retention}
        maxLength={2000}
        onChange={(e) => set({ retention: e.target.value })}
      />
    );
  }
  if (type === 'EXTERNAL') {
    return (
      <>
        <Input
          label="Issuer"
          helper="Who publishes it: a regulator, a customer, a standards body."
          value={fields.issuer}
          maxLength={200}
          onChange={(e) => set({ issuer: e.target.value })}
        />
        <Input
          label="Issuer's reference"
          value={fields.externalRef}
          maxLength={200}
          onChange={(e) => set({ externalRef: e.target.value })}
        />
      </>
    );
  }
  return null;
}

function typeValues(type: string, f: Fields) {
  return {
    retention: type === 'FORM' ? f.retention.trim() || null : null,
    issuer: type === 'EXTERNAL' ? f.issuer.trim() || null : null,
    externalRef: type === 'EXTERNAL' ? f.externalRef.trim() || null : null,
  };
}

export function NewDocument({
  clientId,
  people,
  today,
  onClose,
  systems,
  clauseOptions,
  ownerOnly,
}: DocumentFormProps & {
  systems: Pick<ManagementSystem, 'id' | 'name'>[];
  /** Clause choices per system. */
  clauseOptions: Record<string, ClauseOption[]>;
  /** An owner adds documents only as their owner: the person's own id. */
  ownerOnly: string | null;
}) {
  const router = useRouter();
  const [systemId, setSystemId] = useState(systems[0]?.id ?? '');
  const [code, setCode] = useState('');
  const [type, setType] = useState<string>('PROCEDURE');
  const [fields, setFields] = useState<Fields>({
    title: '',
    clauseIds: [],
    ownerId: ownerOnly,
    approverId: null,
    reviewDueOn: null,
    retention: '',
    issuer: '',
    externalRef: '',
  });
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));
  const { pending, error, save } = useSave();

  const missing =
    code.trim() === ''
      ? 'Give the document a code'
      : fields.title.trim() === ''
        ? 'Give the document a title'
        : !fields.ownerId
          ? 'Choose an owner'
          : !fields.approverId
            ? 'Choose an approver'
            : undefined;

  const submit = async () => {
    let createdId: string | null = null;
    const ok = await save(async () => {
      const result = await isoWrite(
        clientId,
        'createIsoDocument',
        {},
        {
          managementSystemId: systemId,
          code: code.trim(),
          title: fields.title.trim(),
          type: type as DocumentType,
          clauseIds: fields.clauseIds,
          ownerId: fields.ownerId!,
          approverId: fields.approverId!,
          reviewDueOn: fields.reviewDueOn,
          ...typeValues(type, fields),
        },
      );
      if (result.ok) createdId = result.data.id;
      return result;
    }, 'The document is added. Draft its first revision next.');
    if (ok && createdId) router.push(`/c/${clientId}/iso/documents/${createdId}`);
  };

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Add document"
      submitLabel="Add document"
      pending={pending}
      error={error}
      disabledReason={missing}
      onSubmit={() => void submit()}
    >
      {systems.length > 1 ? (
        <Select
          label="Management system"
          options={systems.map((s) => ({ value: s.id, label: s.name }))}
          value={systemId}
          onValueChange={(v) => {
            setSystemId(v);
            set({ clauseIds: [] });
          }}
        />
      ) : null}
      <Input
        label="Code"
        helper="The client's own code, unique for the client, e.g. QP-07."
        value={code}
        maxLength={50}
        onChange={(e) => setCode(e.target.value)}
      />
      <Input
        label="Title"
        value={fields.title}
        maxLength={300}
        onChange={(e) => set({ title: e.target.value })}
      />
      <Select
        label="Type"
        options={Object.entries(WORDS.DocumentType).map(([value, label]) => ({ value, label }))}
        value={type}
        onValueChange={setType}
      />
      <TypeFields type={type} fields={fields} set={set} />
      <ClausePicker
        label="Clauses"
        helper="The clauses this document answers to."
        options={clauseOptions[systemId] ?? []}
        value={fields.clauseIds}
        onChange={(clauseIds) => set({ clauseIds })}
      />
      {ownerOnly ? (
        <p className="text-body">
          <span className="text-muted">Owner: </span>you
        </p>
      ) : (
        <PersonSelect
          label="Owner"
          helper="Drafts and submits its revisions."
          people={people}
          value={fields.ownerId}
          onChange={(ownerId) => set({ ownerId })}
          none="Choose someone"
        />
      )}
      <PersonSelect
        label="Approver"
        helper="Approves its revisions and reviews it. Whoever prepares a revision never approves it."
        people={people}
        value={fields.approverId}
        onChange={(approverId) => set({ approverId })}
        none="Choose someone"
      />
      <DateInput
        label="Review due"
        value={fields.reviewDueOn}
        onValueChange={(reviewDueOn) => set({ reviewDueOn })}
        min={today}
        today={today}
      />
    </FormDrawer>
  );
}

export function EditDocument({
  clientId,
  people,
  today,
  onClose,
  doc,
  clauseOptions,
  canReassign,
}: DocumentFormProps & {
  doc: DocumentView;
  clauseOptions: ClauseOption[];
  /** Managers may name a new owner; an owner edits their own document but does not hand it on. */
  canReassign: boolean;
}) {
  const [fields, setFields] = useState<Fields>({
    title: doc.title,
    clauseIds: doc.clauseIds,
    ownerId: doc.ownerId,
    approverId: doc.approverId,
    reviewDueOn: doc.reviewDueOn,
    retention: doc.retention ?? '',
    issuer: doc.issuer ?? '',
    externalRef: doc.externalRef ?? '',
  });
  const [reason, setReason] = useState('');
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));
  const { pending, error, save } = useSave();

  const body: Record<string, unknown> = { version: doc.version };
  if (fields.title.trim() !== doc.title) body.title = fields.title.trim();
  if ([...fields.clauseIds].sort().join() !== [...doc.clauseIds].sort().join())
    body.clauseIds = fields.clauseIds;
  if (fields.ownerId !== doc.ownerId) body.ownerId = fields.ownerId;
  if (fields.approverId !== doc.approverId) body.approverId = fields.approverId;
  if (fields.reviewDueOn !== doc.reviewDueOn) body.reviewDueOn = fields.reviewDueOn;
  const typed = typeValues(doc.type, fields);
  if (doc.type === 'FORM' && typed.retention !== doc.retention) body.retention = typed.retention;
  if (doc.type === 'EXTERNAL') {
    if (typed.issuer !== doc.issuer) body.issuer = typed.issuer;
    if (typed.externalRef !== doc.externalRef) body.externalRef = typed.externalRef;
  }
  const needsReason = 'ownerId' in body || 'approverId' in body || 'reviewDueOn' in body;
  if (needsReason) body.reason = reason.trim();
  const changed = Object.keys(body).filter((k) => k !== 'version' && k !== 'reason').length > 0;

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title="Edit document"
      submitLabel="Save document"
      pending={pending}
      error={error}
      disabledReason={
        !changed
          ? 'Nothing has changed'
          : fields.title.trim() === ''
            ? 'Give the document a title'
            : needsReason && reason.trim() === ''
              ? 'Say why the owner, approver or review date changes'
              : undefined
      }
      onSubmit={() =>
        void save(
          () => isoWrite(clientId, 'updateIsoDocument', { id: doc.id }, body as never),
          'The document is saved.',
        ).then((ok) => ok && onClose())
      }
    >
      <Input
        label="Title"
        value={fields.title}
        maxLength={300}
        onChange={(e) => set({ title: e.target.value })}
      />
      <TypeFields type={doc.type} fields={fields} set={set} />
      <ClausePicker
        label="Clauses"
        helper="The clauses this document answers to."
        options={clauseOptions}
        value={fields.clauseIds}
        onChange={(clauseIds) => set({ clauseIds })}
      />
      {canReassign ? (
        <PersonSelect
          label="Owner"
          people={people}
          value={fields.ownerId}
          onChange={(ownerId) => ownerId && set({ ownerId })}
        />
      ) : null}
      <PersonSelect
        label="Approver"
        people={people}
        value={fields.approverId}
        onChange={(approverId) => approverId && set({ approverId })}
      />
      <DateInput
        label="Review due"
        value={fields.reviewDueOn}
        onValueChange={(reviewDueOn) => set({ reviewDueOn })}
        today={today}
      />
      {needsReason ? (
        <Input
          label="Why the owner, approver or review date changes"
          value={reason}
          maxLength={2000}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      ) : null}
    </FormDrawer>
  );
}

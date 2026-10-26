'use client';
// Certificates (model §3.9): one per standard of a system and certification body. Being pursued, it shows no number
// or dates; issued, it shows them with its surveillance and recertification dates. Managers add and edit them.
import type { CertificationView, IsoStandard, ManagementSystem } from '@canopy/contracts';
import { Button, Checkbox, DateInput, formatDate, Input, Select, Textarea } from '@canopy/ui';
import NextLink from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { isoWrite } from '../_lib/actions';
import { standardTitle } from '../_lib/words';
import { FormDrawer, useSave } from '../_components/controls';
import { withOpen } from '../_components/IsoFilterBar';
import { IsoPill } from '../_components/IsoStates';
import { certificatesToShow, cycleLine, isIssued } from './certification-model';

type UnitOption = { id: string; name: string };
type SystemOption = Pick<ManagementSystem, 'id' | 'name' | 'standardIds' | 'unitIds'>;

export type CertificatesProps = {
  clientId: string;
  certificates: CertificationView[];
  standards: IsoStandard[];
  systems: SystemOption[];
  units: UnitOption[];
  /** The exact certificates an overview number counted. */
  ids: string[];
  clearHref: string;
  canManage: boolean;
  today: string;
};

export function Certificates(props: CertificatesProps) {
  const { certificates, standards, systems, units, ids, clearHref, canManage } = props;
  const pathname = usePathname();
  const params = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CertificationView | null>(null);
  const order = systems.flatMap((s) => s.standardIds);
  const shown = certificatesToShow(certificates, ids, order);
  const unitNames = (list: readonly string[]) =>
    list.map((id) => units.find((u) => u.id === id)?.name ?? 'Unknown unit').join(', ');
  const auditHref = (id: string) =>
    withOpen(pathname, new URLSearchParams(params.toString()), 'audit', id);

  return (
    <section aria-labelledby="certificates" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="certificates" className="text-section text-ink">
          Certificates
        </h2>
        {canManage ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add certificate
          </Button>
        ) : null}
      </div>
      {ids.length > 0 ? (
        <p className="text-body text-muted">
          Showing the certificates the ISO overview counted.{' '}
          <NextLink href={clearHref} prefetch={false} className="text-forest underline">
            Show all certificates
          </NextLink>
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="rounded-card border border-line bg-surface p-4 text-body text-muted">
          {ids.length > 0
            ? 'None of the certificates the overview counted can be shown.'
            : 'No certificate yet. Add the one the client holds or is working towards.'}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {shown.map((c) => {
            const issued = isIssued(c);
            const system = systems.find((s) => s.id === c.managementSystemId);
            return (
              <li
                key={c.id}
                aria-label={`${standardTitle(standards, c.standardId)} certificate, ${c.body}`}
                className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-body font-semibold text-ink">
                    {standardTitle(standards, c.standardId)}
                    <span className="font-normal text-muted"> from {c.body}</span>
                  </h3>
                  <IsoPill tone={issued ? 'ok' : 'neutral'}>
                    {issued ? 'Issued' : 'Being pursued'}
                  </IsoPill>
                </div>
                <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1.5 text-body">
                  {issued ? (
                    <>
                      <dt className="text-muted">Number</dt>
                      <dd>{c.certificateNumber}</dd>
                      <dt className="text-muted">Valid</dt>
                      <dd>
                        {formatDate(c.issuedOn!)} to {formatDate(c.expiresOn!)}
                      </dd>
                    </>
                  ) : null}
                  {systems.length > 1 ? (
                    <>
                      <dt className="text-muted">System</dt>
                      <dd>{system?.name ?? 'Unknown system'}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted">Units</dt>
                  <dd>{c.unitIds.length ? unitNames(c.unitIds) : "The system's units"}</dd>
                  <dt className="text-muted">Scope</dt>
                  <dd className="whitespace-pre-line">{c.scopeText ?? "The system's scope"}</dd>
                </dl>
                {c.cycle.items.length > 0 ? (
                  <ul
                    aria-label="Surveillance and recertification"
                    className="flex flex-col gap-1.5"
                  >
                    {c.cycle.items.map((item) => {
                      const line = cycleLine(item);
                      return (
                        <li key={item.kind} className="flex flex-wrap items-center gap-2 text-body">
                          <span className="text-ink">{line.label}</span>
                          <IsoPill tone={line.tone}>{line.text}</IsoPill>
                          {item.metByAuditId ? (
                            <NextLink
                              href={auditHref(item.metByAuditId)}
                              scroll={false}
                              prefetch={false}
                              className="text-meta text-forest underline"
                            >
                              The visit
                            </NextLink>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {canManage ? (
                  <div>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                      {issued ? 'Edit certificate' : 'Edit or record issued'}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? <CertificateForm {...props} onClose={() => setAdding(false)} /> : null}
      {editing ? (
        <CertificateForm {...props} cert={editing} onClose={() => setEditing(null)} />
      ) : null}
    </section>
  );
}

function CertificateForm({
  clientId,
  standards,
  systems,
  units,
  today,
  cert,
  onClose,
}: CertificatesProps & { cert?: CertificationView; onClose: () => void }) {
  const [systemId, setSystemId] = useState(cert?.managementSystemId ?? systems[0]?.id ?? '');
  const system = systems.find((s) => s.id === systemId);
  const [standardId, setStandardId] = useState(cert?.standardId ?? system?.standardIds[0] ?? '');
  const [body, setBody] = useState(cert?.body ?? '');
  const [issued, setIssued] = useState(cert ? isIssued(cert) : false);
  const [number, setNumber] = useState(cert?.certificateNumber ?? '');
  const [issuedOn, setIssuedOn] = useState<string | null>(cert?.issuedOn ?? null);
  const [expiresOn, setExpiresOn] = useState<string | null>(cert?.expiresOn ?? null);
  const [scope, setScope] = useState(cert?.scopeText ?? '');
  const [unitIds, setUnitIds] = useState<string[]>(cert?.unitIds ?? []);
  const { pending, error, save } = useSave();
  const systemUnits = system?.unitIds.length
    ? units.filter((u) => system.unitIds.includes(u.id))
    : units;

  const values = {
    body: body.trim(),
    certificateNumber: issued ? number.trim() : null,
    issuedOn: issued ? issuedOn : null,
    expiresOn: issued ? expiresOn : null,
    scopeText: scope.trim() || null,
    unitIds,
  };
  const missing =
    values.body === ''
      ? 'Name the certification body'
      : issued && (!values.certificateNumber || !issuedOn || !expiresOn)
        ? 'An issued certificate needs its number, issue date and expiry date'
        : issued && expiresOn! <= issuedOn!
          ? 'The expiry date comes after the issue date'
          : undefined;

  const submit = () => {
    if (!cert) {
      return save(
        () =>
          isoWrite(
            clientId,
            'createIsoCertification',
            {},
            {
              managementSystemId: systemId,
              standardId,
              ...values,
            },
          ),
        'The certificate is added.',
      );
    }
    const patch: Record<string, unknown> = { version: cert.version };
    for (const [key, value] of Object.entries(values)) {
      const before = cert[key as keyof typeof values];
      const same = Array.isArray(value)
        ? [...value].sort().join() === [...(before as string[])].sort().join()
        : value === before;
      if (!same) patch[key] = value;
    }
    if (Object.keys(patch).length === 1) {
      onClose();
      return Promise.resolve(false);
    }
    return save(
      () => isoWrite(clientId, 'updateIsoCertification', { id: cert.id }, patch as never),
      'The certificate is saved.',
    );
  };

  return (
    <FormDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={cert ? 'Edit certificate' : 'Add certificate'}
      submitLabel={cert ? 'Save certificate' : 'Add certificate'}
      pending={pending}
      error={error}
      disabledReason={missing}
      onSubmit={() => void submit().then((ok) => ok && onClose())}
    >
      {!cert && systems.length > 1 ? (
        <Select
          label="Management system"
          options={systems.map((s) => ({ value: s.id, label: s.name }))}
          value={systemId}
          onValueChange={(v) => {
            setSystemId(v);
            setStandardId(systems.find((s) => s.id === v)?.standardIds[0] ?? '');
            setUnitIds([]);
          }}
        />
      ) : null}
      {cert ? (
        <p className="text-body">
          <span className="text-muted">Standard: </span>
          {standardTitle(standards, cert.standardId)}
        </p>
      ) : (
        <Select
          label="Standard"
          options={(system?.standardIds ?? []).map((id) => ({
            value: id,
            label: standardTitle(standards, id),
          }))}
          value={standardId}
          onValueChange={setStandardId}
        />
      )}
      <Input
        label="Certification body"
        value={body}
        maxLength={200}
        onChange={(e) => setBody(e.target.value)}
      />
      <Checkbox
        label="The certificate has been issued"
        checked={issued}
        onCheckedChange={(checked) => setIssued(checked === true)}
      />
      {issued ? (
        <>
          <Input
            label="Certificate number"
            value={number}
            maxLength={100}
            onChange={(e) => setNumber(e.target.value)}
          />
          <DateInput
            label="Issued on"
            value={issuedOn}
            onValueChange={setIssuedOn}
            max={today}
            today={today}
          />
          <DateInput
            label="Expires on"
            value={expiresOn}
            onValueChange={setExpiresOn}
            min={issuedOn ?? undefined}
            today={today}
          />
        </>
      ) : null}
      <Textarea
        label="Scope on the certificate"
        helper="Leave empty when it is the system's scope."
        value={scope}
        maxLength={4000}
        onChange={(e) => setScope(e.target.value)}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-meta text-ink">Units</legend>
        <p className="text-meta text-muted">None chosen means the system&apos;s units.</p>
        {systemUnits.map((u) => (
          <Checkbox
            key={u.id}
            label={u.name}
            checked={unitIds.includes(u.id)}
            onCheckedChange={(checked) =>
              setUnitIds((list) =>
                checked === true ? [...list, u.id] : list.filter((id) => id !== u.id),
              )
            }
          />
        ))}
      </fieldset>
    </FormDrawer>
  );
}

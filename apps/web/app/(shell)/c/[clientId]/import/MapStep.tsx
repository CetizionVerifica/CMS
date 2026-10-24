'use client';
// Step 2: each column of the sheet and the register field it fills. The API's suggestion is already saved on the
// batch, so this screen can be resumed; "Read the rows" saves the person's choice and starts the parse.
import type { ColumnMapping } from '@canopy/contracts';
import { Button, Input, Select } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { mapAndParseAction } from './actions';
import { CancelImport } from './CancelImport';
import {
  batchHref,
  duplicateFields,
  FIELD_LABEL,
  FIELD_OPTIONS,
  IGNORE,
  mappingFromValues,
} from './import-model';

export type MapStepProps = {
  clientId: string;
  batchId: string;
  fileName: string;
  sheetName: string;
  mapping: ColumnMapping;
};

export function MapStep({ clientId, batchId, fileName, sheetName, mapping }: MapStepProps) {
  const router = useRouter();
  const headers = mapping.map((m) => m.sourceHeader);
  const [values, setValues] = useState<string[]>(() => mapping.map((m) => m.field ?? IGNORE));
  const [templateName, setTemplateName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = mappingFromValues(headers, values);
  const duplicates = duplicateFields(next);
  const mapped = next.filter((m) => m.field !== null).length;

  const submit = async () => {
    setPending(true);
    setError(null);
    const result = await mapAndParseAction(clientId, batchId, sheetName, next, templateName);
    if (!result.ok) {
      setError(result.message);
      setPending(false);
      return;
    }
    router.push(batchHref(clientId, batchId, 'parsing'));
  };

  return (
    <section aria-labelledby="map-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="map-heading" className="text-card text-ink">
          Map the columns
        </h2>
        <p className="text-body text-muted">
          {fileName}, sheet “{sheetName}”. {mapped} of {headers.length} columns are mapped; the
          others are ignored.
        </p>
      </div>
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full text-body">
          <caption className="sr-only">Column mapping</caption>
          <thead>
            <tr className="border-b border-line text-left text-meta text-muted">
              <th scope="col" className="px-4 py-2 font-semibold">
                Column in the workbook
              </th>
              <th scope="col" className="px-4 py-2 font-semibold">
                Register field
              </th>
            </tr>
          </thead>
          <tbody>
            {headers.map((header, i) => (
              <tr key={header} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-4 py-2 text-left font-normal text-ink">
                  {header}
                </th>
                <td className="px-4 py-2">
                  <Select
                    label={`Register field for “${header}”`}
                    hideLabel
                    options={FIELD_OPTIONS}
                    value={values[i]}
                    onValueChange={(value) =>
                      setValues((current) => current.map((v, j) => (j === i ? value : v)))
                    }
                    className="min-w-56"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {duplicates.length > 0 ? (
        <p role="alert" className="text-body text-crit-ink">
          Each field can come from one column only. Choose one column for{' '}
          {duplicates.map((f) => FIELD_LABEL[f]).join(', ')}.
        </p>
      ) : null}
      <Input
        label="Save this mapping as a template (optional)"
        helper="Name it to reuse it for this client's next import."
        value={templateName}
        maxLength={300}
        onChange={(e) => setTemplateName(e.target.value)}
        className="max-w-md"
      />
      {error ? (
        <p role="alert" className="text-body text-crit-ink">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => void submit()}
          loading={pending}
          disabledReason={
            duplicates.length > 0
              ? 'Choose one column for each field first'
              : mapped === 0
                ? 'Map at least one column first'
                : undefined
          }
        >
          Read the rows
        </Button>
        <CancelImport clientId={clientId} batchId={batchId} />
      </div>
    </section>
  );
}

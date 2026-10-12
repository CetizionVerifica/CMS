import { useState } from 'react';

import { Checkbox, Combobox, Input, RadioGroup, Select, Switch, Textarea } from '../../src';
import { Page, Section } from '../Page';

const units = [
  { value: 'riverbend', label: 'Kestrel Aluminium Riverbend', description: 'Metals · 1 unit' },
  { value: 'stonebridge', label: 'Kestrel Aluminium Stonebridge', description: 'Metals · 3 units' },
  { value: 'taloja', label: 'Taloja plant', description: 'Chemicals · 1 unit' },
  { value: 'highmoor', label: 'Highmoor smelter', description: 'Metals · 2 units' },
];

export function FieldsPage() {
  const [unit, setUnit] = useState<string | null>('riverbend');
  const [dept, setDept] = useState<string>('');
  return (
    <Page
      title="Form controls"
      intro="Label above, helper and error below. Borders use --line-strong for 3:1."
    >
      <Section title="Text" className="grid gap-4 sm:grid-cols-2">
        <Input label="Challan number" helper="As printed on the receipt" placeholder="CH-0000" />
        <Input label="Amount paid" error="Enter the amount in rupees" defaultValue="abc" />
        <Input label="Obligation ID" disabled defaultValue="TAX-CL-033" />
        <Textarea label="Reason for sending back" helper="The owner sees this in the timeline" />
      </Section>
      <Section title="Select and combobox" className="grid gap-4 sm:grid-cols-2">
        <Select
          label="Department"
          value={dept}
          onValueChange={setDept}
          options={[
            { value: 'hr', label: 'Human resources' },
            { value: 'ehs', label: 'EHS' },
            { value: 'finance', label: 'Finance' },
            { value: 'legal', label: 'Legal', disabled: true },
          ]}
        />
        <Select
          label="Approver"
          error="Choose an approver"
          options={[{ value: 'r', label: 'Rohit Agarwal' }]}
        />
        <Combobox
          label="Unit"
          options={units}
          value={unit}
          onValueChange={setUnit}
          placeholder="Find a unit"
        />
        <Combobox
          label="Unit (empty)"
          options={units}
          value={null}
          onValueChange={() => {}}
          helper="Type to filter"
        />
      </Section>
      <Section title="Checkbox, radio and switch" className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col">
          <Checkbox label="Super critical only" />
          <Checkbox label="Overdue" defaultChecked />
          <Checkbox label="Select all 424 instances" checked="indeterminate" />
          <Checkbox label="Archived" disabled />
        </div>
        <RadioGroup
          label="Density"
          defaultValue="comfortable"
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
        <div className="flex flex-col">
          <Switch label="Email reminders" defaultChecked />
          <Switch label="Weekly digest" />
          <Switch label="SMS (not available)" disabled />
        </div>
      </Section>
    </Page>
  );
}

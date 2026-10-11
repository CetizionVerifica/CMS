import { useState } from 'react';

import { ClientSwitcher, DateInput, PeriodPicker, type Period } from '../../src';
import { demoClients, demoFys } from '../fixtures';
import { Page, Section } from '../Page';

const stay = (id: string) => `#/context?client=${id}`;
const navigate = (href: string) => {
  window.location.hash = href.slice(1);
};

function DemoPeriod({
  initial,
  ...rest
}: { initial: Period } & Partial<Parameters<typeof PeriodPicker>[0]>) {
  const [value, setValue] = useState(initial);
  return (
    <PeriodPicker
      value={value}
      onChange={setValue}
      availableFys={demoFys}
      thisPeriod={{ fy: '2022-23', quarter: 3 }}
      {...rest}
    />
  );
}

export function ContextPage() {
  const [due, setDue] = useState<string | null>('2027-03-31');
  const [filed, setFiled] = useState<string | null>(null);
  return (
    <Page
      title="ClientSwitcher, PeriodPicker and DateInput"
      intro="Top-bar context: which client and which period every page shows. Ctrl+K opens the client switcher."
    >
      <Section title="ClientSwitcher">
        <ClientSwitcher
          current={demoClients[0]}
          clients={demoClients}
          recentIds={['tp', 'hb', 'sc', 'ak']}
          hrefFor={stay}
          onNavigate={navigate}
          overviewHref="#/context"
        />
        <ClientSwitcher
          shortcut={false}
          current={demoClients[6]}
          clients={demoClients}
          hrefFor={stay}
          onNavigate={navigate}
          overviewHref="#/context"
        />
      </Section>
      <Section title="No client yet, loading and a single client">
        <ClientSwitcher
          shortcut={false}
          clients={demoClients}
          hrefFor={stay}
          onNavigate={navigate}
          overviewHref="#/context"
        />
        <ClientSwitcher
          shortcut={false}
          current={demoClients[1]}
          clients={[]}
          loading
          hrefFor={stay}
          onNavigate={navigate}
          overviewHref="#/context"
        />
        <ClientSwitcher
          shortcut={false}
          current={demoClients[3]}
          clients={[demoClients[3]!]}
          hrefFor={stay}
        />
      </Section>
      <Section title="PeriodPicker">
        <DemoPeriod initial={{ fy: '2022-23' }} />
        <DemoPeriod initial={{ fy: '2022-23', quarter: 3 }} />
        <DemoPeriod initial={{ fy: '2022-23', month: '2022-10' }} availableUntil="2023-01" />
        <DemoPeriod
          initial={{ fy: '2022-23', quarter: 1 }}
          fyStartMonth={1}
          thisPeriod={undefined}
        />
      </Section>
      <Section title="DateInput" className="grid max-w-md gap-4">
        <DateInput label="Due date" value={due} onValueChange={setDue} today="2027-03-10" />
        <DateInput
          label="Filed on"
          value={filed}
          onValueChange={setFiled}
          today="2027-03-10"
          min="2026-04-01"
          max="2027-03-31"
          helper="Within FY 2026–27"
        />
        <DateInput label="Locked date" value="2027-03-31" onValueChange={() => {}} disabled />
      </Section>
    </Page>
  );
}

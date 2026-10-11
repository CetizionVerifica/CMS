import { Check, Download, MoreHorizontal, Plus, Send, Undo2 } from 'lucide-react';
import { useState } from 'react';

import { Button, IconButton } from '../../src';
import { Page, Section } from '../Page';

export function ButtonsPage() {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  return (
    <Page
      title="Button and IconButton"
      intro="Sentence case, verb first. One primary button per view region."
    >
      <Section title="Variants">
        <Button variant="primary" icon={Send} onClick={() => setCount((c) => c + 1)}>
          Submit for approval
        </Button>
        <Button variant="secondary" icon={Undo2}>
          Send back
        </Button>
        <Button variant="ghost">View all</Button>
        <Button variant="danger">Remove evidence</Button>
        <span role="status" className="text-meta text-muted">
          Submitted {count} times
        </span>
      </Section>
      <Section title="Sizes">
        <Button variant="primary" icon={Check}>
          Approve
        </Button>
        <Button size="sm" icon={Download}>
          Export
        </Button>
        <IconButton label="Add obligation" icon={Plus} />
        <IconButton label="More actions" icon={MoreHorizontal} size="sm" />
        <IconButton label="Assign obligation" icon={Plus} variant="primary" />
        <IconButton label="Download register" icon={Download} variant="secondary" />
      </Section>
      <Section title="States">
        <Button variant="primary" disabledReason="Only the approver can approve">
          Approve
        </Button>
        <Button disabled>Export</Button>
        <Button
          variant="primary"
          loading={loading}
          onClick={() => {
            setLoading(true);
            setTimeout(() => setLoading(false), 1500);
          }}
        >
          Save view
        </Button>
        <Button asChild variant="secondary" icon={Download}>
          <a href="#/button">Download as link</a>
        </Button>
      </Section>
    </Page>
  );
}

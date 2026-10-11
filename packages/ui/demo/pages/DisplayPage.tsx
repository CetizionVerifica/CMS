import { useState } from 'react';

import { Avatar, AvatarGroup, Badge, Button, Link, LoadingRegion, Skeleton } from '../../src';
import { Page, Section } from '../Page';

export function DisplayPage() {
  const [loading, setLoading] = useState(true);
  return (
    <Page title="Avatar, badge, skeleton and link">
      <Section title="Avatar">
        <Avatar name="Priya Rane" size={24} />
        <Avatar name="Rohit Agarwal" size={32} />
        <Avatar name="Asha Iyer" size={40} />
        <AvatarGroup
          people={[
            { name: 'Priya Rane' },
            { name: 'Rohit Agarwal' },
            { name: 'Asha Iyer' },
            { name: 'Vik Rao' },
            { name: 'Neha Shah' },
          ]}
        />
      </Section>
      <Section title="Badge">
        <span className="inline-flex items-center gap-2 text-body text-ink">
          Approvals <Badge count={4} label="4 waiting" />
        </span>
        <span className="inline-flex items-center gap-2 text-body text-ink">
          Overdue <Badge count={120} label="120 overdue" />
        </span>
        <span
          data-surface="forest"
          className="inline-flex items-center gap-2 rounded-chip bg-forest px-3 py-2 text-body text-on-forest"
        >
          Approvals <Badge count={4} label="4 waiting" on="forest" />
        </span>
      </Section>
      <Section title="Skeleton" className="flex flex-col items-start gap-3">
        <Button size="sm" onClick={() => setLoading((l) => !l)}>
          {loading ? 'Show content' : 'Show loading'}
        </Button>
        <LoadingRegion
          loading={loading}
          label="Loading overview"
          className="w-full"
          skeleton={
            <div className="flex w-full flex-col gap-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          }
        >
          <p className="text-body text-ink">5 items are overdue, 2 are super critical.</p>
        </LoadingRegion>
      </Section>
      <Section title="Link">
        <Link href="#/display">View all</Link>
        <p className="text-body text-ink">
          Read the{' '}
          <Link href="https://www.indiacode.nic.in" external inline>
            Income-tax Act, 1961
          </Link>{' '}
          before marking this not applicable.
        </p>
      </Section>
    </Page>
  );
}

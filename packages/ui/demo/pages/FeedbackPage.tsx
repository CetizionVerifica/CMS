import { Building2 } from 'lucide-react';

import { Button, EmptyState, toast, Toaster } from '../../src';
import { Page, Section } from '../Page';

export function FeedbackPage() {
  return (
    <Page
      title="EmptyState and Toast"
      intro="What a region shows when there is nothing to show, and brief confirmations of what the user just did."
    >
      <Section title="EmptyState variants" className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-card border border-line">
          <EmptyState
            variant="first-use"
            icon={Building2}
            title="No obligations yet"
            body="Import your compliance register to get started."
            action={{ label: 'Import register', href: '#/feedback' }}
          />
        </div>
        <div className="rounded-card border border-line">
          <EmptyState
            variant="no-results"
            title="No instances match these filters"
            body="Try removing a filter or widening the period."
            action={{ label: 'Clear filters', onClick: () => {} }}
          />
        </div>
        <div className="rounded-card border border-line">
          <EmptyState
            variant="no-permission"
            title="You don't have access to this"
            body="Ask a consultant at your firm to add you to this client."
            action={{ label: 'Back to overview', href: '#/' }}
          />
        </div>
        <div className="rounded-card border border-line">
          <EmptyState
            variant="error"
            title="Couldn't load the register"
            body="Check your connection and try again."
            action={{ label: 'Retry', onClick: () => {} }}
            errorId="7f3a9c21"
          />
        </div>
        <div className="rounded-card border border-line">
          <EmptyState variant="done" title="You're all caught up" />
        </div>
      </Section>
      <Section title="Toast (F8 moves focus to the toasts)">
        <Button
          onClick={() =>
            toast({
              tone: 'success',
              message: 'Approved. 3 left in your queue.',
              action: { label: 'Undo', onClick: () => {} },
            })
          }
        >
          Success with Undo
        </Button>
        <Button onClick={() => toast({ tone: 'info', message: 'Copied ID' })}>Info</Button>
        <Button
          onClick={() => toast({ tone: 'warn', message: 'Saved, but 2 files are still scanning' })}
        >
          Warning
        </Button>
        <Button onClick={() => toast({ tone: 'error', message: "Couldn't approve. Try again." })}>
          Error
        </Button>
      </Section>
      <Toaster />
    </Page>
  );
}

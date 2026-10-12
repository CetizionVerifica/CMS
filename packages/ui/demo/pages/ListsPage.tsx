import { useState } from 'react';

import {
  ConfirmDialog,
  DeadlineList,
  TaskList,
  toast,
  Toaster,
  type DeadlineItem,
  type TaskItem,
} from '../../src';
import { Page, Section } from '../Page';

// The API supplies `today`, statuses and day counts; the demo hard-codes them.
const today = '2027-03-10';

const deadlines: DeadlineItem[] = [
  {
    id: 'i-101',
    dueDate: '2027-03-10',
    title: 'Monthly PF challan',
    meta: 'Belur · Priya Rane',
    status: 'DUE_SOON',
    days: 0,
    href: '#/lists',
  },
  {
    id: 'i-102',
    dueDate: '2027-03-12',
    title: 'ESI contribution',
    meta: 'Belur · Arun Mehta',
    status: 'DUE_SOON',
    days: 2,
    href: '#/lists',
  },
  {
    id: 'i-103',
    dueDate: '2027-03-15',
    title: 'TDS return (24Q)',
    meta: 'Head office · Kavya Iyer',
    status: 'UPCOMING',
    href: '#/lists',
  },
  {
    id: 'i-104',
    dueDate: '2027-03-08',
    title: 'Fire safety drill record',
    meta: 'Hosur · Ravi Kumar',
    status: 'OVERDUE',
    days: 2,
    href: '#/lists',
  },
  {
    id: 'i-105',
    dueDate: '2027-03-20',
    title: 'Consent to operate renewal',
    meta: 'Hosur · Ravi Kumar',
    status: 'UPCOMING',
    href: '#/lists',
  },
  {
    id: 'i-106',
    dueDate: '2027-03-31',
    title: 'Annual return under the Factories Act',
    meta: 'Belur · Priya Rane',
    status: 'UPCOMING',
    href: '#/lists',
  },
  {
    id: 'i-107',
    dueDate: '2027-04-07',
    title: 'Professional tax payment',
    meta: 'Head office · Kavya Iyer',
    status: 'UPCOMING',
    href: '#/lists',
  },
];

const mine: TaskItem[] = [
  {
    id: 'i-104',
    title: 'Fire safety drill record',
    meta: 'Factories Act',
    dueDate: '2027-03-08',
    status: 'OVERDUE',
    days: 2,
    href: '#/lists',
  },
  {
    id: 'i-108',
    title: 'Half-yearly return of contract labour',
    meta: 'CLRA',
    dueDate: '2027-03-11',
    status: 'SENT_BACK',
    href: '#/lists',
  },
  {
    id: 'i-101',
    title: 'Monthly PF challan',
    meta: 'EPF Act',
    dueDate: '2027-03-10',
    status: 'SUBMITTED',
    href: '#/lists',
  },
  {
    id: 'i-103',
    title: 'TDS return (24Q)',
    meta: 'Income Tax Act',
    dueDate: '2027-03-15',
    status: 'UPCOMING',
    href: '#/lists',
  },
  {
    id: 'i-105',
    title: 'Consent to operate renewal',
    meta: 'Water Act',
    dueDate: '2027-03-20',
    status: 'UPCOMING',
    href: '#/lists',
  },
  {
    id: 'i-106',
    title: 'Annual return under the Factories Act',
    meta: 'Factories Act',
    dueDate: '2027-03-31',
    status: 'UPCOMING',
    href: '#/lists',
  },
];

const approvals: TaskItem[] = [
  {
    id: 'i-201',
    title: 'Monthly PF challan',
    meta: 'EPF Act · Priya Rane',
    dueDate: '2027-03-10',
    status: 'SUBMITTED',
    href: '#/lists',
  },
  {
    id: 'i-202',
    title: 'ESI contribution',
    meta: 'ESI Act · Arun Mehta',
    dueDate: '2027-03-12',
    status: 'SUBMITTED',
    href: '#/lists',
  },
  {
    id: 'i-203',
    title: 'Register of wages (Form B)',
    meta: 'Wage Code · Ravi Kumar',
    dueDate: '2027-03-14',
    status: 'SUBMITTED',
    href: '#/lists',
  },
  {
    id: 'i-204',
    title: 'Labour welfare fund',
    meta: 'LWF Act · Kavya Iyer',
    dueDate: '2027-03-15',
    status: 'SUBMITTED',
    href: '#/lists',
  },
];

function ApprovalsDemo() {
  const [items, setItems] = useState(approvals);
  const [processing, setProcessing] = useState<string[]>([]);
  const [sendBack, setSendBack] = useState<TaskItem | null>(null);

  const remove = (id: string) => setItems((xs) => xs.filter((x) => x.id !== id));

  const approve = (id: string) => {
    const item = items.find((x) => x.id === id);
    if (!item) return;
    setProcessing((p) => [...p, id]);
    window.setTimeout(() => {
      setProcessing((p) => p.filter((x) => x !== id));
      remove(id);
      toast({
        tone: 'success',
        message: `Approved ${item.title}.`,
        action: { label: 'Undo', onClick: () => setItems((xs) => [item, ...xs]) },
      });
    }, 400);
  };

  return (
    <>
      <TaskList
        label="Approvals"
        mode="approver"
        items={items}
        processingIds={processing}
        onApprove={approve}
        onSendBack={(id) => setSendBack(items.find((x) => x.id === id) ?? null)}
      />
      <ConfirmDialog
        open={!!sendBack}
        onOpenChange={(o) => !o && setSendBack(null)}
        title={`Send back ${sendBack?.title ?? ''}?`}
        body="The owner sees your reason and resubmits."
        confirmLabel="Send back"
        tone="danger"
        reason={{ label: 'Reason', required: true, minLength: 10 }}
        onConfirm={() => {
          if (sendBack) {
            remove(sendBack.id);
            toast({ tone: 'info', message: `Sent back ${sendBack.title}.` });
          }
        }}
      />
    </>
  );
}

export function ListsPage() {
  return (
    <Page
      title="DeadlineList and TaskList"
      intro="Upcoming due dates for the overview, the person's open items, and the approvals inbox (J/K to move, A to approve, S to send back, ? for help)."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <DeadlineList items={deadlines} viewAllHref="#/lists" />
        <DeadlineList title="This month" items={deadlines} groupBy="week" today={today} max={10} />
      </div>
      <Section title="My open items" className="block">
        <TaskList label="My open items" items={mine} max={5} viewAllHref="#/lists" />
      </Section>
      <Section title="Approvals inbox" className="block">
        <ApprovalsDemo />
      </Section>
      <Section title="Loading and empty" className="grid gap-4 md:grid-cols-3">
        <DeadlineList title="Loading" items={[]} loading headingLevel={3} />
        <DeadlineList title="Nothing due" items={[]} headingLevel={3} />
        <TaskList label="Approvals" mode="approver" items={[]} />
      </Section>
      <Toaster />
    </Page>
  );
}

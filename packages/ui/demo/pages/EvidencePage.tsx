import { useEffect, useRef, useState } from 'react';

import { FileDrop, Timeline, toast, Toaster, type TimelineEvent, type UploadItem } from '../../src';
import { Page, Section } from '../Page';

const seeded: UploadItem[] = [
  {
    id: 'f-1',
    name: 'PF_challan_February_2027_Riverbend_plant_signed.pdf',
    size: 1_480_000,
    state: 'ready',
    addedBy: 'Priya Rane',
    addedOn: '2027-03-09',
  },
  { id: 'f-2', name: 'ECR_upload_receipt.jpg', size: 2_300_000, state: 'blocked' },
  { id: 'f-3', name: 'Bank_statement_March.pdf', size: 840_000, state: 'failed' },
];

/** Simulated transport: queued, uploading in steps, scanning, then ready. Names containing "virus" are blocked. */
function useFakeUploads(initial: UploadItem[]) {
  const [files, setFiles] = useState(initial);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const patch = (id: string, change: Partial<UploadItem>) =>
    setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...change } : f)));

  const run = (item: UploadItem) => {
    const steps = [0.25, 0.5, 0.75, 1];
    steps.forEach((s, i) =>
      timers.current.push(
        window.setTimeout(
          () => patch(item.id, { state: 'uploading', loaded: Math.round(item.size * s) }),
          300 * (i + 1),
        ),
      ),
    );
    timers.current.push(window.setTimeout(() => patch(item.id, { state: 'scanning' }), 1500));
    timers.current.push(
      window.setTimeout(
        () =>
          patch(
            item.id,
            /virus/i.test(item.name)
              ? { state: 'blocked' }
              : { state: 'ready', addedBy: 'You', addedOn: '2027-03-10' },
          ),
        2300,
      ),
    );
  };

  return {
    files,
    onAdd: (added: File[]) => {
      const items = added.map((f, i) => ({
        id: `n-${Date.now()}-${i}`,
        name: f.name,
        size: f.size,
        state: 'queued' as const,
      }));
      setFiles((fs) => [...fs, ...items]);
      items.forEach(run);
    },
    onRemove: (id: string) => setFiles((fs) => fs.filter((f) => f.id !== id)),
    onRetry: (id: string) => {
      const item = files.find((f) => f.id === id);
      if (item) {
        patch(id, { state: 'queued', loaded: 0 });
        run(item);
      }
    },
    onCancel: (id: string) => setFiles((fs) => fs.filter((f) => f.id !== id)),
  };
}

const allEvents: TimelineEvent[] = [
  {
    id: 'a1',
    at: '2027-03-01T03:30:00Z',
    actor: 'system',
    kind: 'created',
    summary: 'created this instance',
  },
  {
    id: 'a2',
    at: '2027-03-01T05:10:00Z',
    actor: { name: 'Kavya Iyer' },
    kind: 'assigned',
    summary: 'assigned it to Priya Rane',
  },
  {
    id: 'a3',
    at: '2027-03-04T09:45:00Z',
    actor: { name: 'Kavya Iyer' },
    kind: 'due_date_changed',
    summary: 'changed the due date',
    detail: { field: 'Due date', from: '15 Mar 2027', to: '10 Mar 2027' },
  },
  {
    id: 'a4',
    at: '2027-03-08T10:20:00Z',
    actor: { name: 'Priya Rane' },
    kind: 'evidence_added',
    summary: 'added PF challan (PDF)',
  },
  {
    id: 'a5',
    at: '2027-03-08T10:22:00Z',
    actor: { name: 'Priya Rane' },
    kind: 'submitted',
    summary: 'submitted for approval',
  },
  {
    id: 'a6',
    at: '2027-03-09T04:05:00Z',
    actor: { name: 'Arun Mehta' },
    kind: 'sent_back',
    summary: 'sent back',
    detail: { reason: 'The challan is for January. Attach the February one.' },
  },
  {
    id: 'a7',
    at: '2027-03-09T07:40:00Z',
    actor: { name: 'Priya Rane' },
    kind: 'evidence_removed',
    summary: 'removed a file',
  },
  {
    id: 'a8',
    at: '2027-03-09T07:42:00Z',
    actor: { name: 'Priya Rane' },
    kind: 'submitted',
    summary: 'submitted for approval',
  },
  {
    id: 'a9',
    at: '2027-03-10T05:15:00Z',
    actor: { name: 'Arun Mehta' },
    kind: 'approved',
    summary: 'approved',
  },
];

function TimelineDemo() {
  const [count, setCount] = useState(5);
  const [loading, setLoading] = useState(false);
  const shown = allEvents.slice(allEvents.length - count);
  return (
    <Timeline
      events={shown}
      timeZone="Asia/Kolkata"
      now="2027-03-10T08:00:00Z"
      hasMore={count < allEvents.length}
      loading={loading}
      onLoadMore={() => {
        setLoading(true);
        window.setTimeout(() => {
          setCount(allEvents.length);
          setLoading(false);
        }, 300);
      }}
    />
  );
}

export function EvidencePage() {
  const many = useFakeUploads(seeded);
  const single = useFakeUploads([]);
  return (
    <Page
      title="FileDrop and Timeline"
      intro="Evidence upload with client-side checks and a virus scan, and the read-only audit history of an instance. Drop or paste files; a name containing “virus” is blocked by the fake scanner."
    >
      <Section title="Evidence (several files)" className="block">
        <FileDrop
          label="Evidence"
          accept={['pdf', 'jpg', 'png', 'xlsx', 'docx']}
          {...many}
          onOpen={() => toast({ tone: 'info', message: 'Opening the file' })}
        />
      </Section>
      <Section title="Single file" className="block">
        <FileDrop
          label="Signed register"
          accept={['pdf']}
          maxBytes={5 * 1024 * 1024}
          multiple={false}
          {...single}
        />
      </Section>
      <Section title="Locked" className="block">
        <FileDrop
          label="Locked evidence"
          accept={['pdf']}
          files={[seeded[0]!]}
          disabled={{ reason: 'This instance is approved, so its evidence is locked.' }}
          onAdd={() => {}}
          onRemove={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
        />
      </Section>
      <Section title="Activity" className="block">
        <TimelineDemo />
      </Section>
      <Section title="Loading and empty" className="grid gap-4 md:grid-cols-2">
        <Timeline events={[]} timeZone="Asia/Kolkata" loading />
        <Timeline events={[]} timeZone="Asia/Kolkata" />
      </Section>
      <Toaster />
    </Page>
  );
}

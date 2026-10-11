import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { FileDrop, middleTruncate, type UploadItem } from './FileDrop';
import { formatTimestamp, Timeline, type TimelineEvent } from './Timeline';

const file = (name: string, size = 1024, type = 'application/pdf') => {
  const f = new File(['x'], name, { type, lastModified: 1 });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

const handlers = () => ({ onAdd: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn() });

describe('middleTruncate', () => {
  it('keeps the start, the end and the extension', () => {
    expect(middleTruncate('short.pdf')).toBe('short.pdf');
    const t = middleTruncate('Challan_April_2022_Belur_plant_final_signed.pdf');
    expect(t).toHaveLength(28);
    expect(t.startsWith('Challan_')).toBe(true);
    expect(t.endsWith('signed.pdf')).toBe(true);
    expect(middleTruncate('a'.repeat(40))).toHaveLength(28);
  });
});

describe('FileDrop', () => {
  it('accepts chosen files and rejects wrong types and oversized ones with a message', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const h = handlers();
    const { container } = render(
      <FileDrop
        label="Evidence"
        accept={['pdf', 'jpg']}
        maxBytes={2 * 1024 * 1024}
        files={[]}
        {...h}
      />,
    );
    const zone = screen.getByRole('group', { name: 'Evidence' });
    expect(zone.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('PDF, JPG up to 2 MB each')).toBeTruthy();
    expect(within(zone).getByRole('button', { name: 'choose files' })).toBeTruthy();

    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('.pdf,.jpg');
    await user.upload(input, [
      file('challan.pdf'),
      file('notes.exe'),
      file('big.jpg', 5 * 1024 * 1024),
      file('README'),
    ]);
    expect(h.onAdd).toHaveBeenCalledWith([expect.objectContaining({ name: 'challan.pdf' })]);
    const list = screen.getByRole('list', { name: 'Evidence list' });
    expect(within(list).getByText('Wrong type (EXE). Use PDF, JPG.')).toBeTruthy();
    expect(within(list).getByText('Too large (5 MB). Max 2 MB.')).toBeTruthy();
    expect(within(list).getByText('Wrong type (no extension). Use PDF, JPG.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('notes.exe: Wrong type');

    await user.click(screen.getByRole('button', { name: 'Dismiss notes.exe' }));
    expect(within(list).queryByText(/EXE/)).toBeNull();
    await expectNoAxeViolations();
  });

  it('takes dropped and pasted files and shows the drop state', () => {
    const h = handlers();
    render(<FileDrop accept={['pdf']} files={[]} {...h} />);
    const zone = screen.getByRole('group', { name: 'Files' });
    fireEvent.dragEnter(zone);
    expect(screen.getByText('Drop to upload')).toBeTruthy();
    fireEvent.dragOver(zone);
    fireEvent.dragLeave(zone, { relatedTarget: null });
    expect(screen.queryByText('Drop to upload')).toBeNull();
    fireEvent.dragEnter(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [file('a.pdf')] } });
    expect(h.onAdd).toHaveBeenLastCalledWith([expect.objectContaining({ name: 'a.pdf' })]);
    expect(screen.queryByText('Drop to upload')).toBeNull();

    fireEvent.paste(zone, { clipboardData: { files: [file('b.pdf')] } });
    expect(h.onAdd).toHaveBeenLastCalledWith([expect.objectContaining({ name: 'b.pdf' })]);
    fireEvent.paste(zone, { clipboardData: { files: [] } });
    expect(h.onAdd).toHaveBeenCalledTimes(2);
  });

  it('shows each upload state with the right actions and announces changes', async () => {
    const user = userEvent.setup();
    const h = handlers();
    const items: UploadItem[] = [
      { id: '1', name: 'queued.pdf', size: 2048, state: 'queued' },
      { id: '2', name: 'up.pdf', size: 4 * 1024 * 1024, loaded: 1024 * 1024, state: 'uploading' },
      { id: '3', name: 'scan.pdf', size: 2048, state: 'scanning' },
      { id: '4', name: 'virus.pdf', size: 2048, state: 'blocked' },
      { id: '5', name: 'oops.pdf', size: 2048, state: 'failed' },
    ];
    const { rerender } = render(<FileDrop accept={['pdf']} files={items} {...h} />);
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(screen.getByText('25% · 1 of 4 MB')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Uploading up.pdf' })).toBeTruthy();
    expect(screen.getByText('Checking for viruses')).toBeTruthy();
    expect(screen.getByText('Blocked: failed virus check')).toBeTruthy();
    expect(screen.getByText('Upload failed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /scan\.pdf/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Cancel queued.pdf' }));
    expect(h.onCancel).toHaveBeenCalledWith('1');
    await user.click(screen.getByRole('button', { name: 'Retry oops.pdf' }));
    expect(h.onRetry).toHaveBeenCalledWith('5');
    await user.click(screen.getByRole('button', { name: 'Remove oops.pdf' }));
    expect(h.onRemove).toHaveBeenCalledWith('5');
    await user.click(screen.getByRole('button', { name: 'Remove virus.pdf' }));
    expect(h.onRemove).toHaveBeenCalledWith('4');

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    rerender(
      <FileDrop
        accept={['pdf']}
        files={items.map((i) => (i.id === '2' ? { ...i, state: 'scanning' } : i))}
        {...h}
      />,
    );
    expect(status.textContent).toBe('up.pdf uploaded, checking for viruses');
    rerender(
      <FileDrop
        accept={['pdf']}
        files={items.map((i) => (i.id === '2' ? { ...i, state: 'ready' } : i))}
        {...h}
      />,
    );
    expect(status.textContent).toBe('up.pdf ready');
    rerender(
      <FileDrop
        accept={['pdf']}
        files={items.map((i) => (i.id === '2' ? { ...i, state: 'blocked' } : i))}
        {...h}
      />,
    );
    expect(status.textContent).toBe('up.pdf blocked: failed virus check');
    rerender(
      <FileDrop
        accept={['pdf']}
        files={items.map((i) => (i.id === '2' ? { ...i, state: 'failed' } : i))}
        {...h}
      />,
    );
    expect(status.textContent).toBe('up.pdf upload failed');
    await expectNoAxeViolations();
  });

  it('confirms before removing a ready file and opens it through the app', async () => {
    const user = userEvent.setup();
    const h = handlers();
    const onOpen = vi.fn();
    const ready: UploadItem = {
      id: 'r',
      name: 'challan.pdf',
      size: 1536 * 1024,
      state: 'ready',
      addedBy: 'Priya Rane',
      addedOn: '2027-03-31',
    };
    render(<FileDrop accept={['pdf']} files={[ready]} onOpen={onOpen} {...h} />);
    expect(screen.getByText('1.5 MB · Added by Priya Rane · 31 Mar 2027')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'challan.pdf' }));
    expect(onOpen).toHaveBeenCalledWith('r');

    const remove = screen.getByRole('button', { name: 'Remove challan.pdf' });
    await user.click(remove);
    const dialog = screen.getByRole('alertdialog', { name: 'Remove challan.pdf?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(h.onRemove).not.toHaveBeenCalled();
    await user.click(remove);
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    expect(h.onRemove).toHaveBeenCalledWith('r');
  });

  it('puts focus on the next row after a confirmed removal, then on "choose files" (audit #4)', async () => {
    const user = userEvent.setup();
    function Two() {
      const [files, setFiles] = useState<UploadItem[]>([
        { id: 'a', name: 'a.pdf', size: 10, state: 'ready' },
        { id: 'b', name: 'b.pdf', size: 10, state: 'ready' },
      ]);
      return (
        <FileDrop
          accept={['pdf']}
          files={files}
          onAdd={() => {}}
          onRemove={(id) => setFiles((fs) => fs.filter((f) => f.id !== id))}
          onRetry={() => {}}
          onCancel={() => {}}
        />
      );
    }
    render(<Two />);
    await user.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove b.pdf' }));
    await user.keyboard('{Enter}');
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'choose files' }));
  });

  it('matches types without regard to case and keeps each rejection separate (audit #8e)', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const h = handlers();
    const { container } = render(<FileDrop accept={['PDF', '.jpg']} files={[]} {...h} />);
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('.pdf,.jpg');
    expect(screen.getByText('PDF, JPG up to 25 MB each')).toBeTruthy();
    await user.upload(input, [file('SCAN.PDF'), file('photo.JPG'), file('a.exe'), file('a.exe')]);
    expect(h.onAdd).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'SCAN.PDF' }),
      expect.objectContaining({ name: 'photo.JPG' }),
    ]);
    expect(screen.getAllByRole('button', { name: 'Dismiss a.exe' })).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'Dismiss a.exe' })[0]!);
    expect(screen.getAllByRole('button', { name: 'Dismiss a.exe' })).toHaveLength(1);
  });

  it('replaces the file in single-file mode and keeps only the first of several', async () => {
    const user = userEvent.setup();
    function Single() {
      const [files, setFiles] = useState<UploadItem[]>([]);
      return (
        <FileDrop
          accept={['pdf']}
          multiple={false}
          files={files}
          onAdd={(fs) =>
            setFiles(
              fs.map((f, i) => ({ id: String(i), name: f.name, size: f.size, state: 'ready' })),
            )
          }
          onRemove={() => setFiles([])}
          onRetry={() => {}}
          onCancel={() => {}}
        />
      );
    }
    const { container } = render(<Single />);
    expect(screen.getByText('PDF up to 25 MB')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'choose a file' })).toBeTruthy();
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.multiple).toBe(false);
    fireEvent.change(input, { target: { files: [file('one.pdf'), file('two.pdf')] } });
    expect(screen.getByText('one.pdf')).toBeTruthy();
    expect(screen.queryByText('two.pdf')).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
    const click = vi.spyOn(input, 'click');
    await user.click(screen.getByRole('button', { name: 'Replace file' }));
    expect(click).toHaveBeenCalled();

    // A rejection in single mode replaces the earlier rejection.
    fireEvent.change(input, { target: { files: [file('a.doc')] } });
    fireEvent.change(input, { target: { files: [file('b.doc')] } });
    expect(screen.queryByText('a.doc')).toBeNull();
    expect(screen.getByText('b.doc')).toBeTruthy();
  });

  it('shows the reason and no actions when disabled', () => {
    const h = handlers();
    render(
      <FileDrop
        accept={['pdf']}
        files={[{ id: 'r', name: 'challan.pdf', size: 10, state: 'ready' }]}
        disabled={{ reason: 'Approved instances are locked.' }}
        {...h}
      />,
    );
    expect(screen.getByText('Approved instances are locked.')).toBeTruthy();
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.paste(screen.getByText('Approved instances are locked.'), {
      clipboardData: { files: [file('a.pdf')] },
    });
    expect(h.onAdd).not.toHaveBeenCalled();
  });
});

const events: TimelineEvent[] = [
  {
    id: 'e1',
    at: '2027-03-29T04:30:00Z',
    actor: 'system',
    kind: 'created',
    summary: 'created this instance',
  },
  {
    id: 'e2',
    at: '2027-03-30T08:35:00Z',
    actor: { name: 'Priya Rane' },
    kind: 'due_date_changed',
    summary: 'changed the due date',
    detail: { field: 'Due date', from: '15 Apr 2027', to: '30 Apr 2027' },
  },
  {
    id: 'e3',
    at: '2027-03-31T05:00:00Z',
    actor: { name: 'Arun Mehta' },
    kind: 'sent_back',
    summary: 'sent back',
    detail: { reason: 'Challan is for February, not March.' },
  },
  {
    id: 'e4',
    at: '2027-03-31T06:00:00Z',
    actor: { name: 'Priya Rane' },
    kind: 'reassigned',
    summary: 'reassigned',
    detail: { field: 'Owner' },
  },
];

describe('Timeline', () => {
  it('formats timestamps in the client time zone', () => {
    expect(formatTimestamp('2027-03-31T08:35:00Z', 'Asia/Kolkata')).toBe('31 Mar 2027, 14:05 IST');
    expect(formatTimestamp('2027-03-31T23:30:00Z', 'Asia/Kolkata')).toBe('1 Apr 2027, 05:00 IST');
    expect(formatTimestamp('2027-01-15T08:35:00Z', 'Europe/London')).toBe('15 Jan 2027, 08:35 GMT');
  });

  it('shows events newest first with day separators, tones, reasons and changes', async () => {
    const { container } = render(
      <Timeline events={events} timeZone="Asia/Kolkata" now="2027-03-31T10:00:00Z" />,
    );
    const list = screen.getByRole('list', { name: 'Activity' });
    const items = [...list.querySelectorAll('li[data-event]')];
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Priya Rane reassigned'),
      expect.stringContaining('Arun Mehta sent back'),
      expect.stringContaining('Priya Rane changed the due date'),
      expect.stringContaining('PlanetPulse Compliance created this instance'),
    ]);
    const separators = [...list.querySelectorAll('li[aria-hidden]')].map((s) => s.textContent);
    expect(separators).toEqual(['Today', 'Yesterday', '29 Mar 2027']);
    expect(screen.getByText('Challan is for February, not March.').tagName).toBe('BLOCKQUOTE');
    expect(items[2]!.textContent).toContain('Due date: 15 Apr 2027 to 30 Apr 2027');
    expect(items[0]!.textContent).toContain('Owner: none to none');
    const time = items[1]!.querySelector('time')!;
    expect(time.getAttribute('dateTime')).toBe('2027-03-31T05:00:00Z');
    expect(time.textContent).toBe('31 Mar 2027, 10:30 IST');
    expect(time.getAttribute('title')).toBe('5 hours ago');
    expect(items[0]!.querySelector('time')!.getAttribute('title')).toBe('4 hours ago');
    expect(items[3]!.querySelector('time')!.getAttribute('title')).toBe('2 days ago');
    const dots = [...container.querySelectorAll('li[data-event] > span[aria-hidden]')].map((d) =>
      ['bg-ok', 'bg-warn', 'bg-crit', 'bg-line-strong'].find((c) => d.className.includes(c)),
    );
    expect(dots).toEqual(['bg-line-strong', 'bg-crit', 'bg-warn', 'bg-line-strong']);
    await expectNoAxeViolations();
  });

  it('orders oldest first and names system events', () => {
    render(
      <Timeline
        events={[
          {
            id: 'x',
            at: '2027-03-31T09:59:30Z',
            actor: 'system',
            kind: 'overdue',
            summary: 'marked overdue',
          },
          ...events,
        ]}
        timeZone="Asia/Kolkata"
        order="oldest"
        systemName="PlanetPulse"
        now="2027-03-31T10:00:00Z"
      />,
    );
    const items = [...screen.getByRole('list').querySelectorAll('li[data-event]')];
    expect(items[0]!.textContent).toContain('PlanetPulse created this instance');
    expect(items.at(-1)!.textContent).toContain('PlanetPulse marked overdue');
    expect(items.at(-1)!.querySelector('time')!.getAttribute('title')).toBe('30 seconds ago');
    expect(items.at(-2)!.querySelector('time')!.getAttribute('title')).toMatch(
      /minutes ago|hours ago/,
    );
  });

  it('loads earlier activity and focuses the first new item', async () => {
    const user = userEvent.setup();
    function Paged() {
      const [shown, setShown] = useState(events.slice(2));
      return (
        <Timeline
          events={shown}
          timeZone="Asia/Kolkata"
          now="2027-03-31T10:00:00Z"
          hasMore={shown.length < events.length}
          onLoadMore={() => setShown(events)}
        />
      );
    }
    render(<Paged />);
    expect(screen.getAllByText(/^(Arun|Priya)/)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Show earlier activity' }));
    expect(screen.queryByRole('button', { name: 'Show earlier activity' })).toBeNull();
    expect(document.activeElement?.textContent).toContain('Priya Rane changed the due date');
  });

  it('focuses the first item when loading earlier activity oldest first', async () => {
    const user = userEvent.setup();
    function Paged() {
      const [shown, setShown] = useState(events.slice(2));
      return (
        <Timeline
          events={shown}
          order="oldest"
          timeZone="Asia/Kolkata"
          now="2027-03-31T10:00:00Z"
          hasMore={shown.length < events.length}
          onLoadMore={() => act(() => setShown(events))}
        />
      );
    }
    render(<Paged />);
    await user.click(screen.getByRole('button', { name: 'Show earlier activity' }));
    expect(document.activeElement?.textContent).toContain(
      'PlanetPulse Compliance created this instance',
    );
  });

  it('shows loading and empty states', () => {
    const { rerender } = render(<Timeline events={[]} timeZone="Asia/Kolkata" loading />);
    expect(screen.getByText('Loading activity')).toBeTruthy();
    rerender(<Timeline events={[]} timeZone="Asia/Kolkata" />);
    expect(screen.getByText('No activity yet.')).toBeTruthy();
    rerender(<Timeline events={events} timeZone="Asia/Kolkata" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });
});

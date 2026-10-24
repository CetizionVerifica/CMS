import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startArchiveAction = vi.fn();
const exportProgressAction = vi.fn();
vi.mock('./actions', () => ({
  startArchiveAction: (...args: unknown[]) => startArchiveAction(...args),
}));
vi.mock('../c/[clientId]/reports/actions', () => ({
  exportProgressAction: (...args: unknown[]) => exportProgressAction(...args),
}));

const { ClientArchives, ARCHIVE_POLL_TRIES } = await import('./ClientArchives');

const CLIENTS = [
  { id: '00000000-0000-5000-8000-0000000000c1', name: 'Kestrel Metals Group' },
  { id: '00000000-0000-5000-8000-0000000000c2', name: 'Osprey Textiles Group' },
];
const assign = vi.fn();

beforeEach(() => {
  startArchiveAction.mockReset().mockResolvedValue({ ok: true, id: 'job-1' });
  exportProgressAction.mockReset();
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});

describe('download your data', () => {
  it('starts one client’s archive, waits for it, then downloads it', async () => {
    exportProgressAction
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'ready', url: 'https://files.test/archive.zip' });
    render(<ClientArchives clients={CLIENTS} closing={false} pollMs={0} />);
    expect(screen.getByRole('heading', { name: 'Download your data' })).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Download archive of Osprey Textiles Group' }),
    );
    expect(startArchiveAction).toHaveBeenCalledWith(CLIENTS[1]!.id);
    expect(
      await screen.findByText('The archive of Osprey Textiles Group is downloading.'),
    ).toBeTruthy();
    expect(exportProgressAction).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledWith('https://files.test/archive.zip');
  });

  it('says why when the API refuses, the build fails or it takes too long', async () => {
    startArchiveAction.mockResolvedValueOnce({
      ok: false,
      message: 'Only account admins can download a client’s data.',
    });
    render(<ClientArchives clients={CLIENTS} closing={false} pollMs={0} />);
    const button = screen.getByRole('button', {
      name: 'Download archive of Kestrel Metals Group',
    });
    await userEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only account admins can download a client’s data.',
    );

    exportProgressAction.mockResolvedValueOnce({
      status: 'failed',
      message: 'The download couldn’t be prepared. Try again.',
    });
    await userEvent.click(button);
    expect(await screen.findByText('The download couldn’t be prepared. Try again.')).toBeTruthy();

    exportProgressAction.mockResolvedValue({ status: 'pending' });
    await userEvent.click(button);
    expect(
      await screen.findByText('The archive is taking too long. Try again in a few minutes.'),
    ).toBeTruthy();
    expect(exportProgressAction).toHaveBeenCalledTimes(1 + ARCHIVE_POLL_TRIES);
    expect(assign).not.toHaveBeenCalled();
  });

  it('tells a closing account to download before deletion, and an empty one there is nothing', () => {
    const { unmount } = render(<ClientArchives clients={CLIENTS} closing pollMs={0} />);
    expect(screen.getByText(/This account is closing\. Download each client’s data/)).toBeTruthy();
    unmount();
    render(<ClientArchives clients={[]} closing={false} />);
    expect(screen.getByText('This account has no clients yet.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

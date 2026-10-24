import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { EvidenceView } from '@canopy/contracts';
import { Toaster } from '@canopy/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UploadCalls } from '../_lib/evidence-upload';

const upload = vi.hoisted(() => ({ uploadEvidence: vi.fn() }));
vi.mock('../_lib/evidence-upload', async (original) => ({
  ...(await original<typeof import('../_lib/evidence-upload')>()),
  uploadEvidence: upload.uploadEvidence,
}));

const { UploadAborted } = await import('../_lib/evidence-upload');
const { useEvidenceUploads } = await import('./useEvidenceUploads');

const calls = { start: vi.fn(), confirm: vi.fn() } as UploadCalls;
const evidence = { id: 'e1', fileName: 'challan.pdf', scanStatus: 'PENDING' } as EvidenceView;
const file = (name = 'challan.pdf') => new File(['%PDF-1.4'], name, { type: 'application/pdf' });

type Pending = {
  signal: AbortSignal;
  progress: (loaded: number) => void;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

/** Each upload waits until the test settles it, so states in between can be seen. */
function holdUploads(): Pending[] {
  const pending: Pending[] = [];
  upload.uploadEvidence.mockImplementation(
    (_file: File, _calls: UploadCalls, progress: (n: number) => void, signal: AbortSignal) =>
      new Promise((resolve, reject) => pending.push({ signal, progress, resolve, reject })),
  );
  return pending;
}

function setup(instanceId: string | null = 'i1', withCalls: UploadCalls | null = calls) {
  const onConfirmed = vi.fn();
  render(<Toaster />);
  const hook = renderHook(({ id }) => useEvidenceUploads(id, withCalls, onConfirmed), {
    initialProps: { id: instanceId },
  });
  return { ...hook, onConfirmed };
}
const states = (result: { current: ReturnType<typeof useEvidenceUploads> }) =>
  result.current.items.map(
    (i) => `${i.name}:${i.state}${i.loaded === undefined ? '' : `:${i.loaded}`}`,
  );

beforeEach(() => {
  upload.uploadEvidence.mockReset();
});

describe('useEvidenceUploads', () => {
  it('shows progress, then hands a confirmed file on and drops it from the list', async () => {
    const pending = holdUploads();
    const { result, onConfirmed } = setup();
    act(() => result.current.add([file()]));
    expect(states(result)).toEqual(['challan.pdf:uploading:0']);
    act(() => pending[0]!.progress(4));
    expect(states(result)).toEqual(['challan.pdf:uploading:4']);
    await act(async () => pending[0]!.resolve({ ok: true, data: evidence }));
    expect(result.current.items).toEqual([]);
    expect(onConfirmed).toHaveBeenCalledWith(evidence);
  });

  it('marks a refused upload failed with the API’s words, and retries it', async () => {
    const pending = holdUploads();
    const { result, onConfirmed } = setup();
    act(() => result.current.add([file()]));
    await act(async () =>
      pending[0]!.resolve({
        ok: false,
        code: 'VALIDATION',
        message: 'That file type isn’t allowed.',
      }),
    );
    expect(states(result)).toEqual(['challan.pdf:failed:0']);
    expect(await screen.findByText('That file type isn’t allowed.')).toBeTruthy();
    expect(onConfirmed).not.toHaveBeenCalled();

    const id = result.current.items[0]!.id;
    act(() => result.current.retry(id));
    expect(states(result)).toEqual(['challan.pdf:uploading:0']);
    await act(async () => pending[1]!.resolve({ ok: true, data: evidence }));
    expect(result.current.items).toEqual([]);
    expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it('marks a file failed when storage or the network fails', async () => {
    const pending = holdUploads();
    const { result } = setup();
    act(() => result.current.add([file()]));
    await act(async () => pending[0]!.reject(new Error('Storage answered 503')));
    expect(states(result)).toEqual(['challan.pdf:failed:0']);
    expect(await screen.findByText('The file didn’t upload. Try again.')).toBeTruthy();
  });

  it('cancels an upload in flight: aborts it, drops it, and ignores what it answers later', async () => {
    const pending = holdUploads();
    const { result, onConfirmed } = setup();
    // Toasts live in one store for the whole file, so count rather than expect none.
    const failures = () => screen.queryAllByText('The file didn’t upload. Try again.').length;
    const before = failures();
    act(() => result.current.add([file('a.pdf'), file('b.pdf')]));
    const [a, b] = result.current.items;
    act(() => result.current.cancel(a!.id));
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(pending[1]!.signal.aborted).toBe(false);
    expect(states(result)).toEqual(['b.pdf:uploading:0']);

    // An upload that still finishes after the cancel is not added, and one that throws UploadAborted isn't a failure.
    await act(async () => pending[0]!.resolve({ ok: true, data: evidence }));
    expect(onConfirmed).not.toHaveBeenCalled();
    act(() => result.current.remove(b!.id));
    await act(async () => pending[1]!.reject(new UploadAborted()));
    expect(result.current.items).toEqual([]);
    expect(failures()).toBe(before);
  });

  it('stops everything in flight when the instance changes or the drawer closes', async () => {
    const pending = holdUploads();
    const { result, rerender, onConfirmed } = setup();
    act(() => result.current.add([file()]));
    rerender({ id: 'i2' });
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(result.current.items).toEqual([]);
    await act(async () => pending[0]!.resolve({ ok: true, data: evidence }));
    expect(onConfirmed).not.toHaveBeenCalled();

    act(() => result.current.add([file()]));
    rerender({ id: null });
    await waitFor(() => expect(pending[1]!.signal.aborted).toBe(true));
    expect(result.current.items).toEqual([]);
  });

  it('only lists files while there is nowhere to send them', () => {
    const { result } = setup('i1', null);
    act(() => result.current.add([file()]));
    expect(states(result)).toEqual(['challan.pdf:queued']);
    expect(upload.uploadEvidence).not.toHaveBeenCalled();
  });
});

import type { EvidenceView } from '@canopy/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { putFile, UploadAborted, uploadEvidence, type UploadCalls } from './evidence-upload';

const evidence = { id: 'e1', scanStatus: 'PENDING' } as EvidenceView;
const file = () => new File(['%PDF-1.4 demo'], 'challan.pdf', { type: 'application/pdf' });

function calls(url = 'https://files.mock.invalid/uploads/u1'): UploadCalls & {
  start: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => ({
      ok: true as const,
      data: {
        uploadId: 'u1',
        url,
        headers: { 'content-type': 'application/pdf' },
        expiresAt: '2024-11-15T05:35:00Z',
      },
    })),
    confirm: vi.fn(async () => ({ ok: true as const, data: evidence })),
  };
}

/** A stand-in XMLHttpRequest that answers `status` once sent, or waits to be aborted. */
function fakeXhr(status: number | 'error' | 'hang') {
  const sent: { method?: string; url?: string; headers: Record<string, string>; body?: unknown } = {
    headers: {},
  };
  class Xhr {
    status = 0;
    upload: { onprogress?: (e: { loaded: number }) => void } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    open(method: string, url: string) {
      sent.method = method;
      sent.url = url;
    }
    setRequestHeader(name: string, value: string) {
      sent.headers[name] = value;
    }
    send(body: unknown) {
      sent.body = body;
      if (status === 'hang') return;
      queueMicrotask(() => {
        this.upload.onprogress?.({ loaded: 5 });
        if (status === 'error') return this.onerror?.();
        this.status = status;
        this.onload?.();
      });
    }
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr);
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe('uploadEvidence', () => {
  it('asks for a ticket, skips the PUT to a host that can’t resolve, and confirms with the SHA-256', async () => {
    const c = calls();
    const put = vi.fn();
    const progress = vi.fn();
    const result = await uploadEvidence(
      file(),
      c,
      progress,
      new AbortController().signal,
      put as never,
    );
    expect(result).toEqual({ ok: true, data: evidence });
    expect(put).not.toHaveBeenCalled();
    expect(c.start).toHaveBeenCalledWith({
      fileName: 'challan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 13,
    });
    expect(c.confirm).toHaveBeenCalledWith({
      uploadId: 'u1',
      fileName: 'challan.pdf',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(progress).toHaveBeenLastCalledWith(13);
  });

  it('PUTs to real storage, and a type the browser doesn’t know goes as octet-stream', async () => {
    const c = calls('https://storage.example.com/u1?sig=x');
    const put = vi.fn(async () => undefined);
    const odd = new File(['x'], 'scan.heic');
    await uploadEvidence(odd, c, vi.fn(), new AbortController().signal, put);
    expect(put).toHaveBeenCalledOnce();
    expect(c.start).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'application/octet-stream' }),
    );
  });

  it('answers the API’s refusal, or a failed PUT, without confirming', async () => {
    const refused = calls();
    refused.start.mockResolvedValue({
      ok: false,
      code: 'INVALID_TRANSITION',
      message: 'moved on',
    });
    expect(
      await uploadEvidence(file(), refused, vi.fn(), new AbortController().signal),
    ).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect(refused.confirm).not.toHaveBeenCalled();

    const c = calls('https://storage.example.com/u1');
    const put = vi.fn(async () => {
      throw new Error('503');
    });
    expect(await uploadEvidence(file(), c, vi.fn(), new AbortController().signal, put)).toEqual({
      ok: false,
      code: 'UNKNOWN',
      message: 'The file didn’t upload. Try again.',
    });
    expect(c.confirm).not.toHaveBeenCalled();
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadEvidence(file(), calls(), vi.fn(), controller.signal)).rejects.toThrow(
      UploadAborted,
    );

    const c = calls('https://storage.example.com/u1');
    const later = new AbortController();
    const put = vi.fn(async () => {
      later.abort();
      throw new UploadAborted();
    });
    await expect(uploadEvidence(file(), c, vi.fn(), later.signal, put)).rejects.toThrow(
      UploadAborted,
    );
    expect(c.confirm).not.toHaveBeenCalled();
  });
});

describe('putFile', () => {
  const ticket = { url: 'https://storage.example.com/u1', headers: { 'content-type': 'x/y' } };

  it('sends the bytes with the ticket’s headers and reports progress', async () => {
    const sent = fakeXhr(200);
    const progress = vi.fn();
    const blob = file();
    await putFile(ticket, blob, progress, new AbortController().signal);
    expect(sent).toMatchObject({ method: 'PUT', url: ticket.url, headers: ticket.headers });
    expect(sent.body).toBe(blob);
    expect(progress).toHaveBeenCalledWith(5);
  });

  it('rejects a non-2xx answer, a network error and a cancel', async () => {
    fakeXhr(403);
    await expect(putFile(ticket, file(), vi.fn(), new AbortController().signal)).rejects.toThrow(
      'Storage answered 403',
    );
    fakeXhr('error');
    await expect(putFile(ticket, file(), vi.fn(), new AbortController().signal)).rejects.toThrow(
      'didn’t reach storage',
    );
    fakeXhr('hang');
    const controller = new AbortController();
    const pending = putFile(ticket, file(), vi.fn(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(UploadAborted);
    await expect(putFile(ticket, file(), vi.fn(), controller.signal)).rejects.toThrow(
      UploadAborted,
    );
  });
});

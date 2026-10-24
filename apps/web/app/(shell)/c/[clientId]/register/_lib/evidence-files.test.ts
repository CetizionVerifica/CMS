import { afterEach, describe, expect, it, vi } from 'vitest';

import { fileSize, openEvidence } from './evidence-files';

afterEach(() => vi.restoreAllMocks());

/** A stand-in for the tab window.open returns. */
function fakeTab() {
  const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(tab as never);
  return tab;
}

describe('fileSize', () => {
  it('reads in KB under a megabyte and never says 0 KB', () => {
    expect(fileSize(10)).toBe('1 KB');
    expect(fileSize(340 * 1024)).toBe('340 KB');
    expect(fileSize(2 * 1024 * 1024)).toBe('2 MB');
    expect(fileSize(2.46 * 1024 * 1024)).toBe('2.5 MB');
  });
});

describe('openEvidence', () => {
  it('opens a tab without an opener, then points it at the signed URL', async () => {
    const tab = fakeTab();
    const link = vi.fn(async () => ({ ok: true as const, data: 'https://files.example/x?sig=1' }));
    expect(await openEvidence('e1', link)).toBeNull();
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe('https://files.example/x?sig=1');
    expect(link).toHaveBeenCalledWith('e1');
  });

  it('closes the tab and says why when the file can’t open', async () => {
    const tab = fakeTab();
    expect(
      await openEvidence('e1', async () => ({
        ok: false as const,
        code: 'FORBIDDEN' as const,
        message: 'Not yours.',
      })),
    ).toBe('Not yours.');
    expect(tab.close).toHaveBeenCalled();
    expect(
      await openEvidence('e1', async () => {
        throw new Error('network');
      }),
    ).toBe('The file didn’t open. Try again.');
  });

  it('asks for pop-ups when the browser blocked the tab', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(await openEvidence('e1', async () => ({ ok: true as const, data: 'https://x' }))).toBe(
      'Allow pop-ups for this site to open evidence.',
    );
  });
});

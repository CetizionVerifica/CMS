import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EvidenceView } from '@canopy/contracts';
import { Toaster } from '@canopy/ui';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLIENT_ID } from '../../register/_test/rows';
import type { VaultPage } from '../_lib/vault-api';

const PATH = `/c/${CLIENT_ID}/evidence`;

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => `/c/00000000-0000-5000-8000-000000000101/evidence`,
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({ loadMoreEvidence: vi.fn() }));
vi.mock('../actions', () => actions);
const drawer = vi.hoisted(() => ({ evidenceDownload: vi.fn() }));
vi.mock('../../register/instance-actions', () => drawer);

const { EvidenceVault, filterValue, withFilters } = await import('./EvidenceVault');
type Props = Parameters<typeof EvidenceVault>[0];

const UPLOADER = '00000000-0000-5000-8000-000000000201';
const UNIT = '00000000-0000-5000-8000-000000000401';
const T = '2024-11-15T05:30:00Z';

function file(i: number, overrides: Partial<EvidenceView> = {}): EvidenceView {
  return {
    id: `00000000-0000-5000-8000-0000000e${String(i).padStart(4, '0')}`,
    firmId: '00000000-0000-5000-8000-0000000000f1',
    createdAt: T,
    updatedAt: T,
    archivedAt: null,
    instanceId: `00000000-0000-5000-8000-0000001${String(i).padStart(5, '0')}`,
    clientId: CLIENT_ID,
    fileName: `file-${i}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 2 * 1024 * 1024,
    sha256: 'a'.repeat(64),
    scanStatus: 'CLEAN',
    uploadedById: UPLOADER,
    ...overrides,
  };
}
const page = (rows: EvidenceView[], nextCursor: string | null = null): VaultPage => ({
  rows,
  nextCursor,
  total: rows.length,
});

function view(props: Partial<Props> = {}) {
  return (
    <>
      <EvidenceVault
        clientId={CLIENT_ID}
        query=""
        page={page([file(1), file(2, { scanStatus: 'PENDING', uploadedById: 'stranger' })])}
        lookups={{
          names: { [UPLOADER]: 'Owner 01' },
          units: [{ value: UNIT, label: 'Plant 01' }],
        }}
        timeZone="Asia/Kolkata"
        {...props}
      />
      <Toaster />
    </>
  );
}
function renderVault(props: Partial<Props> = {}) {
  const utils = render(view(props));
  return { ...utils, rerender: (next: Partial<Props>) => utils.rerender(view(next)) };
}
const table = () => screen.getByRole('table', { name: 'Evidence' });

beforeEach(() => {
  nav.replace.mockReset();
  actions.loadMoreEvidence.mockReset();
  drawer.evidenceDownload.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('filters in the URL', () => {
  it('reads and writes the vault’s filters, keeping the search text', () => {
    const search = new URLSearchParams(
      `q=challan&scanStatus=CLEAN,PENDING&unitId=${UNIT}&uploadedFrom=2024-11-01`,
    );
    const value = filterValue(search);
    expect(value).toEqual({
      scanStatus: ['CLEAN', 'PENDING'],
      unitId: [UNIT],
      uploaded: { from: '2024-11-01' },
    });
    expect(withFilters(search, value).toString()).toBe(search.toString().replace(',', '%2C'));
    expect(withFilters(search, { scanStatus: [], uploaded: { to: '2024-11-30' } }).toString()).toBe(
      'q=challan&uploadedTo=2024-11-30',
    );
    expect(filterValue(new URLSearchParams(''))).toEqual({});
  });
});

describe('EvidenceVault', () => {
  it('lists each file with its size, upload time, uploader and virus check, linked to its instance', () => {
    renderVault();
    const rows = within(table()).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const first = rows[1]!;
    expect(first.textContent).toContain('file-1.pdf');
    expect(first.textContent).toContain('2 MB');
    expect(first.textContent).toContain('15 Nov 2024');
    expect(first.textContent).toContain('Owner 01');
    expect(first.textContent).toContain('Ready');
    expect(within(first).getByRole('link', { name: 'file-1.pdf' }).getAttribute('href')).toBe(
      `/c/${CLIENT_ID}/register/${file(1).instanceId}`,
    );
    // A file still being checked can't be opened, and an unknown uploader is "Someone".
    const second = rows[2]!;
    expect(second.textContent).toContain('Checking for viruses');
    expect(second.textContent).toContain('Someone');
    expect(within(second).queryByRole('button', { name: /^Open/ })).toBeNull();
    expect(screen.getByText('2 files match')).toBeTruthy();
  });

  it('opens a clean file through a signed URL fetched on the click, and says when it can’t', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    drawer.evidenceDownload.mockResolvedValueOnce({ ok: true, data: 'https://files.example/1' });
    renderVault();
    await userEvent.click(screen.getByRole('button', { name: 'Open file-1.pdf' }));
    expect(drawer.evidenceDownload).toHaveBeenCalledWith(file(1).id);
    expect(tab.location.href).toBe('https://files.example/1');

    drawer.evidenceDownload.mockResolvedValueOnce({
      ok: false,
      code: 'FORBIDDEN',
      message: 'You can’t open this file.',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Open file-1.pdf' }));
    expect(await screen.findByText('You can’t open this file.')).toBeTruthy();
  });

  it('writes a search and a filter to the URL', async () => {
    renderVault({ query: 'scanStatus=CLEAN' });
    await userEvent.type(screen.getByRole('searchbox'), 'challan');
    await vi.waitFor(() =>
      expect(nav.replace).toHaveBeenLastCalledWith(`${PATH}?scanStatus=CLEAN&q=challan`, {
        scroll: false,
      }),
    );
  });

  it('loads more on request, without repeating files, and says when that fails', async () => {
    actions.loadMoreEvidence.mockResolvedValueOnce({ rows: [file(2), file(3)], nextCursor: 'c2' });
    renderVault({ page: page([file(1), file(2)], 'c1'), query: 'q=file' });
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(actions.loadMoreEvidence).toHaveBeenCalledWith(CLIENT_ID, 'q=file', 'c1');
    expect(await screen.findByRole('link', { name: 'file-3.pdf' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'file-2.pdf' })).toHaveLength(1);

    actions.loadMoreEvidence.mockRejectedValueOnce(new Error('network'));
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('More files didn’t load. Try again.')).toBeTruthy();
  });

  it('takes a new first page from the server when the filters change', () => {
    const { rerender } = renderVault();
    rerender({ page: page([file(9)]), query: 'q=9' });
    expect(within(table()).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'file-9.pdf' })).toBeTruthy();
  });

  it('says when nothing matches, with a way back, and when there is no evidence yet', async () => {
    const { rerender } = renderVault({ page: page([]), query: 'q=zzz' });
    expect(screen.getByText('No files match these filters')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(nav.replace).toHaveBeenLastCalledWith(PATH, { scroll: false });
    rerender({ page: page([]), query: '' });
    expect(screen.getByText('No evidence yet')).toBeTruthy();
  });
});

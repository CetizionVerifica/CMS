import { describe, expect, it } from 'vitest';
import { ApiError } from '../../auth/index.js';
import {
  COUNT_PAGE_SIZE,
  countMatching,
  encodeCursor,
  MAX_READS_PER_PAGE,
  mergedPage,
  type Position,
  type ReadRegister,
  type RegisterSource,
} from './paging.js';

/** Sources backed by in-memory lists that page like the register repository: by (dueDate, id) after the cursor. */
function sourcesOf(lists: Record<string, Position[]>): {
  sources: RegisterSource[];
  read: ReadRegister<Position>;
  reads: () => number;
} {
  let count = 0;
  const read: ReadRegister<Position> = async (source, page) => {
    count += 1;
    const all = [...(lists[source.clientId] ?? [])].sort((a, b) =>
      a.dueDate === b.dueDate ? a.id.localeCompare(b.id) : a.dueDate.localeCompare(b.dueDate),
    );
    const from = page.cursor === undefined ? 0 : all.findIndex((r) => after(r, page.cursor!));
    const rest = from === -1 ? [] : all.slice(from);
    const items = rest.slice(0, page.limit);
    const last = items.at(-1);
    return { items, nextCursor: rest.length > page.limit && last ? encodeCursor(last) : null };
  };
  return {
    sources: Object.keys(lists).map((clientId) => ({ clientId, filter: {} })),
    read,
    reads: () => count,
  };
}

function after(row: Position, cursor: string): boolean {
  const at = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Position;
  return row.dueDate > at.dueDate || (row.dueDate === at.dueDate && row.id > at.id);
}

const row = (dueDate: string, id: string): Position => ({ dueDate, id });
const ids = (rows: Position[]) => rows.map((r) => r.id);

async function everything(
  lists: Record<string, Position[]>,
  limit: number,
  keep: (r: Position) => Position | null = (r) => r,
): Promise<string[]> {
  const { sources, read } = sourcesOf(lists);
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await mergedPage(sources, read, { limit, cursor, keep });
    out.push(...ids(page.items));
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
}

describe('mergedPage', () => {
  const lists = {
    a: [row('2023-01-05', 'a1'), row('2023-01-07', 'a2'), row('2023-02-01', 'a3')],
    b: [row('2023-01-06', 'b1'), row('2023-01-07', 'b0'), row('2023-03-01', 'b2')],
  };

  it('merges sources in register order, ties broken by id, across pages', async () => {
    expect(await everything(lists, 2)).toEqual(['a1', 'b1', 'a2', 'b0', 'a3', 'b2']);
    expect(await everything(lists, 200)).toEqual(['a1', 'b1', 'a2', 'b0', 'a3', 'b2']);
  });

  it('keeps reading until the page is full when rows are left out', async () => {
    const onlyB = (r: Position) => (r.id.startsWith('b') ? r : null);
    const { sources, read } = sourcesOf(lists);
    const page = await mergedPage(sources, read, { limit: 2, cursor: undefined, keep: onlyB });
    expect(ids(page.items)).toEqual(['b1', 'b0']);
    expect(await everything(lists, 2, onlyB)).toEqual(['b1', 'b0', 'b2']);
  });

  it(`returns a short page with a cursor after ${MAX_READS_PER_PAGE} rounds`, async () => {
    const many = {
      a: Array.from({ length: 30 }, (_, i) => row('2023-01-01', `a${String(i).padStart(2, '0')}`)),
    };
    const { sources, read, reads } = sourcesOf(many);
    const page = await mergedPage(sources, read, { limit: 1, cursor: undefined, keep: () => null });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBe(encodeCursor(row('2023-01-01', 'a09')));
    expect(reads()).toBe(MAX_READS_PER_PAGE);
  });

  it('is empty with no sources, and refuses more than 50', async () => {
    const read: ReadRegister<Position> = async () => ({ items: [], nextCursor: null });
    expect(await mergedPage([], read, { limit: 5, cursor: undefined, keep: (r) => r })).toEqual({
      items: [],
      nextCursor: null,
    });
    const sources = Array.from({ length: 51 }, (_, i) => ({ clientId: `c${i}`, filter: {} }));
    await expect(
      mergedPage(sources, read, { limit: 5, cursor: undefined, keep: (r) => r }),
    ).rejects.toMatchObject({ code: 'VALIDATION' } satisfies Partial<ApiError>);
  });
});

describe('countMatching', () => {
  it('counts the rows keep accepts in every source, past one page', async () => {
    const many = Array.from({ length: COUNT_PAGE_SIZE + 5 }, (_, i) =>
      row('2023-01-05', `a${String(i).padStart(4, '0')}`),
    );
    const { sources, read, reads } = sourcesOf({ a: many, b: [row('2023-01-01', 'b1')] });
    expect(await countMatching(sources, read, () => true)).toBe(COUNT_PAGE_SIZE + 6);
    expect(reads()).toBe(3);
    expect(await countMatching(sources, read, (r) => r.id.endsWith('1'))).toBe(
      many.filter((r) => r.id.endsWith('1')).length + 1,
    );
  });

  it('is 0 with no sources or no rows', async () => {
    const { read } = sourcesOf({});
    expect(await countMatching([], read, () => true)).toBe(0);
    const empty = sourcesOf({ a: [] });
    expect(await countMatching(empty.sources, empty.read, () => true)).toBe(0);
  });
});
